import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/ps';
const BAR_WIDTH  = 60; // px

// ── helpers ───────────────────────────────────────────────────────────────────

function readFile(path) {
    try {
        const [ok, raw] = Gio.File.new_for_path(path).load_contents(null);
        if (ok) return new TextDecoder().decode(raw).trim();
    } catch (_) {}
    return null;
}

function fmtGB(bytes) {
    return (bytes / 1_073_741_824).toFixed(1) + ' GB';
}

// ── auto-detect total system RAM from /proc/meminfo ───────────────────────────

function detectSysRamGB() {
    const raw = readFile('/proc/meminfo');
    if (!raw) return 0;
    const m = raw.match(/^MemTotal:\s+(\d+)/m);
    if (!m) return 0;
    return parseInt(m[1], 10) * 1024 / 1_073_741_824; // kB → GB
}

// ── auto-detect GPU VRAM (tries nvidia-smi, then DRM sysfs) ──────────────────

function detectVramGB() {
    // 1. nvidia-smi
    try {
        const [ok, out] = GLib.spawn_command_line_sync(
            'nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits'
        );
        if (ok && out) {
            const mb = parseInt(new TextDecoder().decode(out).trim(), 10);
            if (!isNaN(mb) && mb > 0) return mb / 1024;
        }
    } catch (_) {}

    // 2. DRM sysfs (works for AMD, Intel, some NVIDIA with open driver)
    try {
        const drmBase = '/sys/class/drm';
        const dir = Gio.File.new_for_path(drmBase);
        const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null) {
            const name = info.get_name();
            // Only card entries, not render nodes
            if (!name.startsWith('card') || name.includes('-')) continue;
            const vramPath = `${drmBase}/${name}/device/mem_info_vram_total`;
            const raw = readFile(vramPath);
            if (raw) {
                const bytes = parseInt(raw, 10);
                if (!isNaN(bytes) && bytes > 0) return bytes / 1_073_741_824;
            }
        }
    } catch (_) {}

    return 0; // unknown
}

// ── system RAM snapshot ───────────────────────────────────────────────────────

function getSysRam() {
    const raw = readFile('/proc/meminfo');
    if (!raw) return null;
    const kB = (key) => {
        const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
        return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    const total = kB('MemTotal');
    const avail = kB('MemAvailable');
    return { total, used: total - avail, free: avail };
}

// ── Soup 3 async fetch ────────────────────────────────────────────────────────

function fetchOllamaPs(cb) {
    try {
        const session = new Soup.Session({ timeout: 3 });
        const msg     = Soup.Message.new('GET', OLLAMA_URL);
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (_sess, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.get_status() !== Soup.Status.OK) { cb(null); return; }
                cb(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            } catch (_) { cb(null); }
        });
    } catch (_) { cb(null); }
}

// ── mini progress bar ─────────────────────────────────────────────────────────

function makeBar(fillColor) {
    const outer = new St.Bin({
        width: BAR_WIDTH,
        height: 6,
        y_align: Clutter.ActorAlign.CENTER,
        style: 'background-color: #333333; border-radius: 3px; overflow: hidden;',
    });
    const fill = new St.Widget({
        width: 0,
        height: 6,
        style: `background-color: ${fillColor}; border-radius: 3px;`,
    });
    outer.set_child(fill);
    return {
        widget: outer,
        setRatio(r) {
            fill.set_width(Math.round(BAR_WIDTH * Math.max(0, Math.min(1, r))));
        },
    };
}

// ── extension ─────────────────────────────────────────────────────────────────

