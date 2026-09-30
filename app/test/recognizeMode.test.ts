// @vitest-environment happy-dom
// Mode "Rozpoznawanie": driven through the real DeviceLink + MockDevice with
// fake timers and a fake ModeContext that records what is said and played.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { letterByChar, maskToDots } from '../src/braille/table';
import { DeviceLink } from '../src/device/DeviceLink';
import { MockDevice } from '../src/device/MockDevice';
import { lessonById, type LessonItem } from '../src/learn/curriculum';
import type { Attempt } from '../src/learn/progress';
import { persist, progress } from '../src/learn/session';
import {
  andList,
  createRecognizeMode,
  describeDifference,
  hintText,
  parseAnswer,
  pickItem,
  recognizeMode,
  spokenLesson,
  spokenName,
  type RecognizeOptions,
} from '../src/modes/recognize';
import type { KeyHandlers, ModeContext } from '../src/modes/types';

const L0 = lessonById('L0')!;
const L1 = lessonById('L1')!;
const L3 = lessonById('L3')!;
const mask = (ch: string) => letterByChar.get(ch)!.mask;

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}
const btn = (id: string) => $(id) as HTMLButtonElement;
const input = () => $('recognize-answer') as HTMLInputElement;
const select = () => $('recognize-lesson') as HTMLSelectElement;

async function connected() {
  const mock = new MockDevice({ resetOnOpen: false });
  const link = new DeviceLink();
  link.attach(mock);
  await vi.advanceTimersByTimeAsync(500); // hello, anim, get
  expect(link.state).toBe('ready');
  return { mock, link };
}

interface Harness {
  link: DeviceLink;
  mock: MockDevice | null;
  said: string[];
  tones: string[];
  keyCalls: (KeyHandlers | null)[];
  keys(): KeyHandlers;
  clock: { t: number };
  /** Every display state the device confirmed, in order. */
  confirmed: number[][];
  unmount(): void;
  lastSaid(): string;
}

