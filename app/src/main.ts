// App shell: wires DeviceLink to the connection panel, preview, log and modes.

import './styles.css';
import { DeviceLink } from './device/DeviceLink';
import { modes, plannedModes } from './modes/registry';
import type { Mode, ModeContext } from './modes/types';
import { Announcer } from './ui/announcer';
import { ConnectionPanel } from './ui/connection';
import { ProtocolLog } from './ui/log';
import { DevicePreview } from './ui/preview';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

const link = new DeviceLink();
const announcer = new Announcer(byId('announcer'));

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

const ctx: ModeContext = { link, announce: (m) => announcer.announce(m) };
const modeRoot = byId('mode-root');
const modeNav = byId('mode-nav');
let unmount: (() => void) | null = null;
const modeButtons = new Map<string, HTMLButtonElement>();

function activate(mode: Mode): void {
  unmount?.();
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
