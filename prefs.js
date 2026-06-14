import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class OllamaRamPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Ollama RAM',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        // ── Bar Scale ─────────────────────────────────────────────────────────
        const scaleGroup = new Adw.PreferencesGroup({
            title: 'Bar Scale',
            description: 'Set to 0 to auto-detect from hardware.',
        });
        page.add(scaleGroup);

        const vramRow = new Adw.SpinRow({
            title: 'Max VRAM (GB)',
            subtitle: '0 = auto-detect from nvidia-smi / DRM',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 256, step_increment: 1, page_increment: 4,
            }),
            digits: 0,
        });
        settings.bind('max-vram-gb', vramRow, 'value', 0 /* GET|SET */);
        scaleGroup.add(vramRow);

        const ramRow = new Adw.SpinRow({
            title: 'Max RAM (GB)',
            subtitle: '0 = auto-detect from /proc/meminfo',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 4096, step_increment: 1, page_increment: 8,
            }),
            digits: 0,
        });
        settings.bind('max-ram-gb', ramRow, 'value', 0);
        scaleGroup.add(ramRow);

        // ── Polling ───────────────────────────────────────────────────────────
        const pollGroup = new Adw.PreferencesGroup({ title: 'Polling' });
        page.add(pollGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Update interval (seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 60, step_increment: 1, page_increment: 5,
            }),
            digits: 0,
        });
        settings.bind('update-interval', intervalRow, 'value', 0);
        pollGroup.add(intervalRow);
    }
}