export default class OllamaRamExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Auto-detect hardware limits (used when pref is 0)
        this._autoVramGB = detectVramGB();
        this._autoRamGB  = detectSysRamGB();

        this._indicator = new PanelMenu.Button(0.0, 'Ollama RAM', false);
        this._indicator.hide();

        // panel bar ──────────────────────────────────────────────────────────
        const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });

        box.add_child(new St.Label({
            text: '🤖',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin-right: 5px;',
        }));

        // VRAM bar (blue)
        this._vramBar   = makeBar('#7eb8f7');
        this._vramLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 10px; margin-left: 3px; margin-right: 8px;',
        });
        box.add_child(this._vramBar.widget);
        box.add_child(this._vramLabel);

        // RAM bar (green)
        this._ramBar   = makeBar('#88cc88');
        this._ramLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 10px; margin-left: 3px;',
        });
        box.add_child(this._ramBar.widget);
        box.add_child(this._ramLabel);

        this._indicator.add_child(box);

        // popup menu ─────────────────────────────────────────────────────────
        const row = (key) => {
            const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            const r    = new St.BoxLayout({ x_expand: true });
            const k    = new St.Label({ text: key, style: 'min-width: 110px; color: #aaaaaa;' });
            const v    = new St.Label({ text: '…', x_expand: true, style: 'padding-left: 6px;' });
            r.add_child(k); r.add_child(v);
            item.add_child(r);
            return { item, v };
        };

        ({ item: this._miModel,    v: this._vModel    } = row('Model'));
        ({ item: this._miVram,     v: this._vVram     } = row('VRAM'));
        ({ item: this._miCtx,      v: this._vCtx      } = row('Context'));
        ({ item: this._miExpires,  v: this._vExpires  } = row('Unloads'));
        for (const i of [this._miModel, this._miVram, this._miCtx, this._miExpires])
            this._indicator.menu.addMenuItem(i);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        ({ item: this._miRamTotal, v: this._vRamTotal } = row('RAM total'));
        ({ item: this._miRamUsed,  v: this._vRamUsed  } = row('RAM used'));
        ({ item: this._miRamFree,  v: this._vRamFree  } = row('RAM free'));
        for (const i of [this._miRamTotal, this._miRamUsed, this._miRamFree])
            this._indicator.menu.addMenuItem(i);

        Main.panel.addToStatusArea(this.uuid, this._indicator, 2, 'right');

        this._update();
        this._startTimer();

        // restart timer if interval setting changes
        this._settingsChangedId = this._settings.connect('changed::update-interval', () => {
            this._stopTimer();
            this._startTimer();
        });
    }

    _effectiveVramGB() {
        const pref = this._settings.get_double('max-vram-gb');
        return pref > 0 ? pref : (this._autoVramGB > 0 ? this._autoVramGB : 8);
    }

    _effectiveRamGB() {
        const pref = this._settings.get_double('max-ram-gb');
        return pref > 0 ? pref : (this._autoRamGB > 0 ? this._autoRamGB : 16);
    }

    _startTimer() {
        const interval = this._settings.get_int('update-interval');
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
    }

    _update() {
        // system RAM (sync, cheap)
        const ram = getSysRam();
        if (ram) {
            const maxRamBytes = this._effectiveRamGB() * 1_073_741_824;
            this._ramBar.setRatio(ram.used / maxRamBytes);
            this._ramLabel.set_text(fmtGB(ram.used));
            this._vRamTotal.set_text(fmtGB(ram.total));
            this._vRamUsed.set_text(fmtGB(ram.used));
            this._vRamFree.set_text(fmtGB(ram.free));
        }

        // Ollama (async)
        fetchOllamaPs((data) => {
            const models = data?.models ?? [];
            if (models.length === 0) {
                this._indicator.hide();
                return;
            }

            const m         = models[0];
            const vramBytes = m.size_vram ?? 0;
            const name      = m.name ?? '?';
            const ctx       = m.context_length ?? null;
            const expires   = m.expires_at ?? null;

            const maxVramBytes = this._effectiveVramGB() * 1_073_741_824;
            this._vramBar.setRatio(vramBytes / maxVramBytes);
            this._vramLabel.set_text(fmtGB(vramBytes));

            this._vModel.set_text(name);
            this._vVram.set_text(fmtGB(vramBytes));
            this._vCtx.set_text(ctx ? ctx.toLocaleString() + ' tok' : 'n/a');

            if (expires) {
                const mins = Math.round((new Date(expires) - new Date()) / 60_000);
                this._vExpires.set_text(mins > 0 ? `in ${mins} min` : 'soon');
            } else {
                this._vExpires.set_text('n/a');
            }

            this._indicator.show();
        });
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._stopTimer();
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        this._settings = null;
    }
}
