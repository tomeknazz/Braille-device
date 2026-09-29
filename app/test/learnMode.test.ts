// @vitest-environment happy-dom
// Mode "Poznaj znak" driven through DeviceLink + MockDevice with fake timers
// and a fake ModeContext that records what the learner would hear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLink } from '../src/device/DeviceLink';
import { MockDevice } from '../src/device/MockDevice';
import { curriculum, lessonById } from '../src/learn/curriculum';
import { progress } from '../src/learn/session';
import {
  baseNote,
  BLINK_MS,
  describeItem,
  describePositions,
  dotsPhrase,
  learnMode,
  mirrorMask,
  mirrorNote,
  ruleIntro,
} from '../src/modes/learn';
import type { KeyHandlers, ModeContext } from '../src/modes/types';

/** Lines without the " #<seq>" request tag. */
const untag = (lines: string[]) => lines.map((l) => l.replace(/ #\d+$/, ''));
/** Commands that change what the learner feels (no keepalive pings). */
const motion = (lines: string[]) => lines.filter((l) => l !== 'ping');

interface Harness {
  mock: MockDevice;
  link: DeviceLink;
  ctx: ModeContext;
  said: string[];
  tones: string[];
  /** say/tone in call order, e.g. "say:To jest a. Punkt 1." / "tone:ready". */
  events: string[];
  keyCalls: (KeyHandlers | null)[];
  keys(): KeyHandlers;
  root: HTMLElement;
  unmount: () => void;
  sent(): string[];
  button(id: string): HTMLButtonElement;
  select(): HTMLSelectElement;
  lastSaid(): string | undefined;
}

function makeCtx(link: DeviceLink) {
  const said: string[] = [];
  const tones: string[] = [];
  const events: string[] = [];
  const keyCalls: (KeyHandlers | null)[] = [];
  const say = (m: string) => {
    said.push(m);
    events.push(`say:${m}`);
  };
  const ctx: ModeContext = {
    link,
    announce: say,
    say,
    tone: (k) => {
      tones.push(k);
      events.push(`tone:${k}`);
    },
    setKeys: (h) => keyCalls.push(h),
    now: () => 0,
  };
  return { ctx, said, tones, events, keyCalls };
}

async function mountLearn(opts: { connect?: boolean } = {}): Promise<Harness> {
  const mock = new MockDevice({ resetOnOpen: false });
  const link = new DeviceLink();
  if (opts.connect !== false) {
    link.attach(mock);
    await vi.advanceTimersByTimeAsync(50);
    expect(link.state).toBe('ready');
  }
  const start = mock.received.length;
  const { ctx, said, tones, events, keyCalls } = makeCtx(link);
  const root = document.createElement('div');
  document.body.append(root);
  const unmount = learnMode.mount(root, ctx);
  return {
    mock,
    link,
    ctx,
    said,
    tones,
    events,
    keyCalls,
    keys: () => {
      const k = keyCalls[keyCalls.length - 1];
      if (!k) throw new Error('no keys registered');
      return k;
    },
    root,
    unmount,
    sent: () => untag(mock.received.slice(start)),
    button: (id) => root.querySelector<HTMLButtonElement>(`#${id}`)!,
    select: () => root.querySelector<HTMLSelectElement>('#learn-lesson')!,
    lastSaid: () => said[said.length - 1],
  };
}

function choose(h: Harness, lessonId: string): void {
  const sel = h.select();
  sel.value = lessonId;
  sel.dispatchEvent(new Event('change'));
}

let current: Harness | null = null;
async function setup(opts: { connect?: boolean; teacher?: boolean } = {}): Promise<Harness> {
  if (opts.teacher) progress.setTeacherUnlocked(true);
  current = await mountLearn(opts);
  return current;
}

beforeEach(() => {
  vi.useFakeTimers();
  progress.reset();
});
afterEach(() => {
  current?.unmount();
  current?.root.remove();
  current = null;
  progress.reset();
  vi.useRealTimers();
});

const L0 = lessonById('L0')!;
const L1 = lessonById('L1')!;
const L2 = lessonById('L2')!;
const L3 = lessonById('L3')!;
const L5 = lessonById('L5')!;

describe('texts', () => {
  it('names letters and their dots', () => {
    expect(describeItem(L3, L3.items[2]!)).toBe('To jest em. Punkty 1, 3, 4. Em to ce z dodanym punktem 3.');
    expect(describeItem(L1, L1.items[0]!)).toBe('To jest a. Punkt 1.');
  });

  it('describes the position of an L0 dot', () => {
    expect(describeItem(L0, L0.items[2]!)).toBe('Punkt 3. Lewa kolumna, na dole.');
    expect(describeItem(L0, L0.items[0]!)).toBe('Punkt 1. Lewa kolumna, na górze.');
    expect(describeItem(L0, L0.items[4]!)).toBe('Punkt 5. Prawa kolumna, pośrodku.');
    expect(describePositions(L0, L0.items[5]!)).toMatch(/^Punkt 6 to dolny punkt prawej kolumny/);
  });

  it('F2 text lists every dot with its place', () => {
    expect(describePositions(L3, L3.items[2]!)).toBe(
      'Litera em ma 3 punkty: 1 — lewa kolumna, na górze; 3 — lewa kolumna, na dole; 4 — prawa kolumna, na górze.',
    );
    expect(describePositions(L1, L1.items[0]!)).toBe('Litera a ma 1 punkt: 1 — lewa kolumna, na górze.');
  });

  it('mirror pairs are named once the partner is known', () => {
    expect(mirrorMask(0b010001)).toBe(0b001010); // e (1,5) <-> i (2,4)
    const e = L1.items[4]!;
    const i = L2.items[3]!;
    expect(mirrorNote(L1, e)).toBe(''); // i not learnt yet
    expect(mirrorNote(L2, i)).toBe('Uwaga: to lustrzane odbicie litery e.');
    expect(describeItem(L2, L2.items[0]!)).toBe('To jest ef. Punkty 1, 2, 4. Uwaga: to lustrzane odbicie litery de.');
    expect(mirrorNote(L1, L1.items[2]!)).toBe(''); // c is symmetric
  });

  it('phrases the rule with one or two added dots', () => {
    expect(ruleIntro(L1, [3], 'Dodaj punkt 3')).toBe(
      'To są litery a, be, ce, de, e. Teraz na każdej komórce wysunie się punkt 3. ' +
        'Połóż palce lekko na komórkach, bez nacisku, i naciśnij „Dodaj punkt 3”. Punkty wysuwają się powoli.',
    );
    expect(ruleIntro(L1, [3, 6], 'x')).toContain('wysuną się punkty 3 i 6.');
    expect(dotsPhrase(13)).toBe('Punkty 1, 3, 4.');
  });

  it('connects a letter to the letter it is built from (rules, then Polish + dot 6)', () => {
    const L4 = lessonById('L4')!;
    const L6 = lessonById('L6')!;
    const L7 = lessonById('L7')!;
    const byAnswer = (l: typeof L6, a: string) => l.items.find((i) => i.answer === a)!;
    expect(baseNote(L3, L3.items[0]!)).toBe('Ka to a z dodanym punktem 3.');
    expect(baseNote(L4, byAnswer(L4, 't'))).toBe('Te to jot z dodanym punktem 3.');
    expect(baseNote(L5, L5.items[0]!)).toBe('U to a z dodanymi punktami 3 i 6.');
    expect(baseNote(L6, byAnswer(L6, 'ą'))).toBe('A z ogonkiem to a z dodanym punktem 6.');
    expect(baseNote(L6, byAnswer(L6, 'ł'))).toBe('Eł to be z dodanym punktem 6.'); // shape, not sound
    expect(baseNote(L7, byAnswer(L7, 'ż'))).toBe('Zet z kropką to pe z dodanym punktem 6.');
    expect(baseNote(L6, byAnswer(L6, 'w'))).toBe(''); // w is the exception
    expect(baseNote(L7, byAnswer(L7, 'ó'))).toBe(''); // 34 is not a letter
    expect(baseNote(L1, L1.items[0]!)).toBe('');
    expect(baseNote(L0, L0.items[0]!)).toBe('');
    // The base relation (memory hook) comes before the mirror warning.
    expect(describeItem(L6, byAnswer(L6, 'ć'))).toBe(
      'To jest ce z kreską. Punkty 1, 4, 6. Ce z kreską to ce z dodanym punktem 6. Uwaga: to lustrzane odbicie litery em.',
    );
  });
});

describe('lesson picker', () => {
  it('lists only unlocked lessons and starts at the current one', async () => {
    const h = await setup();
    const options = [...h.select().options].map((o) => o.value);
    expect(options).toEqual(['L0']);
    expect(h.select().value).toBe(progress.current().id);
    expect(h.root.querySelector('label[for="learn-lesson"]')?.textContent).toBe('Lekcja');
    expect(h.button('learn-rule').hidden).toBe(true);
  });

  it('defaults to the next lesson once L0 is passed', async () => {
    for (let n = 0; n < curriculum.unlock.window; n++) {
      progress.record({ lessonId: 'L0', itemKey: 'dot1', correct: true, ms: 1000, at: n });
    }
    const h = await setup();
    expect([...h.select().options].map((o) => o.textContent)).toEqual([
      'L0: Orientacja: punkty 1–6 (zaliczona)',
      'L1: Litery a–e',
    ]);
    expect(h.select().value).toBe('L1');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 1, 0, 0, 0]);
    expect(h.lastSaid()).toBe('To jest a. Punkt 1.');
  });

  it('teacher unlock lists all lessons; changing lesson moves nothing until F1', async () => {
    const h = await setup({ teacher: true });
    expect(h.select().options).toHaveLength(curriculum.lessons.length);
    await vi.advanceTimersByTimeAsync(500);
    const before = h.sent().length;
    choose(h, 'L3');
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sent().length).toBe(before);
    expect(h.mock.cells).toEqual([0, 1, 0, 0, 0]);
    expect(h.lastSaid()).toBe(`Lekcja L3 wybrana. ${L3.note} Naciśnij Powtórz (F1), aby pokazać pierwszy znak.`);
    expect(h.root.querySelector('#learn-item-text')?.textContent).toMatch(/^Znak 1 z 5: k \(ka\)/);
    expect(h.root.querySelector('#learn-lesson-note')?.textContent).toBe(L3.note);
    expect(h.button('learn-rule').hidden).toBe(false);
    h.keys().repeat!();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 5, 0, 0, 0]);
    expect(h.events.slice(-2)).toEqual(['say:To jest ka. Punkty 1, 3. Ka to a z dodanym punktem 3.', 'tone:ready']);
  });

  it('arrowing through the lessons stays quiet: no moves, one announcement at the end', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    const said = h.said.length;
    const before = h.sent().length;
    const focus = h.select();
    focus.focus();
    for (const id of ['L1', 'L2', 'L3', 'L4', 'L5']) {
      choose(h, id);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.said.length).toBe(said);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.said.slice(said)).toEqual([`Lekcja L5 wybrana. ${L5.note} Naciśnij Powtórz (F1), aby pokazać pierwszy znak.`]);
    expect(h.sent().length).toBe(before);
    expect(document.activeElement).toBe(focus);
  });

  it('F1 right after choosing a lesson drops the pending announcement', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L1');
    h.keys().repeat!();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.mock.cells).toEqual([0, 1, 0, 0, 0]);
    expect(h.lastSaid()).toBe('To jest a. Punkt 1.');
    expect(h.said.some((m) => m.startsWith('Lekcja L1 wybrana'))).toBe(false);
  });
});

