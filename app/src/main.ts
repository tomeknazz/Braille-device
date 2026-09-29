// App shell: wires DeviceLink to the connection panel, preview, log and modes.

import './styles.css';
import { WebSpeechSpeaker } from './audio/speech';
import { WebAudioTones } from './audio/tones';
import { DeviceLink } from './device/DeviceLink';
import { modes, plannedModes } from './modes/registry';
import type { KeyHandlers, Mode, ModeContext } from './modes/types';
import { SettingsStore } from './settings';
import { Announcer } from './ui/announcer';
import { ConnectionPanel } from './ui/connection';
import { Feedback } from './ui/feedback';
import { ProtocolLog } from './ui/log';
import { DevicePreview } from './ui/preview';
import { SettingsPanel } from './ui/settingsPanel';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const link = new DeviceLink();
const announcer = new Announcer(byId('announcer'));
const settings = new SettingsStore();
const feedback = new Feedback(announcer, new WebSpeechSpeaker(), new WebAudioTones(), settings);
new SettingsPanel(byId('settings-root'), settings, feedback);

new ConnectionPanel(link, {
  usb: byId<HTMLButtonElement>('btn-connect-usb'),
  mock: byId<HTMLButtonElement>('btn-connect-mock'),
  disconnect: byId<HTMLButtonElement>('btn-disconnect'),
  status: byId('conn-status'),
  unsupported: byId('serial-unsupported'),
});

const preview = new DevicePreview(byId('preview'));
link.on('confirmed', (masks) => preview.render(masks, link.busy));
link.on('busy', (busy) => preview.render(link.confirmed, busy));

new ProtocolLog(byId('log-root'), link);

// --- Modes ---------------------------------------------------------------

let keys: KeyHandlers | null = null;
const ctx: ModeContext = {
  link,
  announce: (m) => feedback.say(m),
  say: (m) => feedback.say(m),
  tone: (k) => feedback.tone(k),
  setKeys: (h) => {
    keys = h;
  },
  now: () => performance.now(),
};
const modeRoot = byId('mode-root');
const modeNav = byId('mode-nav');
let unmount: (() => void) | null = null;
const modeButtons = new Map<string, HTMLButtonElement>();

function activate(mode: Mode): void {
  unmount?.();
  keys = null;
  modeRoot.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = mode.title;
  const body = document.createElement('div');
  modeRoot.append(heading, body);
  unmount = mode.mount(body, ctx);
  for (const [id, btn] of modeButtons) btn.setAttribute('aria-pressed', String(id === mode.id));
}

if (modes.length > 1) {
  const row = document.createElement('div');
  row.className = 'button-row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Tryb ćwiczenia');
  for (const mode of modes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = mode.title;
    btn.addEventListener('click', () => activate(mode));
    modeButtons.set(mode.id, btn);
    row.append(btn);
  }
  modeNav.append(row);
}
if (plannedModes.length) {
  const p = document.createElement('p');
  p.className = 'mode-list-planned';
  p.textContent = `W przygotowaniu: ${plannedModes.map((m) => `${m.title} (${m.description})`).join('; ')}.`;
  modeNav.append(p);
}
const first = modes[0];
if (first) activate(first);

// --- Global shortcuts ------------------------------------------------------
// F1 repeat, F2 hint, F3 blink (handled by the active mode); Esc returns to
// the mode menu. Browser defaults (help, find) are suppressed only when the
// mode actually handles the key.

const F_KEYS: Record<string, keyof KeyHandlers> = { F1: 'repeat', F2: 'hint', F3: 'blink' };

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const action = F_KEYS[e.key];
  if (action) {
    const fn = keys?.[action];
    if (fn) {
      e.preventDefault();
      fn();
    }
    return;
  }
  if (e.key === 'Escape') {
    const current = [...modeButtons.values()].find((b) => b.getAttribute('aria-pressed') === 'true');
    if (current && document.activeElement !== current) {
      e.preventDefault();
      current.focus();
    }
  }
});
