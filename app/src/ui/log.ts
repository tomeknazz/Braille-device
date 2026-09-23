// Raw protocol log (collapsible, for debugging and calibration). Also offers
// a single-line console to send any protocol command once the link is ready.

import type { DeviceLink, LogEntry } from '../device/DeviceLink';
import { renderCommandReference } from './commandReference';

const MAX_ENTRIES = 500;

function time(t: number): string {
  const d = new Date(t);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export class ProtocolLog {
  private readonly list: HTMLOListElement;
  private entries: string[] = [];

  constructor(root: HTMLElement, link: DeviceLink) {
    this.list = document.createElement('ol');
    this.list.className = 'log-list';
    this.list.setAttribute('aria-label', 'Linie protokołu, od najstarszej');
    this.list.tabIndex = 0; // scrollable region must be keyboard-reachable

    const form = document.createElement('form');
    form.className = 'field';
    const id = 'raw-command';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = 'Komenda protokołu (zaawansowane, np. get, anim,300, dump)';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    const row = document.createElement('div');
    row.className = 'button-row';
    const send = document.createElement('button');
    send.type = 'submit';
    send.textContent = 'Wyślij';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Kopiuj dziennik';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Wyczyść dziennik';
    row.append(send, copy, clear);
    form.append(label, input, row);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const line = input.value.trim();
      if (!line) return;
      if (link.state !== 'ready') {
        this.note('(nie wysłano: urządzenie nie jest gotowe)');
        return;
      }
      void link.command(line).then((r) => {
        if (r.status !== 'ok' && r.status !== 'error') this.note(`(wynik: ${r.status})`);
      });
      input.value = '';
    });
    clear.addEventListener('click', () => {
      this.entries = [];
      this.list.replaceChildren();
    });
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.entries.join('\n')).catch(() => undefined);
    });

    const reference = renderCommandReference((example) => {
      input.value = example;
      input.focus();
    });

    root.append(reference, form, this.list);
    link.on('line', (e) => this.add(e));
  }

  private add(e: LogEntry): void {
    const arrow = e.dir === 'out' ? '→' : '←';
    const text = `${time(e.time)} ${arrow} ${e.text}`;
    const cls = e.dir === 'out' ? 'out' : e.kind === 'err' ? 'err' : e.kind === 'info' ? 'info' : 'in';
    this.push(text, cls);
  }

  private note(text: string): void {
    this.push(`${time(Date.now())}   ${text}`, 'info');
  }

  private push(text: string, cls: string): void {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    const atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    this.list.append(li);
    this.entries.push(text);
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
      this.list.firstElementChild?.remove();
    }
    if (atBottom) this.list.scrollTop = this.list.scrollHeight;
  }
}