describe('presenting an item', () => {
  it('shows the item on cell 2 and speaks only after the device confirmed it', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(5);
    expect(h.said).toEqual([]); // the dots are still moving
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 1, 0, 0, 0]);
    expect(h.sent()).toEqual(['show,0,1']);
    expect(h.events).toEqual(['say:Punkt 1. Lewa kolumna, na górze.', 'tone:ready']);
    expect(h.root.querySelector('#learn-item-text')?.textContent).toBe('Znak 1 z 6: punkt 1 — lewa kolumna, na górze.');
  });

  it('steps with Następny / Poprzedni and announces the ends without moving', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    const prev = h.button('learn-prev');
    const next = h.button('learn-next');
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    prev.click();
    expect(h.lastSaid()).toBe('To jest pierwszy znak tej lekcji.');

    next.focus();
    next.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 2, 0, 0, 0]);
    expect(h.lastSaid()).toBe('Punkt 2. Lewa kolumna, pośrodku.');
    expect(document.activeElement).toBe(next); // focus stays on the control used
    expect(prev.getAttribute('aria-disabled')).toBe('false');

    for (let i = 0; i < 4; i++) {
      next.click();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(h.lastSaid()).toBe('Punkt 6. Prawa kolumna, na dole.');
    expect(next.getAttribute('aria-disabled')).toBe('true');
    const moves = h.sent().length;
    next.click();
    expect(h.lastSaid()).toMatch(/^To jest ostatni znak tej lekcji/);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent().length).toBe(moves);
    expect(document.activeElement).toBe(next);

    prev.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 16, 0, 0, 0]);
  });

  it('F1 repeats: re-says when the item is still there, re-shows when it is not', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    const before = h.sent().length;
    h.keys().repeat!();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent().length).toBe(before); // identical display: nothing sent
    expect(h.events.slice(-2)).toEqual(['say:Punkt 1. Lewa kolumna, na górze.', 'tone:ready']);

    h.button('learn-whole').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.cells).toEqual([1, 2, 4, 8, 16]);
    h.button('learn-repeat').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.cells).toEqual([0, 1, 0, 0, 0]);
    expect(h.lastSaid()).toBe('Punkt 1. Lewa kolumna, na górze.');
  });

  it('F2 describes the dot positions without moving anything', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    await vi.advanceTimersByTimeAsync(500);
    const before = h.sent().length;
    h.keys().hint!();
    expect(h.lastSaid()).toBe('Litera ka ma 2 punkty: 1 — lewa kolumna, na górze; 3 — lewa kolumna, na dole.');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.sent().length).toBe(before);
  });

  it('tells the learner to connect when the device is not connected', async () => {
    const h = await setup({ connect: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.said).toEqual(['Nie wysłano — najpierw połącz urządzenie albo włącz tryb symulacji.']);
    expect(h.tones).toEqual([]);
    h.button('learn-dots').click();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.lastSaid()).toMatch(/najpierw połącz urządzenie/);
    expect(h.tones).toEqual([]);
    // The failed sequence released its lock.
    h.button('learn-next').click();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.lastSaid()).toMatch(/najpierw połącz urządzenie/);
  });
});

