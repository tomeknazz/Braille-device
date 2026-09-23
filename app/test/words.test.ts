// @vitest-environment happy-dom
// Word material (words.json + words.ts) and the "Słowa" mode driven through
// DeviceLink + MockDevice with fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { letterByChar } from '../src/braille/table';
import { translate } from '../src/braille/translator';
import { DeviceLink } from '../src/device/DeviceLink';
import { MockDevice } from '../src/device/MockDevice';
import { curriculum, type Curriculum } from '../src/learn/curriculum';
import { CourseProgress, emptyProgress, type LessonStatus } from '../src/learn/progress';
import {
  PREFER_CURRENT,
  availableWords,
  buildWords,
  pickWord,
  words,
  wordsWithLessonLetters,
  type LessonAccess,
} from '../src/learn/words';
import raw from '../src/learn/words.json';
import * as session from '../src/learn/session';
import { createWordsMode, letterCount, letterFeedback, normalizeAnswer, wordsMode } from '../src/modes/words';
import type { KeyHandlers, ModeContext } from '../src/modes/types';

const LESSON_IDS = curriculum.lessons.map((l) => l.id);

/** Progress where every lesson before `upTo` is passed (so `upTo` is the current one). */
function progressUpTo(upTo: string, teacherUnlocked = false): CourseProgress {
  const i = LESSON_IDS.indexOf(upTo);
  return new CourseProgress(curriculum, { ...emptyProgress(), passed: LESSON_IDS.slice(0, i), teacherUnlocked });
}

const byWord = (w: string) => {
  const e = words.find((x) => x.word === w);
  if (!e) throw new Error(`"${w}" missing from words.json`);
  return e;
};

// --- Word material ----------------------------------------------------------

describe('words.json', () => {
  it('has 150-250 unique words', () => {
    expect(words.length).toBeGreaterThanOrEqual(150);
    expect(words.length).toBeLessThanOrEqual(250);
    expect(new Set(raw.words).size).toBe(raw.words.length);
    expect(words).toHaveLength(raw.words.length);
  });

  it('every word fits the device (at most 5 cells) and uses only table letters', () => {
    for (const w of words) {
      const t = translate(w.word);
      expect(t.unknown, w.word).toEqual([]);
      expect(t.segments.every((s) => s.kind === 'letter'), w.word).toBe(true);
      expect(t.cells.length, w.word).toBeLessThanOrEqual(5);
      expect(t.cells.length, w.word).toBeGreaterThanOrEqual(2);
      expect(w.cells).toEqual(t.cells);
      for (const ch of w.letters) expect(letterByChar.has(ch), `${w.word}: ${ch}`).toBe(true);
      expect(w.word).toBe(w.word.toLocaleLowerCase('pl'));
    }
  });

  it('computes the minimal lesson from the latest letter', () => {
    // k, o come from L3 and t from L4, so "kot" needs L4.
    expect(byWord('kot')).toMatchObject({ lessonId: 'L4', lessons: ['L3', 'L4'], names: ['ka', 'o', 'te'] });
    expect(byWord('baba')).toMatchObject({ lessonId: 'L1', lessons: ['L1'] });
    expect(byWord('dach')).toMatchObject({ lessonId: 'L2', lessons: ['L1', 'L2'] });
    expect(byWord('dom')).toMatchObject({ lessonId: 'L3', lessons: ['L1', 'L3'] });
    expect(byWord('zupa')).toMatchObject({ lessonId: 'L5', lessons: ['L1', 'L4', 'L5'] });
    expect(byWord('kawa')).toMatchObject({ lessonId: 'L6' });
    expect(byWord('żaba')).toMatchObject({ lessonId: 'L7', lessons: ['L1', 'L7'] });
    for (const w of words) {
      expect(curriculum.lessons[w.lessonIndex]!.id).toBe(w.lessonId);
      expect(w.lessons[w.lessons.length - 1]).toBe(w.lessonId);
    }
  });

  it('has no proper names (they need the capital sign, L8) and no touchy words', () => {
    for (const w of ['ada', 'anna', 'ola', 'ala', 'ewa', 'adam', 'piotr', 'kuba', 'jaś', 'paweł', 'łucja']) {
      expect(raw.words, w).not.toContain(w);
    }
    for (const w of ['figi', 'rak', 'bije', 'jada', 'gada']) expect(raw.words, w).not.toContain(w);
  });

  it('offers words at every stage of the course from L1 on', () => {
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']) {
      expect(words.some((w) => w.lessonId === id), id).toBe(true);
    }
  });
});