async function mount(opts: RecognizeOptions & { lesson?: string; connect?: boolean } = {}): Promise<Harness> {
  const { lesson, connect = true, ...modeOpts } = opts;
  const { link, mock } = connect ? await connected() : { link: new DeviceLink(), mock: null };
  const said: string[] = [];
  const tones: string[] = [];
  const keyCalls: (KeyHandlers | null)[] = [];
  const clock = { t: 1000 };
  const confirmed: number[][] = [];
  link.on('confirmed', (m) => m && confirmed.push(m));
  const ctx: ModeContext = {
    link,
    announce: (m) => said.push(m),
    say: (m) => said.push(m),
    tone: (k) => tones.push(k),
    setKeys: (hs) => keyCalls.push(hs),
    now: () => clock.t,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const unmount = createRecognizeMode({ random: () => 0, ...modeOpts }).mount(root, ctx);
  if (lesson) {
    select().value = lesson;
    select().dispatchEvent(new Event('change'));
  }
  return {
    link,
    mock,
    said,
    tones,
    keyCalls,
    keys: () => keyCalls[keyCalls.length - 1]!,
    clock,
    confirmed,
    unmount,
    lastSaid: () => said[said.length - 1] ?? '',
  };
}

function type(value: string): void {
  input().value = value;
  input().form!.requestSubmit();
}

/** Start and wait until the first item is confirmed on the device. */
async function startSession(): Promise<void> {
  btn('recognize-start').click();
  await vi.advanceTimersByTimeAsync(1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  progress.reset();
  persist();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

// --- Pure helpers ----------------------------------------------------------------

describe('pickItem', () => {
  const items = L1.items; // a b c d e
  const wrong = (key: string): Attempt => ({ lessonId: 'L1', itemKey: key, correct: false, ms: 1, at: 0 });

  it('never repeats the previous item', () => {
    for (const r of [0, 0.2, 0.5, 0.8, 0.999]) {
      for (const prev of items) expect(pickItem(items, prev.key, [], () => r).key).not.toBe(prev.key);
    }
  });

  it('is uniform without mistakes and deterministic for a given random()', () => {
    expect(pickItem(items, null, [], () => 0).key).toBe('a');
    expect(pickItem(items, null, [], () => 0.3).key).toBe('b'); // 1.5 of 5
    expect(pickItem(items, null, [], () => 0.99).key).toBe('e');
  });

  it('weights recently wrong items higher', () => {
    // Weights a1 b1 c5 d1 e1 (two mistakes on c): 0.3 * 9 = 2.7 falls into c.
    expect(pickItem(items, null, [wrong('c'), wrong('c')], () => 0.3).key).toBe('c');
    const counts = new Map<string, number>();
    for (let i = 0; i < 100; i++) {
      const k = pickItem(items, null, [wrong('c'), wrong('c')], () => i / 100).key;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.get('c')).toBeGreaterThan(50);
    expect(counts.get('a')).toBeGreaterThan(5);
  });

  it('allows the only item of a one-item lesson again', () => {
    const one: LessonItem[] = [items[0]!];
    expect(pickItem(one, 'a', [], () => 0.5).key).toBe('a');
  });
});

describe('parseAnswer', () => {
  it('accepts letters case-insensitively, in NFC and by Polish name', () => {
    expect(parseAnswer('letters', 'M')).toMatchObject({ ok: true, answer: { key: 'm', spoken: 'em' } });
    const nfd = ' a' + String.fromCodePoint(0x0328) + ' '; // "a" + combining ogonek (NFD)
    expect(parseAnswer('letters', nfd)).toMatchObject({ ok: true, answer: { key: 'ą' } });
    expect(parseAnswer('letters', 'Ż')).toMatchObject({ ok: true, answer: { key: 'ż' } });
    expect(parseAnswer('letters', 'em')).toMatchObject({ ok: true, answer: { key: 'm' } });
    expect(parseAnswer('letters', '3')).toMatchObject({ ok: false });
    expect(parseAnswer('letters', 'xyz')).toMatchObject({ ok: false });
  });

  it('accepts dot numbers 1-6 in L0 only', () => {
    expect(parseAnswer('dots', '3')).toMatchObject({ ok: true, answer: { key: 'dot3', mask: 4, spoken: 'punkt 3' } });
    expect(parseAnswer('dots', '7')).toEqual({ ok: false, message: 'Wpisz numer punktu od 1 do 6.' });
    expect(parseAnswer('dots', 'a')).toMatchObject({ ok: false });
  });
});

describe('describeDifference and hints', () => {
  const ans = (ch: string) => {
    const p = parseAnswer('letters', ch);
    if (!p.ok) throw new Error(ch);
    return p.answer;
  };

  it('joins lists the Polish way', () => {
    expect(andList([5])).toBe('5');
    expect(andList([1, 5])).toBe('1 i 5');
    expect(andList([1, 3, 4])).toBe('1, 3 i 4');
  });

  it('names the differing dots and the letter that has them', () => {
    expect(describeDifference(ans('m'), ans('n'))).toBe('Różnią się punktem 5: tylko litera en ma punkt 5.');
    expect(describeDifference(ans('e'), ans('i'))).toBe(
      'Różnią się punktami 1, 2, 4 i 5: tylko litera e ma punkty 1 i 5, tylko litera i ma punkty 2 i 4.',
    );
  });

  it('refers to letters as "litera X" and says lessons by their letters', () => {
    expect(spokenName('letters', 'i')).toBe('litera i');
    expect(spokenName('dots', 'punkt 3')).toBe('punkt 3');
    expect(spokenLesson(L1)).toBe('L1, litery: a, be, ce, de, e');
    expect(spokenLesson(L0)).not.toMatch(/[–—]/);
  });

  it('builds the ladder for letters and for L0', () => {
    const m = L3.items.find((i) => i.key === 'm')!;
    expect(hintText(L3, m, 2)).toBe('Ten znak ma 3 punkty.');
    expect(hintText(L3, m, 3)).toBe('Wysunięte są punkty 1, 3 i 4.');
    expect(hintText(L3, m, 4)).toBe('To jest litera em. Punkty 1, 3 i 4.');
    const a = L1.items[0]!;
    expect(hintText(L1, a, 2)).toBe('Ten znak ma 1 punkt.');
    expect(hintText(L1, a, 3)).toBe('Wysunięty jest punkt 1.');
    const dot5 = L0.items[4]!;
    expect(hintText(L0, dot5, 2)).toBe('Punkt jest w prawej kolumnie.');
    expect(hintText(L0, dot5, 3)).toBe('Punkt jest w prawej kolumnie, w środkowym rzędzie.');
    expect(hintText(L0, dot5, 4)).toBe('To jest punkt 5.');
  });
});

// --- The mode ---------------------------------------------------------------------

const CONTINUE = 'Gdy skończysz, zdejmij palce i naciśnij Enter albo Dalej.';

describe('recognize mode: setup', () => {
  it('is the "recognize" mode with a labelled answer field and F1-F3 handlers', async () => {
    expect(recognizeMode.id).toBe('recognize');
    expect(recognizeMode.title).toBe('Rozpoznawanie');
    const hx = await mount();
    expect(document.querySelector('label[for="recognize-answer"]')?.textContent).toBe('Twoja odpowiedź');
    expect(document.querySelector('label[for="recognize-lesson"]')?.textContent).toBe('Lekcja');
    const k = hx.keys();
    expect(typeof k.repeat).toBe('function');
    expect(typeof k.hint).toBe('function');
    expect(typeof k.blink).toBe('function');
    hx.unmount();
  });

  it('offers only non-locked lessons and defaults to the current one', async () => {
    await mount();
    expect([...select().options].map((o) => o.value)).toEqual(['L0']);
    expect(select().value).toBe('L0');
    document.body.replaceChildren();

    progress.setTeacherUnlocked(true);
    await mount();
    expect(select().options).toHaveLength(8);
    expect(select().value).toBe('L0');
  });

  it('does not start without a connected device and records nothing', async () => {
    const hx = await mount({ connect: false });
    expect($('recognize-device').hidden).toBe(false);
    expect($('recognize-device').textContent).toMatch(/nie jest połączone/);
    btn('recognize-start').click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hx.lastSaid()).toMatch(/najpierw połącz urządzenie/);
    expect(btn('recognize-start').disabled).toBe(false);
    type('1');
    expect(hx.lastSaid()).toBe('Najpierw naciśnij Start.');
    hx.keys().hint!();
    expect(hx.lastSaid()).toBe('Najpierw naciśnij Start.');
    expect(progress.attempts('L0')).toHaveLength(0);
  });
});

describe('recognize mode: a trial', () => {
  it('clears, pauses 300 ms, shows on cell 3, and only then plays ready and asks', async () => {
    const hx = await mount();
    // Something on the display from before: the trial must clear it first.
    const before = hx.link.show([63, 63]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await before).status).toBe('ok');
    hx.confirmed.length = 0;

    btn('recognize-start').click();
    expect(document.activeElement).toBe(input());
    expect(btn('recognize-start').disabled).toBe(true);
    expect(btn('recognize-stop').disabled).toBe(false);
    expect(select().disabled).toBe(true);
    expect($('recognize-status').textContent).toMatch(/zdejmij palce/);

    await vi.advanceTimersByTimeAsync(350);
    expect(hx.tones).toEqual([]); // not before the device confirmed the item
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.confirmed).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
    ]);
    expect(hx.mock!.cells).toEqual([0, 0, 1, 0, 0]);
    expect(hx.tones).toEqual(['ready']);
    expect(hx.lastSaid()).toBe('Który punkt jest wysunięty?');
    expect(progress.attempts('L0')).toHaveLength(0);
  });

  it('asks "Jaki to znak?" in letter lessons', async () => {
    progress.setTeacherUnlocked(true);
    const hx = await mount({ lesson: 'L1' });
    await startSession();
    expect(hx.mock!.cells).toEqual([0, 0, mask('a'), 0, 0]);
    expect(hx.lastSaid()).toBe('Jaki to znak?');
  });

  it('records a correct first answer, asks to lift the fingers and moves on after 1.5 s', async () => {
    const hx = await mount();
    await startSession();
    hx.clock.t += 2345;
    type('1');
    expect(progress.attempts('L0')).toEqual([
      expect.objectContaining({ lessonId: 'L0', itemKey: 'dot1', correct: true, ms: 2345 }),
    ]);
    expect(hx.tones).toEqual(['ready', 'correct']);
    expect(hx.lastSaid()).toBe('Dobrze, to punkt 1. Zdejmij palce.');
    expect(input().value).toBe('');
    expect($('recognize-session').textContent).toBe('W tej sesji: 1 z 1 poprawnie.');
    expect($('recognize-lesson-stats').textContent).toMatch(/Wynik z ostatnich prób \(1\): poprawnie 1, czyli 100%\. Do oceny brakuje jeszcze 19 prób\./);

    hx.confirmed.length = 0;
    await vi.advanceTimersByTimeAsync(1400);
    expect(hx.confirmed).toEqual([]); // the feedback is not cut off by the next trial
    await vi.advanceTimersByTimeAsync(1100);
    // Next item (never the same one twice): cleared, then shown.
    expect(hx.confirmed).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 2, 0, 0],
    ]);
    expect(hx.lastSaid()).toBe('Który punkt jest wysunięty?');
    expect(hx.tones).toEqual(['ready', 'correct', 'ready']);
  });

  it('answers Enter, F2 and F3 during the pause after a correct answer', async () => {
    const hx = await mount();
    await startSession();
    type('1');
    type('2');
    expect(hx.lastSaid()).toBe('Chwileczkę, zaraz następny znak.');
    hx.keys().hint!();
    expect(hx.lastSaid()).toBe('Chwileczkę, zaraz następny znak.');
    hx.keys().blink!();
    expect(hx.lastSaid()).toBe('Chwileczkę, zaraz następny znak.');
    hx.keys().repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toBe('Dobrze, to punkt 1. Zdejmij palce.');
    expect(progress.attempts('L0')).toHaveLength(1);
  });

  it('ignores answers while the item is still moving', async () => {
    const hx = await mount();
    btn('recognize-start').click();
    await vi.advanceTimersByTimeAsync(100);
    type('1');
    expect(hx.lastSaid()).toMatch(/Chwileczkę/);
    hx.keys().hint!();
    expect(hx.lastSaid()).toBe('Chwileczkę, układam znak.');
    expect(progress.attempts('L0')).toHaveLength(0);
  });

  it('does not count answers it cannot understand', async () => {
    const hx = await mount();
    await startSession();
    type('a');
    expect(hx.lastSaid()).toBe('Wpisz numer punktu od 1 do 6.');
    type('   ');
    expect(hx.lastSaid()).toBe('Wpisz odpowiedź i naciśnij Enter.');
    expect(progress.attempts('L0')).toHaveLength(0);
    type('1');
    expect(progress.attempts('L0')).toHaveLength(1);
  });

  it('first wrong answer: records once, the character stays, "Spróbuj jeszcze raz"', async () => {
    const hx = await mount();
    await startSession();
    hx.clock.t += 500;
    type('4');
    expect(progress.attempts('L0')).toEqual([expect.objectContaining({ itemKey: 'dot1', correct: false, ms: 500 })]);
    expect(hx.tones).toEqual(['ready', 'wrong']);
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 4. Spróbuj jeszcze raz.');
    expect($('recognize-status').textContent).toBe('Nie, to nie punkt 4. Spróbuj jeszcze raz.');

    // Nothing moves under the finger.
    hx.confirmed.length = 0;
    await vi.advanceTimersByTimeAsync(3000);
    expect(hx.confirmed).toEqual([]);
    expect(hx.mock!.cells).toEqual([0, 0, 1, 0, 0]);
    hx.keys().repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 4. Spróbuj jeszcze raz.');

    // Second answer is right, but only the first one counts; the contrast follows.
    type('1');
    expect(progress.attempts('L0')).toHaveLength(1);
    expect(hx.tones.at(-1)).toBe('correct');
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.mock!.cells).toEqual([1, 0, 8, 0, 0]);
    expect(hx.lastSaid()).toBe(
      'Dobrze, to punkt 1. Na komórce 1 punkt 1, na komórce 3 punkt 4 — Twoja wcześniejsza odpowiedź. ' + CONTINUE,
    );
    expect(btn('recognize-next').hidden).toBe(false);
    expect($('recognize-session').textContent).toBe('W tej sesji: 0 z 1 poprawnie.');

    // Enter in the answer field (or the "Odpowiedz" button) continues, like "Dalej".
    btn('recognize-submit').click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(hx.mock!.cells).toEqual([0, 0, 2, 0, 0]);
    expect(btn('recognize-next').hidden).toBe(true);
    expect(progress.attempts('L0')).toHaveLength(1);
  });

  it('second wrong answer: says it at once, then blinks; F1 repeats the feedback', async () => {
    const hx = await mount();
    await startSession();
    type('4');
    type('5');
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 5. Mrugam znakiem.');
    expect(hx.tones).toEqual(['ready', 'wrong', 'wrong']);
    expect(progress.attempts('L0')).toHaveLength(1);

    hx.confirmed.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.confirmed).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
    ]);
    expect(hx.tones).toEqual(['ready', 'wrong', 'wrong', 'ready']);
    expect(hx.lastSaid()).toBe('Dotknij jeszcze raz.');
    hx.keys().repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 5. Który punkt jest wysunięty?');
  });

  it('contrasts letters on cells 1 and 3 and explains the differing dots', async () => {
    progress.setTeacherUnlocked(true);
    const hx = await mount({ lesson: 'L3', random: () => 0.45 }); // k l [m] n o
    await startSession();
    expect(hx.mock!.cells).toEqual([0, 0, mask('m'), 0, 0]);
    type('N');
    expect(hx.lastSaid()).toBe('Nie, to nie litera en. Spróbuj jeszcze raz.');
    type('m');
    expect(hx.said.at(-1)).not.toMatch(/Na komórce/); // spoken only once the contrast is up
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.mock!.cells).toEqual([mask('m'), 0, mask('n'), 0, 0]);
    expect(hx.lastSaid()).toBe(
      'Dobrze, to litera em. Na komórce 1 litera em, na komórce 3 litera en — Twoja wcześniejsza odpowiedź. ' +
        'Różnią się punktem 5: tylko litera en ma punkt 5. ' +
        CONTINUE,
    );

    // "Dalej" button: continues and keeps keyboard focus in the answer field.
    btn('recognize-next').focus();
    btn('recognize-next').click();
    expect(document.activeElement).toBe(input());
    await vi.advanceTimersByTimeAsync(1500);
    expect(hx.mock!.cells[2]).not.toBe(0);
    expect(hx.mock!.cells[0]).toBe(0);
    expect(hx.mock!.cells[1]).toBe(0);
  });

  it('walks the hint ladder on F2 and builds the answer dot by dot at step 4', async () => {
    progress.setTeacherUnlocked(true);
    const hx = await mount({ lesson: 'L3', random: () => 0.45 });
    await startSession();
    const k = hx.keys();

    k.hint!(); // 1: blink
    expect(hx.lastSaid()).toBe('Mrugam znakiem.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.lastSaid()).toBe('Dotknij jeszcze raz.');
    expect(hx.mock!.cells).toEqual([0, 0, mask('m'), 0, 0]);
    k.hint!();
    // Said once per trial, when the ladder starts to cost the trial.
    expect(hx.lastSaid()).toBe('Ten znak ma 3 punkty. Od tej podpowiedzi próba nie liczy się jako poprawna.');
    k.hint!();
    expect(hx.lastSaid()).toBe('Wysunięte są punkty 1, 3 i 4.');
    k.repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toBe('Wysunięte są punkty 1, 3 i 4.');
    expect(progress.attempts('L3')).toHaveLength(0);

    hx.confirmed.length = 0;
    const saidBefore = hx.said.length;
    k.hint!();
    expect(hx.lastSaid()).toBe('To jest litera em. Zdejmij palce, pokażę ją punkt po punkcie.');
    // Revealed without an answer: counted as not recognised.
    expect(progress.attempts('L3')).toEqual([expect.objectContaining({ itemKey: 'm', correct: false })]);
    expect(btn('recognize-next').hidden).toBe(false);
    k.blink!();
    expect(hx.lastSaid()).toBe('Chwileczkę, pokazuję znak punkt po punkcie.');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hx.confirmed).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1 | 4, 0, 0],
      [0, 0, mask('m'), 0, 0],
    ]);
    const spoken = hx.said.slice(saidBefore).filter((s) => s.startsWith('punkt'));
    expect(spoken).toEqual(['punkt 1', 'punkt 3', 'punkt 4']);
    expect(hx.lastSaid()).toBe(`To jest litera em. Punkty 1, 3 i 4. ${CONTINUE}`);

    // The character stays under the fingers until "Dalej".
    await vi.advanceTimersByTimeAsync(5000);
    expect(hx.mock!.cells).toEqual([0, 0, mask('m'), 0, 0]);
    k.hint!();
    expect(hx.lastSaid()).toMatch(/^To jest litera em/);
    k.repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toMatch(/^To jest litera em/);
  });

  it('Enter during the dot-by-dot build goes on to the next trial', async () => {
    progress.setTeacherUnlocked(true);
    const hx = await mount({ lesson: 'L3', random: () => 0.45 });
    await startSession();
    const k = hx.keys();
    k.hint!();
    await vi.advanceTimersByTimeAsync(1000);
    k.hint!();
    k.hint!();
    k.hint!();
    await vi.advanceTimersByTimeAsync(4500); // first dot is up
    type('');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hx.said.filter((s) => s === 'punkt 3')).toHaveLength(0);
    expect(hx.lastSaid()).toBe('Jaki to znak?');
    expect(hx.mock!.cells[2]).not.toBe(0);
    expect(hx.mock!.cells[2]).not.toBe(mask('m'));
  });

  it('a correct answer after a revealing hint is not counted and waits for "Dalej"', async () => {
    progress.setTeacherUnlocked(true);
    const hx = await mount({ lesson: 'L3', random: () => 0.45 });
    await startSession();
    hx.keys().hint!();
    await vi.advanceTimersByTimeAsync(1000);
    hx.keys().hint!(); // dot count
    type('m');
    expect(progress.attempts('L3')).toEqual([expect.objectContaining({ correct: false })]);
    expect(hx.lastSaid()).toBe(
      `Dobrze, to litera em. Ta próba była z podpowiedzią, więc nie liczy się jako poprawna. ${CONTINUE}`,
    );
    expect(hx.tones.at(-1)).toBe('correct');
    // No next trial talking over it.
    await vi.advanceTimersByTimeAsync(5000);
    expect(btn('recognize-next').hidden).toBe(false);
    expect(hx.lastSaid()).toMatch(/^Dobrze, to litera em/);
  });

  it('a blink alone (F3 or hint 1) does not spoil a correct answer', async () => {
    const hx = await mount();
    await startSession();
    hx.keys().blink!();
    await vi.advanceTimersByTimeAsync(1000);
    hx.keys().hint!();
    await vi.advanceTimersByTimeAsync(1000);
    type('1');
    expect(progress.attempts('L0')).toEqual([expect.objectContaining({ correct: true })]);
  });

  it('a blink overtaken by newer feedback only plays the ready tone', async () => {
    const hx = await mount();
    await startSession();
    hx.keys().blink!();
    expect(hx.lastSaid()).toBe('Mrugam znakiem.');
    type('4');
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 4. Spróbuj jeszcze raz.');
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.mock!.cells).toEqual([0, 0, 1, 0, 0]);
    expect(hx.tones).toEqual(['ready', 'wrong', 'ready']);
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 4. Spróbuj jeszcze raz.');
    hx.keys().repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 4. Spróbuj jeszcze raz.');
  });

  it('wrong answers advance the ladder up to the answer and the contrast', async () => {
    const hx = await mount();
    await startSession(); // dot 1
    type('2');
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 2. Spróbuj jeszcze raz.');
    type('3');
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 3. Mrugam znakiem.');
    await vi.advanceTimersByTimeAsync(1000);
    type('3');
    // Already recorded as wrong: no "does not count" remark.
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 3. Punkt jest w lewej kolumnie.');
    type('3');
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 3. Punkt jest w lewej kolumnie, w górnym rzędzie.');
    type('6');
    await vi.advanceTimersByTimeAsync(1000);
    // Single dot: nothing to build; the latest wrong answer is "Twoja odpowiedź".
    expect(hx.lastSaid()).toBe(
      'Nie, to nie punkt 6. To jest punkt 1. Na komórce 1 punkt 1, na komórce 3 punkt 6 — Twoja odpowiedź. ' + CONTINUE,
    );
    expect(hx.mock!.cells).toEqual([1, 0, 32, 0, 0]);
    expect(progress.attempts('L0')).toHaveLength(1);
  });

  it('F1 repeats the prompt and puts the item back if the display lost it', async () => {
    const hx = await mount();
    await startSession();
    hx.keys().repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(hx.lastSaid()).toBe('Który punkt jest wysunięty?');
    expect(hx.tones).toEqual(['ready']);

    // e.g. the device went to sleep, or another tool cleared it
    const cleared = hx.link.clear();
    await vi.advanceTimersByTimeAsync(500);
    expect((await cleared).status).toBe('ok');
    const before = hx.said.length;
    hx.keys().repeat!();
    expect(hx.said.length).toBe(before); // nothing said before the dots are back
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.mock!.cells).toEqual([0, 0, 1, 0, 0]);
    expect(hx.tones).toEqual(['ready', 'ready']);
    expect(hx.lastSaid()).toBe('Który punkt jest wysunięty?');
  });

  it('F1 while the contrast is still queued does not replace it (no false device error)', async () => {
    const hx = await mount();
    await startSession(); // dot 1
    const k = hx.keys();
    k.hint!(); // blink
    await vi.advanceTimersByTimeAsync(1000);
    k.hint!();
    k.hint!();
    k.blink!(); // clear in flight
    type('4');
    type('4'); // second mistake: step 4, the contrast show queues behind the blink's clear
    k.repeat!(); // within the clear's move time
    await vi.advanceTimersByTimeAsync(5);
    expect(hx.lastSaid()).toBe('Nie, to nie punkt 4. To jest punkt 1. Pokazuję porównanie na komórkach 1 i 3.');
    await vi.advanceTimersByTimeAsync(2000);
    expect(hx.said.some((s) => s.includes('Nie udało się'))).toBe(false);
    expect(btn('recognize-stop').disabled).toBe(false);
    expect(hx.mock!.cells).toEqual([1, 0, 8, 0, 0]);
    expect(hx.lastSaid()).toMatch(/Na komórce 1 punkt 1, na komórce 3 punkt 4 — Twoja odpowiedź\./);
  });
});