describe('dot by dot, blink, whole lesson', () => {
  it('Punkt po punkcie: clears, then raises and names one dot at a time', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    h.button('learn-next').click();
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-next').click(); // em
    await vi.advanceTimersByTimeAsync(500);
    const from = h.sent().length;
    const said = h.said.length;

    // Each dot is named only once it stands, and while it is the newest one.
    const heard: [string, number[]][] = [];
    const say = h.ctx.say;
    h.ctx.say = (m) => {
      heard.push([m, [...h.mock.cells]]);
      say(m);
    };
    h.button('learn-dots').click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.sent().slice(from)).toEqual(['show', 'show,0,1', 'show,0,5', 'show,0,13']); // no anim needed
    expect(heard).toEqual([
      ['Punkt po punkcie.', [0, 13, 0, 0, 0]], // before anything moves
      ['Punkt 1.', [0, 1, 0, 0, 0]],
      ['Punkt 3.', [0, 5, 0, 0, 0]],
      ['Punkt 4.', [0, 13, 0, 0, 0]],
      ['To jest em. Punkty 1, 3, 4. Em to ce z dodanym punktem 3.', [0, 13, 0, 0, 0]],
    ]);
    expect(h.said.length).toBe(said + 5);
    expect(h.tones[h.tones.length - 1]).toBe('ready');
    expect(h.mock.stepMs).toBe(20);
  });

  it('Punkt po punkcie can be interrupted by Następny', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    h.keys().repeat!(); // ka
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-dots').click();
    await vi.advanceTimersByTimeAsync(700);
    expect(h.lastSaid()).toBe('Punkt 1.');
    h.button('learn-next').click(); // el
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.mock.cells).toEqual([0, 7, 0, 0, 0]);
    expect(h.lastSaid()).toBe('To jest el. Punkty 1, 2, 3. El to be z dodanym punktem 3.');
    expect(h.said).not.toContain('Punkt 3.');
  });

  it('blocks other device actions while the slow rule cascade runs', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(1000);
    const from = h.sent().length;
    h.button('learn-rule').click(); // + dot 3, slow
    await vi.advanceTimersByTimeAsync(300);
    expect(h.mock.stepMs).toBe(400);
    h.button('learn-next').click();
    expect(h.lastSaid()).toBe('Poczekaj, punkty jeszcze się wysuwają.');
    choose(h, 'L1');
    expect(h.select().value).toBe('L3');
    expect(h.lastSaid()).toBe('Poczekaj, punkty jeszcze się wysuwają.');
    await vi.advanceTimersByTimeAsync(3000);
    expect(motion(h.sent().slice(from))).toEqual(['anim,400', 'show,5,7,13,29,21', 'anim,0']);
    expect(h.root.querySelector('#learn-item-text')?.textContent).toMatch(/^Znak 1 z 5/);
    expect(h.lastSaid()).toBe('Powstały litery ka, el, em, en, o.');
    expect(h.mock.stepMs).toBe(20);
    // Afterwards it works again.
    h.button('learn-next').click();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 7, 0, 0, 0]);
  });

  it('F3 right after Następny blinks the new item, not the one it replaces', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-next').click();
    h.keys().blink!(); // before the device confirmed punkt 2
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.mock.cells).toEqual([0, 2, 0, 0, 0]);
    expect(h.root.querySelector('#learn-item-text')?.textContent).toMatch(/^Znak 2 z 6: punkt 2/);
    expect(h.lastSaid()).toBe('Wysunięte ponownie: punkt 2.');
    expect(h.said).not.toContain('Wysunięte ponownie: punkt 1.');
  });

  it('F3 blinks: dots down, 300 ms pause, up again, then the ready tone', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    const from = h.sent().length;
    h.keys().blink!();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.mock.cells).toEqual([0, 0, 0, 0, 0]);
    await vi.advanceTimersByTimeAsync(BLINK_MS - 100);
    expect(h.mock.cells).toEqual([0, 0, 0, 0, 0]);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.mock.cells).toEqual([0, 1, 0, 0, 0]);
    expect(h.sent().slice(from)).toEqual(['show', 'show,0,1']);
    expect(h.events.slice(-2)).toEqual(['say:Wysunięte ponownie: punkt 1.', 'tone:ready']);
  });

  it('Cała lekcja pages L0 (dots 1-5, then 6) and keeps focus on the button', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    const whole = h.button('learn-whole');
    expect(whole.textContent).toBe('Cała lekcja (1/2)');
    whole.focus();
    whole.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.cells).toEqual([1, 2, 4, 8, 16]);
    expect(h.lastSaid()).toBe(
      'Na kolejnych komórkach od lewej: punkt 1, punkt 2, punkt 3, punkt 4, punkt 5. ' +
        'Dalej jest punkt 6. Naciśnij „Cała lekcja” jeszcze raz.',
    );
    expect(whole.textContent).toBe('Cała lekcja (2/2)');
    expect(document.activeElement).toBe(whole);

    whole.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.cells).toEqual([32, 0, 0, 0, 0]);
    expect(h.lastSaid()).toBe('Na kolejnych komórkach od lewej: punkt 6. To koniec lekcji, strona 2 z 2.');
    expect(whole.textContent).toBe('Cała lekcja (1/2)');
    expect(h.tones.every((t) => t === 'ready')).toBe(true);
  });

  it('Cała lekcja for a letter lesson names the letters', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L1');
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-whole').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.cells).toEqual(L1.items.map((i) => i.mask));
    expect(h.lastSaid()).toBe('Lekcja L1 na komórkach od lewej: a, be, ce, de, e.');
    // Blink repeats what is on the device: the whole row.
    h.keys().blink!();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.mock.cells).toEqual(L1.items.map((i) => i.mask));
    expect(h.lastSaid()).toBe('Wysunięte ponownie: a, be, ce, de, e.');
  });
});

