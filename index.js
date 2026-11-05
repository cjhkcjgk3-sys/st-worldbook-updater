import { WorldbookService } from './host.js';
import { UpdaterWindow } from './ui.js';

const PANEL_ID = 'st-worldbook-updater-launcher';
let windowView = null, listeners = null, eventBus = null, readyEvent = null;

function mount() {
    if (!listeners || document.getElementById(PANEL_ID)) return;
    const parent = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!parent) return;
    const panel = document.createElement('div'); panel.id = PANEL_ID; panel.className = 'stwu-launcher';
    const heading = document.createElement('strong'); heading.textContent = '世界书更新器';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button'; button.textContent = '打开世界书更新器';
    const note = document.createElement('p'); note.textContent = '双窗口对照，批量更新或融合世界书条目。';
    button.addEventListener('click', () => {
        try {
            if (!windowView) windowView = new UpdaterWindow(new WorldbookService());
            void windowView.open().catch(error => globalThis.alert(error.message || '窗口无法打开。'));
        } catch (error) { globalThis.alert(error.message || '世界书更新器无法打开。'); }
    }, { signal: listeners.signal });
    panel.append(heading, note, button); parent.append(panel);
}

export function onActivate() {
    if (listeners) return;
    listeners = new AbortController();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true, signal: listeners.signal });
    else mount();
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (ctx?.eventSource && ctx.eventTypes?.APP_READY) {
        eventBus = ctx.eventSource; readyEvent = ctx.eventTypes.APP_READY;
        eventBus.on(readyEvent, mount);
    }
}

export function onEnable() { onActivate(); }

export function onDisable() {
    listeners?.abort(); listeners = null;
    if (eventBus && readyEvent) eventBus.removeListener(readyEvent, mount);
    eventBus = readyEvent = null;
    windowView?.destroy(); windowView = null;
    document.getElementById(PANEL_ID)?.remove();
}

export function onDelete() { onDisable(); }
