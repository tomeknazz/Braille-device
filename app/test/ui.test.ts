// @vitest-environment happy-dom
// Smoke test of the real shell: index.html + main.ts driven through the
// simulator, as a user would (click, type, Enter, next page).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// vitest runs with the app/ directory as root.
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function captionTexts(): string[] {
  return [...document.querySelectorAll('.preview-caption li')].map((li) => li.textContent ?? '');
}

describe('app shell (simulator)', () => {
  beforeAll(async () => {
    vi.useFakeTimers();
    const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
    document.body.innerHTML = body;
    await import('../src/main');
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('explains that Web Serial is unsupported and keeps the simulator available', () => {
    expect($('serial-unsupported').hidden).toBe(false);
    expect(($('btn-connect-usb') as HTMLButtonElement).disabled).toBe(true);
    expect(($('btn-connect-mock') as HTMLButtonElement).disabled).toBe(false);
    expect($('conn-status').getAttribute('aria-live')).toBe('polite');
  });

  it('connects to the simulator through the hello handshake', async () => {
    $('btn-connect-mock').click();
    await vi.advanceTimersByTimeAsync(10);
    expect($('conn-status').textContent).toMatch(/Łączenie/);
    await vi.advanceTimersByTimeAsync(2000);
    expect($('conn-status').textContent).toMatch(/Połączono/);
    expect($('btn-disconnect').hidden).toBe(false);
  });

  it('translates, pages and shows the confirmed state in the preview', async () => {
    const input = document.getElementById('text-input') as HTMLInputElement;
    expect(document.querySelector('label[for="text-input"]')?.textContent).toBe('Tekst do wyświetlenia');
    input.value = 'żaba kot';
    input.dispatchEvent(new Event('input'));
    expect($('translation-summary').textContent).toBe('8 komórek, 2 strony.');
    expect($('page-info').textContent).toBe('Strona 1 z 2');

    input.form!.requestSubmit();
    await vi.advanceTimersByTimeAsync(1500);
    expect(captionTexts()).toEqual([
      '⠯ Komórka 1: punkty 1, 2, 3, 4, 6 (ż)',
      '⠁ Komórka 2: punkt 1 (a)',
      '⠃ Komórka 3: punkty 1, 2 (b)',
      '⠁ Komórka 4: punkt 1 (a)',
      '⠀ Komórka 5: pusta',
    ]);
    expect(document.querySelectorAll('.preview-svg .dot-on').length).toBe(5 + 1 + 2 + 1);
    await vi.advanceTimersByTimeAsync(100);
    expect($('announcer').textContent).toMatch(/^Gotowe: strona 1 z 2/);

    const next = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Następna strona')!;
    next.click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(captionTexts()[0]).toBe('⠅ Komórka 1: punkty 1, 3 (k)');
    expect($('page-info').textContent).toBe('Strona 2 z 2');
    expect(next.disabled).toBe(true);
  });

  it('keeps keyboard focus in the pager when a page button becomes disabled', async () => {
    const buttons = [...document.querySelectorAll('button')];
    const prev = buttons.find((b) => b.textContent === 'Poprzednia strona')!;
    const next = buttons.find((b) => b.textContent === 'Następna strona')!;
    expect(prev.disabled).toBe(false); // on page 2 of 2
    prev.focus();
    prev.click();
    expect(prev.disabled).toBe(true);
    expect(document.activeElement).toBe(next);
    await vi.advanceTimersByTimeAsync(1500);
    next.click();
    expect(next.disabled).toBe(true);
    expect(document.activeElement).toBe(prev);
    await vi.advanceTimersByTimeAsync(1500);
  });

  it('announces translation warnings together with the result', async () => {
    const input = document.getElementById('text-input') as HTMLInputElement;
    const capital = document.getElementById('capital-sign') as HTMLInputElement;
    capital.checked = true;
    capital.dispatchEvent(new Event('change'));
    input.value = 'Ala';
    input.dispatchEvent(new Event('input'));
    input.form!.requestSubmit();
    await vi.advanceTimersByTimeAsync(1500);
    const said = $('announcer').textContent ?? '';
    expect(said).toMatch(/^Gotowe: /);
    expect(said).toContain('Uwaga: Znak wielkiej litery');
    capital.checked = false;
    capital.dispatchEvent(new Event('change'));
  });

  it('reports unknown characters', () => {
    const input = document.getElementById('text-input') as HTMLInputElement;
    input.value = 'a#b';
    input.dispatchEvent(new Event('input'));
    const notice = document.querySelector('.notice.error') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('„#”');
  });

  it('logs raw protocol lines', () => {
    const items = [...document.querySelectorAll('.log-list li')].map((li) => li.textContent ?? '');
    expect(items.some((t) => t.includes('→ hello'))).toBe(true);
    expect(items.some((t) => t.includes('← OK show'))).toBe(true);
  });

  it('disconnects', async () => {
    $('btn-disconnect').click();
    await vi.advanceTimersByTimeAsync(10);
    expect($('conn-status').textContent).toBe('Rozłączono.');
    expect(document.querySelector('.preview-state')?.textContent).toMatch(/Stan nieznany/);
  });
});