describe('rule animation', () => {
  it('a–e, then on the learner’s key press dot 3 rises on every cell -> k–o', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    await vi.advanceTimersByTimeAsync(500);
    const rule = h.button('learn-rule');
    rule.focus();
    const from = h.sent().length;

    rule.click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.cells).toEqual([1, 3, 9, 25, 17]);
    expect(h.events.slice(-2)).toEqual([
      'say:To są litery a, be, ce, de, e. Teraz na każdej komórce wysunie się punkt 3. ' +
        'Połóż palce lekko na komórkach, bez nacisku, i naciśnij „Dodaj punkt 3”. Punkty wysuwają się powoli.',
      'tone:ready',
    ]);
    expect(rule.textContent).toBe('Dodaj punkt 3');

    // No timer moves anything: the learner decides when.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.mock.cells).toEqual([1, 3, 9, 25, 17]);

    const sentBefore = h.mock.sent.length;
    rule.click();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.mock.stepMs).toBe(400);
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.mock.cells).toEqual([5, 7, 13, 29, 21]);
    expect(motion(h.sent().slice(from))).toEqual(['show,1,3,9,25,17', 'anim,400', 'show,5,7,13,29,21', 'anim,0']);
    // Only the five added dots moved.
    expect(h.mock.sent.slice(sentBefore).find((l) => l.startsWith('OK show'))).toMatch(/moved=5 ms=1720/);
    expect(h.mock.stepMs).toBe(20);
    expect(h.events.slice(-2)).toEqual(['say:Powstały litery ka, el, em, en, o.', 'tone:ready']);
    expect(rule.textContent).toBe('Pokaż regułę');
    expect(document.activeElement).toBe(rule);
  });

  it('L5 adds dots 3 and 6 to a–e', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L5');
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.lastSaid()).toContain('Teraz na każdej komórce wysuną się punkty 3 i 6.');
    expect(h.button('learn-rule').textContent).toBe('Dodaj punkty 3 i 6');
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.mock.cells).toEqual(L5.items.map((i) => i.mask));
    expect(h.lastSaid()).toBe('Powstały litery u, fał, iks, igrek, zet.');
  });

  it('another action cancels the waiting rule step', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.button('learn-rule').textContent).toBe('Dodaj punkt 3');
    h.button('learn-repeat').click();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.button('learn-rule').textContent).toBe('Pokaż regułę');
    expect(h.mock.cells).toEqual([0, 5, 0, 0, 0]);
  });

  it('has no rule button for lessons without a rule', async () => {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    for (const id of ['L0', 'L1', 'L2', 'L6', 'L7']) {
      choose(h, id);
      expect(h.button('learn-rule').hidden).toBe(true);
    }
    for (const id of ['L3', 'L4', 'L5']) {
      choose(h, id);
      expect(h.button('learn-rule').hidden).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(1000);
  });
});