describe('buildWords validation', () => {
  const build = (...list: string[]) => buildWords({ version: 1, words: list });

  it('rejects characters missing from the table', () => {
    expect(() => build('k@t')).toThrow(/missing from the braille table: @/);
  });
  it('rejects digits, punctuation and spaces', () => {
    expect(() => build('kot1')).toThrow(/letters only/);
    expect(() => build('tak.')).toThrow(/letters only/);
    expect(() => build('ala ma')).toThrow(/letters only/);
  });
  it('rejects words longer than the device', () => {
    expect(() => build('mleczko')).toThrow(/needs 7 cells/);
    expect(() => buildWords({ version: 1, words: ['kot'] }, curriculum, 2)).toThrow(/needs 3 cells, the device has 2/);
  });
  it('rejects upper case and duplicates', () => {
    expect(() => build('Kot')).toThrow(/lower-case/);
    expect(() => build('kot', 'kot')).toThrow(/duplicate/);
  });
  it('rejects letters that no lesson teaches', () => {
    const short: Curriculum = { ...curriculum, lessons: curriculum.lessons.slice(0, 7) }; // without L7
    expect(() => buildWords({ version: 1, words: ['żaba'] }, short)).toThrow(/"ż", which no lesson teaches/);
  });
});

describe('availability', () => {
  it('a fresh learner (only L0 open) has no words yet', () => {
    expect(availableWords(words, new CourseProgress(curriculum))).toEqual([]);
  });

  it('after L0 only a-e words are offered', () => {
    const list = availableWords(words, progressUpTo('L1'));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((w) => w.letters.every((ch) => 'abcde'.includes(ch)))).toBe(true);
    expect(list.map((w) => w.word)).toContain('baba');
  });

  it('"kot" appears only once L4 is open', () => {
    expect(availableWords(words, progressUpTo('L3')).map((w) => w.word)).not.toContain('kot');
    expect(availableWords(words, progressUpTo('L3')).map((w) => w.word)).toContain('dom');
    expect(availableWords(words, progressUpTo('L4')).map((w) => w.word)).toContain('kot');
  });

  it('the teacher unlock opens every word', () => {
    expect(availableWords(words, progressUpTo('L0', true))).toHaveLength(words.length);
  });

  it('checks every lesson of the word, not only the latest one', () => {
    const open = new Set(['L1', 'L3']);
    const access: Pick<LessonAccess, 'status'> = {
      status: (id: string): LessonStatus => (open.has(id) ? 'available' : 'locked'),
    };
    const names = availableWords(words, access).map((w) => w.word);
    expect(names).toContain('dom'); // d (L1) + o, m (L3)
    expect(names).not.toContain('kino'); // i is from the locked L2
  });
});

describe('pickWord', () => {
  const access = progressUpTo('L4');

  it('returns null when nothing is available', () => {
    expect(pickWord(words, new CourseProgress(curriculum))).toBeNull();
  });

  it('prefers words with letters of the current lesson', () => {
    const w = pickWord(words, access, () => 0);
    expect(w!.lessons).toContain('L4');
    const always = Array.from({ length: 40 }, (_, i) => pickWord(words, access, () => (i / 40) * PREFER_CURRENT * 0.999));
    expect(always.every((x) => x!.lessons.includes('L4'))).toBe(true);
  });

  it('sometimes takes older words to keep them fresh', () => {
    const seq = [0.95, 0];
    const w = pickWord(words, access, () => seq.shift() ?? 0);
    // Pool index 0: the first available word, from L1.
    expect(w!.word).toBe(availableWords(words, access)[0]!.word);
  });

  it('avoids recent words, and never repeats the last one', () => {
    const current = wordsWithLessonLetters(availableWords(words, access), access.current());
    const recent = current.map((w) => w.word);
    const w = pickWord(words, access, () => 0, recent);
    expect(recent).not.toContain(w!.word);

    const two = buildWords({ version: 1, words: ['kot', 'dom'] });
    expect(pickWord(two, access, () => 0, ['dom', 'kot'])!.word).toBe('dom');
    expect(pickWord(two, access, () => 0, ['kot', 'dom'])!.word).toBe('kot');
  });
});

