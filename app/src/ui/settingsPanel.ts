// Settings panel: screen reader, speech, tones, speech rate, speech test.

import type { SettingsStore } from '../settings';
import type { Feedback } from './feedback';

function checkbox(id: string, label: string, hint: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  const hintEl = document.createElement('span');
  hintEl.className = 'hint-inline';
  hintEl.id = `${id}-hint`;
  hintEl.textContent = hint;
  input.setAttribute('aria-describedby', hintEl.id);
  const lab = document.createElement('label');
  lab.className = 'checkbox';
  lab.append(input, label);
  const row = document.createElement('div');
  row.className = 'field';
  row.append(lab, hintEl);
  return { row, input };
}

export class SettingsPanel {
  constructor(root: HTMLElement, settings: SettingsStore, feedback: Feedback) {
    const sr = checkbox(
      'set-screen-reader',
      'Używam czytnika ekranu (np. NVDA)',
      'Komunikaty czyta czytnik ekranu; własna mowa aplikacji jest wtedy wyłączona.',
    );
    const speech = checkbox('set-speech', 'Mowa aplikacji (synteza pl-PL)', 'Czyta komunikaty na głos, gdy nie używasz czytnika ekranu.');
    const tones = checkbox('set-tones', 'Sygnały dźwiękowe', 'Krótki dźwięk: punkty gotowe, dobrze, źle, lekcja odblokowana.');

    const rateLabel = document.createElement('label');
    rateLabel.htmlFor = 'set-rate';
    rateLabel.textContent = 'Tempo mowy';
    const rate = document.createElement('input');
    rate.type = 'range';
    rate.id = 'set-rate';
    rate.min = '0.5';
    rate.max = '2';
    rate.step = '0.1';
    const rateRow = document.createElement('div');
    rateRow.className = 'field';
    rateRow.append(rateLabel, rate);

    const test = document.createElement('button');
    test.type = 'button';
    test.textContent = 'Sprawdź dźwięk';
    const row = document.createElement('div');
    row.className = 'button-row';
    row.append(test);

    const status = document.createElement('p');
    status.className = 'hint';

    const sync = () => {
      const s = settings.get();
      sr.input.checked = s.screenReader;
      speech.input.checked = s.speech;
      speech.input.disabled = s.screenReader;
      tones.input.checked = s.tones;
      rate.value = String(s.rate);
      rate.disabled = s.screenReader || !s.speech;
      rate.setAttribute('aria-valuetext', `${s.rate.toFixed(1)} razy`);
      status.textContent =
        s.screenReader || !s.speech
          ? ''
          : feedback.speechAvailable
            ? ''
            : 'Nie znaleziono polskiego głosu w przeglądarce — komunikaty są tylko na ekranie i dla czytnika ekranu.';
    };

    sr.input.addEventListener('change', () => settings.set({ screenReader: sr.input.checked }));
    speech.input.addEventListener('change', () => settings.set({ speech: speech.input.checked }));
    tones.input.addEventListener('change', () => settings.set({ tones: tones.input.checked }));
    rate.addEventListener('change', () => settings.set({ rate: Number(rate.value) }));
    test.addEventListener('click', () => {
      feedback.tone('ready');
      feedback.say('To jest test dźwięku. Tak brzmią komunikaty aplikacji.');
    });
    settings.onChange(sync);

    root.append(sr.row, speech.row, tones.row, rateRow, row, status);
    sync();
  }
}