describe('cleanup', () => {
  it('registers F1/F2/F3 and removes them on unmount', async () => {
    const h = await setup();
    const k = h.keys();
    expect(typeof k.repeat).toBe('function');
    expect(typeof k.hint).toBe('function');
    expect(typeof k.blink).toBe('function');
    expect(h.button('learn-repeat').getAttribute('aria-keyshortcuts')).toBe('F1');
    await vi.advanceTimersByTimeAsync(500);
    h.unmount();
    expect(h.keyCalls[h.keyCalls.length - 1]).toBeNull();
    expect(h.root.childElementCount).toBe(0);
    current = null;
  });

  /** L3, rule shown, then "Dodaj punkt 3" pressed: the slow cascade is running. */
  async function midRuleCascade(): Promise<Harness> {
    const h = await setup({ teacher: true });
    await vi.advanceTimersByTimeAsync(500);
    choose(h, 'L3');
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(1000);
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.mock.stepMs).toBe(400);
    return h;
  }

  it('restores anim 0 when unmounted in the middle of the slow cascade and stays silent', async () => {
    const h = await midRuleCascade();
    const said = h.said.length;
    h.unmount();
    current = null;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.mock.stepMs).toBe(20);
    expect(h.link.animMs).toBe(20);
    expect(h.sent().filter((l) => l === 'anim,0')).toHaveLength(1);
    expect(h.said.length).toBe(said);
  });

  it('retries anim 0 after a reconnect when the link dropped during the slow cascade', async () => {
    const h = await midRuleCascade();
    h.link.detach(); // "Rozłącz": the show and the anim 0 are cancelled
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.mock.stepMs).toBe(400); // the firmware keeps the slow step
    expect(h.sent().filter((l) => l === 'anim,0')).toHaveLength(0);
    h.unmount(); // the retry outlives the mode
    current = null;
    h.link.attach(h.mock);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.link.state).toBe('ready');
    expect(h.sent().filter((l) => l === 'anim,0')).toHaveLength(1);
    expect(h.mock.stepMs).toBe(20);
    expect(h.link.animMs).toBe(20);
    // Restored: a later reconnect sends nothing more.
    h.link.detach();
    h.link.attach(h.mock);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sent().filter((l) => l === 'anim,0')).toHaveLength(1);
  });

  it('retries anim 0 on reconnect while the mode stays mounted', async () => {
    const h = await midRuleCascade();
    h.link.detach();
    await vi.advanceTimersByTimeAsync(3000);
    h.link.attach(h.mock);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.mock.stepMs).toBe(20);
    // The interrupted step can be retried at the slow pace, and is restored afterwards.
    expect(h.button('learn-rule').textContent).toBe('Dodaj punkt 3');
    const from = h.sent().length;
    h.button('learn-rule').click();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.sent().slice(from)).toContain('anim,400');
    expect(h.sent().slice(from).pop()).toBe('anim,0');
    expect(h.lastSaid()).toBe('Powstały litery ka, el, em, en, o.');
    expect(h.mock.cells).toEqual([5, 7, 13, 29, 21]);
    expect(h.mock.stepMs).toBe(20);
  });

  it('cancels a pending blink on unmount', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    h.keys().blink!();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.mock.cells).toEqual([0, 0, 0, 0, 0]);
    h.unmount();
    current = null;
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.mock.cells).toEqual([0, 0, 0, 0, 0]);
    expect(h.lastSaid()).toBe('Punkt 1. Lewa kolumna, na górze.');
  });

  it('does not record attempts', async () => {
    const h = await setup();
    await vi.advanceTimersByTimeAsync(500);
    h.button('learn-next').click();
    await vi.advanceTimersByTimeAsync(500);
    expect(progress.attempts('L0')).toHaveLength(0);
  });
});