describe('helpers', () => {
  it('letterCount uses Polish plural forms', () => {
    expect(letterCount(1)).toBe('1 literę');
    expect(letterCount(3)).toBe('3 litery');
    expect(letterCount(5)).toBe('5 liter');
  });
  it('normalizeAnswer ignores case, spaces and Unicode composition', () => {
    expect(normalizeAnswer('  KoT ')).toBe('kot');
    expect(normalizeAnswer('ŻABA')).toBe('żaba');
    expect(normalizeAnswer('żaba')).toBe('żaba');
  });
  it('letterFeedback names the positions that do not match', () => {
    const L = (s: string) => Array.from(s);
    expect(letterFeedback(L('kos'), L('kot'))).toBe('Trzecia litera się nie zgadza.');
    expect(letterFeedback(L('kaś'), L('kot'))).toBe('Nie zgadzają się litery: druga i trzecia.');
    expect(letterFeedback(L('abcde'), L('abxyz'))).toBe('Nie zgadzają się litery: trzecia, czwarta i piąta.');
    expect(letterFeedback(L('dom'), L('kot'))).toBe('Nie zgadzają się litery: pierwsza i trzecia.');
    expect(letterFeedback(L('abc'), L('kot'))).toBe('Żadna litera się nie zgadza.');
    expect(letterFeedback(L('ko'), L('kot'))).toBe(''); // lengths differ
    expect(letterFeedback(L('kot'), L('kot'))).toBe('');
  });
  it('the registered mode is "words" / "Słowa"', () => {
    expect(wordsMode.id).toBe('words');
    expect(wordsMode.title).toBe('Słowa');
  });
});

// --- The mode ----------------------------------------------------------------

