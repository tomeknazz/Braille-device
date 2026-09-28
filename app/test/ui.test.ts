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

  it('opens the course first, with only L0 available', () => {
    expect(document.querySelector('#mode-root h3')?.textContent).toBe('Kurs');
    const lessons = [...document.querySelectorAll('#lesson-list > li')];
    expect(lessons).toHaveLength(8);
    expect(lessons.map((li) => li.querySelector('.lesson-status')?.textContent)).toEqual([
      '(dostępna)', '(zablokowana)', '(zablokowana)', '(zablokowana)',
      '(zablokowana)', '(zablokowana)', '(zablokowana)', '(zablokowana)',
    ]);
    expect(lessons[0]!.getAttribute('aria-current')).toBe('step');
    expect($('course-current').textContent).toBe('Bieżąca lekcja: L0 — Orientacja: punkty 1–6.');
    expect(lessons[1]!.querySelector('button')!.disabled).toBe(true);
    expect(lessons[1]!.querySelector('.lesson-items')?.textContent).toContain('Znaki: a, b, c, d, e');
  });

  it('shows L0 on the device in two pages and keeps focus on the button', async () => {
    const button = () => document.querySelector<HTMLButtonElement>('button[data-lesson="L0"]')!;
    expect(button().textContent).toBe('Pokaż na urządzeniu (1/2)');
    button().focus();
    button().click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(captionTexts()).toEqual([
      '⠁ Komórka 1: punkt 1 (a)',
      '⠂ Komórka 2: punkt 2 (przecinek)',
      '⠄ Komórka 3: punkt 3 (kropka)',
      '⠈ Komórka 4: punkt 4 (bez znaczenia w tabeli)',
      '⠐ Komórka 5: punkt 5 (bez znaczenia w tabeli)',
    ]);
    expect($('announcer').textContent).toMatch(/^Gotowe: punkt jeden, punkt dwa, punkt trzy, punkt cztery, punkt pięć na kolejnych komórkach/);
    expect(button().textContent).toBe('Pokaż na urządzeniu (2/2)');
    expect(document.activeElement).toBe(button());

    button().click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(captionTexts()[0]).toMatch(/^⠠ Komórka 1: punkt 6/);
    expect(captionTexts()[1]).toBe('⠀ Komórka 2: pusta');
  });

  it('teacher option unlocks every lesson and restores the rules when switched off', async () => {
    const box = $('teacher-unlock') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('.lesson-locked')).toHaveLength(0);
    expect(document.querySelector<HTMLButtonElement>('button[data-lesson="L7"]')!.disabled).toBe(false);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('.lesson-locked')).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(100);
  });

  it('switches to the text mode', () => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('#mode-nav button')].find((b) => b.textContent === 'Wyświetl tekst')!;
    btn.click();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('text-input')).not.toBeNull();
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

  it('pages between words: "Żaba i kot 2026" keeps the number on one page', async () => {
    const input = document.getElementById('text-input') as HTMLInputElement;
    input.value = 'Żaba i kot 2026';
    input.dispatchEvent(new Event('input'));
    expect($('translation-summary').textContent).toBe('16 komórek, 3 strony.');
    input.form!.requestSubmit();
    await vi.advanceTimersByTimeAsync(1500);
    expect($('announcer').textContent).toMatch(/^Gotowe: strona 1 z 3: ż, a, b, a\./);

    const next = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Następna strona')!;
    next.click();
    await vi.advanceTimersByTimeAsync(1500);
    expect($('announcer').textContent).toMatch(/^Gotowe: strona 2 z 3: i, odstęp, k, o, t\./);
    next.click();
    await vi.advanceTimersByTimeAsync(1500);
    expect($('announcer').textContent).toMatch(/^Gotowe: strona 3 z 3: znak liczby, 2, 0, 2, sześć\./);
    expect(captionTexts()[0]).toMatch(/^⠼ Komórka 1: punkty 3, 4, 5, 6/);
    expect(captionTexts()[4]).toMatch(/^⠋ Komórka 5/);
  });

  it('announces translation warnings together with the result', async () => {
    const input = document.getElementById('text-input') as HTMLInputElement;
    input.value = 'ala.';
    input.dispatchEvent(new Event('input'));
    input.form!.requestSubmit();
    await vi.advanceTimersByTimeAsync(1500);
    const said = $('announcer').textContent ?? '';
    expect(said).toMatch(/^Gotowe: /);
    expect(said).toContain('Uwaga: Znaki interpunkcyjne');
  });

  it('adds the verified capital sign without a warning', async () => {
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
    expect(said).not.toContain('Uwaga');
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