describe('recognize mode: passing a lesson', () => {
  const preload = (n: number) => {
    for (let i = 0; i < n; i++) {
      progress.record({ lessonId: 'L0', itemKey: `dot${(i % 6) + 1}`, correct: true, ms: 1000, at: i });
    }
  };

  it('announces the passed lesson, how to reach the unlocked one, refreshes the picker and waits', async () => {
    preload(19); // the 20th attempt completes the window
    const hx = await mount();
    await startSession();
    type('1');
    expect(hx.lastSaid()).toBe(
      'Dobrze, to punkt 1. Lekcja L0 zaliczona! Odblokowano lekcję L1, litery: a, be, ce, de, e. ' +
        'Aby ją ćwiczyć, naciśnij Zakończ, wybierz lekcję z listy i Start. ' +
        CONTINUE,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(hx.tones).toEqual(['ready', 'correct', 'unlock']);
    expect(progress.status('L0')).toBe('passed');
    expect(progress.status('L1')).toBe('available');
    expect([...select().options].map((o) => o.value)).toEqual(['L0', 'L1']);
    expect(select().value).toBe('L0');
    expect(select().options[0]!.textContent).toMatch(/zaliczona/);
    // No automatic next trial after a milestone.
    await vi.advanceTimersByTimeAsync(3000);
    expect(btn('recognize-next').hidden).toBe(false);
    expect(hx.mock!.cells).toEqual([0, 0, 1, 0, 0]);
  });

  it('the unlock tone survives an immediate Enter', async () => {
    preload(19);
    const hx = await mount();
    await startSession();
    type('1');
    type(''); // Enter straight away: next trial
    await vi.advanceTimersByTimeAsync(2000);
    expect(hx.tones).toContain('unlock');
    expect(hx.lastSaid()).toBe('Który punkt jest wysunięty?');
  });

  it('a wrong answer that passes the lesson also waits for "Dalej", with the contrast', async () => {
    preload(19); // 19 of 20 = 95 %
    const hx = await mount();
    await startSession();
    type('4');
    expect(progress.status('L0')).toBe('passed');
    await vi.advanceTimersByTimeAsync(1000);
    // The contrast's ready tone may come before the (400 ms delayed) unlock tone.
    expect([...hx.tones].sort()).toEqual(['ready', 'ready', 'unlock', 'wrong']);
    expect(hx.tones.slice(0, 2)).toEqual(['ready', 'wrong']);
    expect(hx.mock!.cells).toEqual([1, 0, 8, 0, 0]);
    expect(hx.lastSaid()).toMatch(/^Nie, to nie punkt 4\. Lekcja L0 zaliczona! Odblokowano lekcję L1/);
    expect(hx.lastSaid()).toContain('na komórce 3 punkt 4 — Twoja odpowiedź.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(btn('recognize-next').hidden).toBe(false);
    expect(hx.mock!.cells).toEqual([1, 0, 8, 0, 0]);
  });

  it('can pass L0 by answering 20 trials in a row', async () => {
    const hx = await mount();
    await startSession();
    for (let i = 0; i < 20; i++) {
      const dot = maskToDots(hx.mock!.cells[2]!)[0]!;
      type(String(dot));
      await vi.advanceTimersByTimeAsync(2500);
    }
    expect(progress.status('L0')).toBe('passed');
    expect(hx.said.some((s) => s.includes('Odblokowano lekcję L1'))).toBe(true);
    expect($('recognize-session').textContent).toBe('W tej sesji: 20 z 20 poprawnie.');
  });
});

describe('recognize mode: stopping and failures', () => {
  it('Stop ends the session, clears the display and keeps focus on a usable control', async () => {
    const hx = await mount();
    await startSession();
    type('1');
    btn('recognize-stop').focus();
    btn('recognize-stop').click();
    expect(document.activeElement).toBe(btn('recognize-start'));
    expect(btn('recognize-start').disabled).toBe(false);
    expect(btn('recognize-stop').disabled).toBe(true);
    expect(select().disabled).toBe(false);
    expect(hx.lastSaid()).toBe('Koniec sesji. Poprawnie 1 z 1.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(hx.mock!.cells).toEqual([0, 0, 0, 0, 0]);
    // The pending next trial was cancelled.
    expect(hx.lastSaid()).toBe('Koniec sesji. Poprawnie 1 z 1.');
  });

  it('a trial whose show the device rejects stops the session and records nothing', async () => {
    const hx = await mount();
    btn('recognize-start').click();
    await vi.advanceTimersByTimeAsync(50); // clear done, in the 300 ms pause
    const spy = vi
      .spyOn(hx.link, 'show')
      .mockResolvedValueOnce({ status: 'error', code: 'range', detail: 'servo' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledWith([0, 0, 1, 0, 0]);
    spy.mockRestore();
    expect(hx.lastSaid()).toMatch(/^Nie udało się ułożyć znaku\. Urządzenie zgłosiło błąd: range servo\. Sesja zatrzymana\./);
    expect(btn('recognize-start').disabled).toBe(false);
    expect(hx.tones).not.toContain('ready');
    type('1');
    expect(progress.attempts('L0')).toHaveLength(0);
  });

  it('a disconnect before the item is up stops the session and records nothing', async () => {
    const hx = await mount();
    btn('recognize-start').click();
    await vi.advanceTimersByTimeAsync(100);
    hx.link.detach();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hx.lastSaid()).toMatch(/Sesja zatrzymana/);
    expect(btn('recognize-start').disabled).toBe(false);
    expect($('recognize-device').hidden).toBe(false);
    type('1');
    expect(progress.attempts('L0')).toHaveLength(0);
    expect(hx.tones).not.toContain('ready');
  });

  it('stops when the device disconnects mid-trial', async () => {
    const hx = await mount();
    await startSession();
    hx.link.detach();
    expect(hx.lastSaid()).toMatch(/^Połączenie z urządzeniem zostało przerwane\. Sesja zatrzymana\./);
    type('1');
    expect(progress.attempts('L0')).toHaveLength(0);
  });

  it('cleanup removes the keys, cancels pending timers and never talks afterwards', async () => {
    const hx = await mount();
    await startSession();
    type('1');
    const received = hx.mock!.received.length;
    const said = hx.said.length;
    hx.unmount();
    expect(hx.keyCalls.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(hx.mock!.received.length).toBe(received);
    expect(hx.said.length).toBe(said);
  });

  it('cleanup right after passing a lesson drops the pending unlock tone', async () => {
    for (let i = 0; i < 19; i++) {
      progress.record({ lessonId: 'L0', itemKey: `dot${(i % 6) + 1}`, correct: true, ms: 1000, at: i });
    }
    const hx = await mount();
    await startSession();
    type('1');
    hx.unmount();
    await vi.advanceTimersByTimeAsync(1000);
    expect(hx.tones).not.toContain('unlock');
  });

  it('cleanup during a pending show stays silent', async () => {
    const hx = await mount();
    btn('recognize-start').click();
    await vi.advanceTimersByTimeAsync(350); // show in flight
    hx.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(hx.tones).toEqual([]);
    expect(hx.said).toEqual([]);
  });

  it('cleanup during the dot-by-dot build stays silent', async () => {
    progress.setTeacherUnlocked(true);
    const hx = await mount({ lesson: 'L3', random: () => 0.45 });
    await startSession();
    const k = hx.keys();
    k.hint!();
    await vi.advanceTimersByTimeAsync(1000);
    k.hint!();
    k.hint!();
    k.hint!();
    await vi.advanceTimersByTimeAsync(4500);
    const said = hx.said.length;
    const received = hx.mock!.received.length;
    hx.unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hx.said.length).toBe(said);
    expect(hx.mock!.received.length).toBe(received);
  });
});