const untag = (lines: string[]) => lines.map((l) => l.replace(/ #\d+$/, ''));

interface Harness {
  mock: MockDevice;
  link: DeviceLink;
  root: HTMLElement;
  log: string[];
  keys: () => KeyHandlers;
  setKeysCalls: (KeyHandlers | null)[];
  input: HTMLInputElement;
  submit(text: string): void;
  button(id: string): HTMLButtonElement;
  unmount: () => void;
  /** Lines the app sent after the handshake. */
  sent(): string[];
  said(): string[];
}

async function mountMode(
  opts: { upTo?: string; list?: string[]; connect?: boolean; random?: () => number; progress?: CourseProgress } = {},
): Promise<Harness> {
  const mock = new MockDevice({ resetOnOpen: false });
  const link = new DeviceLink();
  if (opts.connect !== false) {
    link.attach(mock);
    await vi.advanceTimersByTimeAsync(50);
    expect(link.state).toBe('ready');
  }
  const handshake = mock.received.length;
  const log: string[] = [];
  let keys: KeyHandlers | null = null;
  const setKeysCalls: (KeyHandlers | null)[] = [];
  const ctx: ModeContext = {
    link,
    announce: (m) => log.push(`say:${m}`),
    say: (m) => log.push(`say:${m}`),
    tone: (k) => log.push(`tone:${k}`),
    setKeys: (h) => {
      keys = h;
      setKeysCalls.push(h);
    },
    now: () => Date.now(),
  };
  const mode = createWordsMode({
    progress: opts.progress ?? progressUpTo(opts.upTo ?? 'L4'),
    words: buildWords({ version: 1, words: opts.list ?? ['kot', 'dom'] }),
    random: opts.random ?? (() => 0),
    pauseMs: 300,
    nextDelayMs: 2000,
    letterStepMs: 1000,
    hintLeadMs: 1200,
  });
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const unmount = mode.mount(root, ctx);
  const input = root.querySelector<HTMLInputElement>('#words-answer')!;
  return {
    mock,
    link,
    root,
    log,
    keys: () => keys!,
    setKeysCalls,
    input,
    submit(text: string) {
      input.value = text;
      input.form!.requestSubmit();
    },
    button: (id) => root.querySelector<HTMLButtonElement>(`#${id}`)!,
    unmount,
    sent: () => untag(mock.received.slice(handshake)),
    said: () => log.filter((l) => l.startsWith('say:')).map((l) => l.slice(4)),
  };
}

/** Advances fake time in small steps until `done()` (or fails after `maxMs`). */
async function until(done: () => boolean, maxMs = 5000): Promise<void> {
  for (let t = 0; t < maxMs && !done(); t += 10) await vi.advanceTimersByTimeAsync(10);
  expect(done()).toBe(true);
}

describe('mode "Słowa"', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('renders labelled controls and registers F1/F2/F3', async () => {
    const t = await mountMode();
    expect(t.root.querySelector('label[for="words-answer"]')?.textContent).toBe('Twoja odpowiedź');
    // The short status, not the long intro, is read on every focus.
    expect(t.input.getAttribute('aria-describedby')).toBe('words-status');
    expect(t.root.querySelector('#words-status')).not.toBeNull();
    // The intro matches what Enter really does.
    expect(t.root.querySelector('#words-help')?.textContent).toContain(
      'Enter w pustym polu zaczyna ćwiczenie i przechodzi dalej po odpowiedzi; słowo pominiesz przyciskiem „Następne słowo”.',
    );
    expect(t.root.querySelector('#words-pool')?.textContent).toMatch(/^Dostępnych słów: 2\. Częściej pojawiają się słowa z liter bieżącej lekcji L4/);
    expect(t.setKeysCalls).toHaveLength(1);
    const k = t.keys();
    expect(typeof k.repeat).toBe('function');
    expect(typeof k.hint).toBe('function');
    expect(typeof k.blink).toBe('function');
    // Nothing moves and nothing is said before the learner starts.
    expect(t.sent()).toEqual([]);
    expect(t.log).toEqual([]);
    t.unmount();
  });

  it('clear -> pause -> show; the prompt comes only after the device confirmed', async () => {
    const t = await mountMode();
    t.input.focus();
    t.submit(''); // Enter in the empty field starts
    await vi.advanceTimersByTimeAsync(100);
    expect(t.sent()).toEqual([]); // the display was already blank: clear skipped, pausing
    expect(t.log).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.sent()).toEqual(['show,5,21,30']);
    expect(t.log).toEqual([]); // sent, not yet confirmed
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(t.log).toEqual(['tone:ready', 'say:Przeczytaj słowo. Ma 3 litery.']);
    expect(document.activeElement).toBe(t.input);
    t.unmount();
  });

  it('a correct answer: tone, praise, session score, then the next word (cleared first)', async () => {
    const t = await mountMode();
    t.input.focus();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.log.length = 0;

    await vi.advanceTimersByTimeAsync(2300); // "reading" time, measured by ctx.now()
    t.submit(' KOT ');
    // Praise plus the request to lift the fingers before the next word (§4.9).
    expect(t.log).toEqual(['tone:correct', 'say:Dobrze, kot. Zdejmij palce.']);
    expect(t.input.value).toBe('');
    expect(document.activeElement).toBe(t.input);
    expect(t.root.querySelector('#words-score')?.textContent).toBe(
      'Wynik sesji: przeczytane 1 z 1, w tym 1 bez błędu i bez podpowiedzi.',
    );
    // Time from the ready signal to the answer, from ctx.now().
    expect(t.root.querySelector('#words-history li')?.textContent).toMatch(/^kot — dobrze, [23],\d s$/);
    expect(t.root.querySelector<HTMLElement>('#words-reveal')!.hidden).toBe(false);
    expect(t.root.querySelector('#words-reveal')?.textContent).toContain('Słowo: kot');

    await vi.advanceTimersByTimeAsync(2000 + 2000);
    // Next word "dom" (the only one not recent): blank first, then the word.
    expect(t.sent().slice(-2)).toEqual(['show', 'show,25,21,13']);
    expect(t.mock.cells).toEqual([25, 21, 13, 0, 0]);
    expect(t.said().at(-1)).toBe('Przeczytaj słowo. Ma 3 litery.');
    expect(t.said().filter((m) => m === 'Zdejmij palce.')).toEqual([]); // asked once, with the praise
    expect(t.root.querySelector<HTMLElement>('#words-reveal')!.hidden).toBe(true);
    t.unmount();
  });

  it('does not record course attempts', async () => {
    const record = vi.spyOn(session, 'recordAttempt');
    const persist = vi.spyOn(session, 'persist');
    const before = JSON.stringify(session.progress.toJSON());
    const t = await mountMode({ progress: progressUpTo('L4', true) });
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.submit('kos');
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(2000);
    t.submit('kot');
    await vi.advanceTimersByTimeAsync(3000);
    t.button('words-next').click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(record).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    // The shared course progress (what Kurs shows and saves) is untouched.
    expect(JSON.stringify(session.progress.toJSON())).toBe(before);
    t.unmount();
    record.mockRestore();
    persist.mockRestore();
  });

  it('a wrong answer: wrong tone, the word stays, the length is pointed out', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    const sentBefore = t.sent().length;
    t.log.length = 0;

    t.submit('kos');
    // Same length: the letter that does not match is named (§4.6).
    expect(t.log).toEqual([
      'tone:wrong',
      'say:Nie, to nie „kos”. Trzecia litera się nie zgadza. Spróbuj jeszcze raz. F2 daje podpowiedź.',
    ]);
    t.submit('ko');
    expect(t.said().at(-1)).toBe('Nie, to nie „ko”. Słowo ma 3 litery. Spróbuj jeszcze raz. F2 daje podpowiedź.');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.sent().length).toBe(sentBefore);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);

    t.submit('');
    expect(t.said().at(-1)).toBe('Wpisz słowo i naciśnij Enter. F2 daje podpowiedź.');

    t.submit('kot');
    expect(t.root.querySelector('#words-history li')?.textContent).toMatch(/^kot — dobrze, po 2 błędach/);
    expect(t.root.querySelector('#words-score')?.textContent).toBe(
      'Wynik sesji: przeczytane 1 z 1, w tym 0 bez błędu i bez podpowiedzi.',
    );
    t.unmount();
  });

  it('F2 hint ladder: blink, first letter, letters one by one on the device, the word', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.submit('kos');
    t.log.length = 0;
    const mark = t.sent().length;

    // 1: blink — hide, pause, rise again; then the ready tone.
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.sent().slice(mark)).toEqual(['show', 'show,5,21,30']);
    expect(t.log).toEqual(['tone:ready', 'say:Podpowiedź 1: mrugnięcie. Słowo wysunęło się ponownie. Ma 3 litery.']);

    // 2: first letter, spoken only.
    t.log.length = 0;
    const mark2 = t.sent().length;
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.log).toEqual(['tone:ready', 'say:Podpowiedź 2: pierwsza litera to ka.']);
    expect(t.sent().length).toBe(mark2); // the word is already up: nothing moves

    // 3: letters one by one — only the new letter's dots move each time.
    t.log.length = 0;
    const mark3 = t.sent().length;
    t.keys().hint!();
    // The lead is its own utterance, with time to be heard before the first
    // letter's name (a new say() would cut it off).
    expect(t.said()).toEqual(['Podpowiedź 3: litery po kolei.']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.said()).toHaveLength(1);
    await until(() => t.said().length === 2);
    // Each letter is named only after the device confirmed it.
    expect(t.said().at(-1)).toBe('pierwsza: ka');
    expect(t.mock.cells).toEqual([5, 0, 0, 0, 0]);
    await until(() => t.said().length === 3);
    expect(t.said().at(-1)).toBe('druga: o');
    expect(t.mock.cells).toEqual([5, 21, 0, 0, 0]);
    await until(() => t.said().length === 4);
    expect(t.said().at(-1)).toBe('trzecia: te');
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(t.log.includes('tone:ready')).toBe(false); // the letter still has its time
    await until(() => t.said().length === 5);
    expect(t.log.slice(-2)).toEqual(['tone:ready', 'say:Całe słowo jest na urządzeniu. Wpisz je.']);
    expect(t.sent().slice(mark3)).toEqual(['show', 'show,5', 'show,5,21', 'show,5,21,30']);

    // 4: the word; it stays on the device.
    t.log.length = 0;
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.log).toEqual([
      'tone:ready',
      'say:Podpowiedź 4: to słowo „kot”. Litery: ka, o, te. Naciśnij Enter, aby przejść do następnego słowa.',
    ]);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(t.root.querySelector('#words-score')?.textContent).toBe(
      'Wynik sesji: przeczytane 0 z 1, w tym 0 bez błędu i bez podpowiedzi.',
    );
    // No more hints; no auto-advance — the word waits for the learner.
    t.keys().hint!();
    expect(t.said().at(-1)).toMatch(/^To już ostatnia podpowiedź/);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);

    // Enter moves on, asking first to lift the fingers.
    t.submit('');
    expect(t.said().at(-1)).toBe('Zdejmij palce.');
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.mock.cells).toEqual([25, 21, 13, 0, 0]);
    expect(t.root.querySelector('#words-score')?.textContent).toMatch(/przeczytane 0 z 1/);
    t.unmount();
  });

  it('F2 pressed twice quickly: the blink is cut short but the word rises again', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.keys().hint!(); // 1: blink starts (clear, pause, show)
    await vi.advanceTimersByTimeAsync(100);
    t.keys().hint!(); // 2 during the blink
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(t.said().at(-1)).toBe('Podpowiedź 2: pierwsza litera to ka.');
    expect(t.said().some((m) => m.startsWith('Podpowiedź 1'))).toBe(false);
    t.unmount();
  });

  it('answering during hint 3 stops the spelling', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(2000);
    t.keys().hint!();
    t.keys().hint!(); // 3: spelling starts
    await vi.advanceTimersByTimeAsync(600);
    t.submit('kot');
    const said = t.said().length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.said().slice(said)).toEqual([]); // no "druga: o" after the answer
    expect(t.root.querySelector('#words-history li')?.textContent).toMatch(/^kot — dobrze, z podpowiedzią 3/);
    t.unmount();
  });

  it('F1 repeats the prompt without moving dots; F3 blinks', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    const mark = t.sent().length;
    t.log.length = 0;

    t.keys().repeat!();
    await vi.advanceTimersByTimeAsync(10);
    expect(t.log).toEqual(['tone:ready', 'say:Przeczytaj słowo. Ma 3 litery.']);
    expect(t.sent().length).toBe(mark); // identical display: skipped

    t.log.length = 0;
    t.keys().blink!();
    await vi.advanceTimersByTimeAsync(100);
    expect(t.log).toEqual([]); // prompt only after the word is back up
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.sent().slice(mark)).toEqual(['show', 'show,5,21,30']);
    expect(t.log).toEqual(['tone:ready', 'say:Mrugnięcie. Przeczytaj słowo. Ma 3 litery.']);
    t.unmount();
  });

  it('the on-screen buttons do the same and keep their focus', async () => {
    const t = await mountMode();
    const next = t.button('words-next');
    next.focus();
    next.click();
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.activeElement).toBe(next);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);

    const hint = t.button('words-hint');
    hint.focus();
    hint.click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.said().at(-1)).toMatch(/^Podpowiedź 1/);
    expect(document.activeElement).toBe(hint);

    // "Następne słowo" in the middle of a word skips it (counted as not read).
    next.click();
    expect(t.said().at(-1)).toBe('Zdejmij palce.');
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.mock.cells).toEqual([25, 21, 13, 0, 0]);
    expect(t.root.querySelector('#words-history li')?.textContent).toBe('kot — pominięte');
    expect(t.root.querySelector('#words-score')?.textContent).toMatch(/przeczytane 0 z 1/);
    t.unmount();
  });

  it('keys before the start and while the word rises only explain', async () => {
    const t = await mountMode();
    t.keys().hint!();
    expect(t.said().at(-1)).toMatch(/^Naciśnij Enter w polu odpowiedzi/);
    t.submit('');
    t.keys().repeat!();
    expect(t.said().at(-1)).toBe('Chwileczkę, słowo jeszcze się wysuwa.');
    t.submit('kot');
    expect(t.said().at(-1)).toMatch(/^Chwileczkę/);
    expect(t.log.some((l) => l.startsWith('tone:'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.log.slice(-2)).toEqual(['tone:ready', 'say:Przeczytaj słowo. Ma 3 litery.']);
    t.unmount();
  });

  it('with no words available it says how to get them and moves nothing', async () => {
    const t = await mountMode({ upTo: 'L0' });
    expect(t.root.querySelector('#words-pool')?.textContent).toBe(
      'Brak słów do ćwiczenia. Słowa pojawią się po odblokowaniu lekcji L1 (Litery a–e) — zalicz wcześniejszą lekcję w ćwiczeniu Rozpoznawanie.',
    );
    t.submit('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.said()).toEqual([
      'Brak słów do ćwiczenia. Słowa pojawią się po odblokowaniu lekcji L1 (Litery a–e) — zalicz wcześniejszą lekcję w ćwiczeniu Rozpoznawanie.',
    ]);
    t.keys().hint!();
    expect(t.said().at(-1)).toMatch(/^Brak słów/);
    expect(t.sent()).toEqual([]);
    t.unmount();
  });

  it('offers only words from open lessons', async () => {
    const t = await mountMode({ upTo: 'L3', list: ['kot', 'dom'], random: () => 0.99 });
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.mock.cells).toEqual([25, 21, 13, 0, 0]); // "kot" needs L4, still locked
    t.unmount();
  });

  it('without a device: explains, no ready tone, F1 retries once connected', async () => {
    const t = await mountMode({ connect: false });
    t.submit('');
    await vi.advanceTimersByTimeAsync(500);
    expect(t.log).toEqual([
      'say:Nie wysłano — najpierw połącz urządzenie albo włącz tryb symulacji. Gdy urządzenie będzie gotowe, naciśnij F1.',
    ]);
    t.submit('kot');
    expect(t.said().at(-1)).toMatch(/^Słowa nie ma na urządzeniu/);
    expect(t.log.some((l) => l.startsWith('tone:'))).toBe(false);

    t.link.attach(t.mock);
    await vi.advanceTimersByTimeAsync(50);
    t.log.length = 0;
    t.keys().repeat!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(t.log).toEqual(['tone:ready', 'say:Przeczytaj słowo. Ma 3 litery.']);
    t.submit('kot');
    expect(t.log.slice(-2)).toEqual(['tone:correct', 'say:Dobrze, kot. Zdejmij palce.']);
    t.unmount();
  });

  it('never changes the cascade speed', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(2000);
    t.keys().hint!();
    t.keys().hint!();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.sent().some((l) => l.startsWith('anim'))).toBe(false);
    t.unmount();
  });

  it('cleanup unregisters the keys, empties the root and cancels pending work', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(1500);
    t.submit('kot'); // the next word is scheduled
    t.unmount();
    expect(t.setKeysCalls.at(-1)).toBeNull();
    expect(t.root.childElementCount).toBe(0);
    const sent = t.sent().length;
    const logged = t.log.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.sent().length).toBe(sent);
    expect(t.log.length).toBe(logged);
  });

  it('cleanup in the middle of a new word stops it before the prompt', async () => {
    const t = await mountMode();
    t.submit('');
    await vi.advanceTimersByTimeAsync(100); // pausing after the clear
    t.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.sent()).toEqual([]);
    expect(t.log).toEqual([]);
  });
});
