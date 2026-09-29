// @vitest-environment happy-dom
// Mode "Powtórki" (Leitner review): the Rozpoznawanie trial fed by a review
// plan. Driven through DeviceLink + MockDevice with fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { letterForMask, maskToDots } from '../src/braille/table';
import { DeviceLink } from '../src/device/DeviceLink';
import { MockDevice } from '../src/device/MockDevice';
import { cardKey } from '../src/learn/leitner';
import { leitner, progress, recordAttempt, recordReview, resetAll } from '../src/learn/session';
import { createRecognizeMode, recognizeMode, reviewMode } from '../src/modes/recognize';
import type { KeyHandlers, ModeContext } from '../src/modes/types';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}
const input = () => $('recognize-answer') as HTMLInputElement;

interface Harness {
  said: string[];
  tones: string[];
  confirmed: number[][];
  unmount(): void;
}

async function mount(reviewSize: number, variant: 'review' | 'lesson' = 'review'): Promise<Harness> {
  const mock = new MockDevice({ resetOnOpen: false });
  const link = new DeviceLink();
  link.attach(mock);
  await vi.advanceTimersByTimeAsync(500);
  const said: string[] = [];
  const tones: string[] = [];
  const confirmed: number[][] = [];
  link.on('confirmed', (m) => m && confirmed.push(m));
  const clock = { t: 1000 };
  const ctx: ModeContext = {
    link,
    announce: (m) => said.push(m),
    say: (m) => said.push(m),
    tone: (k) => tones.push(k),
    setKeys: (_h: KeyHandlers | null) => {},
    now: () => clock.t,
  };
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const unmount = createRecognizeMode({ variant, reviewSize, random: () => 0, nextDelayMs: 100 }).mount(root, ctx);
  return { said, tones, confirmed, unmount };
}

/** The correct answer for what is on cell 2 now, judged by the last prompt. */
function rightAnswer(h: Harness): string {
  const mask = h.confirmed[h.confirmed.length - 1]![1]!;
  const dotsPrompt = h.said.some((s) => s.startsWith('Który punkt'));
  const lastPrompt = [...h.said].reverse().find((s) => s === 'Jaki to znak?' || s === 'Który punkt jest wysunięty?');
  if (lastPrompt === 'Który punkt jest wysunięty?' || (!lastPrompt && dotsPrompt)) return String(maskToDots(mask)[0]);
  return letterForMask(mask)!.char;
}

function type(value: string): void {
  input().value = value;
  input().form!.requestSubmit();
}

/** L0 passed, so L1 is the current lesson and both are available. */
function passL0(): void {
  for (let i = 0; i < 20; i++) recordAttempt({ lessonId: 'L0', itemKey: 'dot1', correct: true, ms: 1000, at: i });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetAll();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('Powtórki', () => {
  it('is a separate mode with its own id and no lesson picker', async () => {
    expect(reviewMode.id).toBe('review');
    expect(reviewMode.title).toBe('Powtórki');
    const h = await mount(4);
    expect(document.getElementById('recognize-lesson')).toBeNull();
    expect($('recognize-lesson-stats').textContent).toMatch(/Pudełka Leitnera: jeszcze żaden znak nie był ćwiczony\. Sesja powtórek nr 1/);
    h.unmount();
  });

  it('announces the plan, then runs trials that move Leitner cards', async () => {
    passL0();
    const h = await mount(4);
    ($('recognize-start') as HTMLButtonElement).click();
    expect(h.said[0]).toMatch(/^Sesja powtórek: 4 próby\. Zaległe: 0, z bieżącej lekcji: \d+, nowe: \d+\./);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.tones).toContain('ready');

    const answer = rightAnswer(h);
    type(answer);
    const key = cardKey(answer.length === 1 && /\d/.test(answer) ? `dot${answer}` : answer);
    expect(leitner.cards[key]).toMatchObject({ box: 2, seen: 1, correct: 1 });
    h.unmount();
  });

  it('records course attempts only for the current lesson', async () => {
    passL0();
    const before = { L0: progress.attempts('L0').length, L1: progress.attempts('L1').length };
    const h = await mount(6);
    ($('recognize-start') as HTMLButtonElement).click();
    let l0 = 0;
    let l1 = 0;
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      const a = rightAnswer(h);
      if (/^\d$/.test(a)) l0++;
      else l1++;
      type(a);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(l0 + l1).toBe(6);
    expect(l0).toBeGreaterThan(0); // the plan did include an item of the passed lesson
    expect(l1).toBeGreaterThan(0);
    expect(progress.attempts('L0').length).toBe(before.L0); // passed lesson: Leitner only
    expect(progress.attempts('L1').length).toBe(before.L1 + l1);
    h.unmount();
  });

  it('a wrong answer sends the card to box 1 and brings it back later in the session', async () => {
    const h = await mount(3);
    ($('recognize-start') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    const right = rightAnswer(h);
    const wrong = right === '1' ? '2' : '1';
    type(wrong);
    expect(leitner.cards[cardKey(`dot${right}`)]).toMatchObject({ box: 1, correct: 0 });
    // Finish this trial (answer, contrast, Dalej) and count how often the card returns.
    type(right);
    await vi.advanceTimersByTimeAsync(1000);
    type('');
    let seenAgain = 0;
    let previous = right;
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      if (!($('recognize-start') as HTMLButtonElement).disabled) break; // session over
      const a = rightAnswer(h);
      expect(a).not.toBe(previous); // never the same card back to back
      if (a === right) seenAgain++;
      type(a);
      previous = a;
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(seenAgain).toBe(1);
    h.unmount();
  });

  it('ends by itself after the planned trials, advances the session and summarises', async () => {
    const h = await mount(2);
    ($('recognize-start') as HTMLButtonElement).click();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      type(rightAnswer(h));
      await vi.advanceTimersByTimeAsync(300);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(leitner.session).toBe(2);
    expect(h.said[h.said.length - 1]).toMatch(
      /^Sesja powtórek zakończona\. Poprawnie 2 z 2\. Do wyższego pudełka przeszło: 2, do pudełka 1 wróciło: 0\. Na następną sesję czeka: 0\.$/,
    );
    expect(h.tones).not.toContain('unlock'); // that earcon is kept for unlocked lessons
    expect(($('recognize-start') as HTMLButtonElement).disabled).toBe(false);
    h.unmount();
  });

  it('a session left without Stop is closed when the next one starts', async () => {
    const h = await mount(10);
    ($('recognize-start') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    type(rightAnswer(h));
    await vi.advanceTimersByTimeAsync(300);
    h.unmount(); // switching modes / closing the tab
    expect(leitner.session).toBe(1);
    const again = await mount(10);
    ($('recognize-start') as HTMLButtonElement).click();
    expect(leitner.session).toBe(2);
    again.unmount();
  });

  it('Rozpoznawanie moves Leitner cards too, and resetAll clears them', async () => {
    expect(recognizeMode.id).toBe('recognize');
    const h = await mount(10, 'lesson');
    ($('recognize-start') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    type(rightAnswer(h));
    expect(Object.keys(leitner.cards)).toHaveLength(1);
    expect(leitner.session).toBe(1); // only Powtórki count sessions
    h.unmount();
    recordReview(cardKey('a'), 'wrong', 1);
    resetAll();
    expect(leitner).toMatchObject({ session: 1, cards: {}, recentMs: [] });
  });

  it('stopping early still closes the session when something was answered', async () => {
    const h = await mount(10);
    ($('recognize-start') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    ($('recognize-stop') as HTMLButtonElement).click();
    expect(leitner.session).toBe(1); // nothing answered yet
    ($('recognize-start') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    type(rightAnswer(h));
    await vi.advanceTimersByTimeAsync(300);
    ($('recognize-stop') as HTMLButtonElement).click();
    expect(leitner.session).toBe(2);
    expect(h.said[h.said.length - 1]).toMatch(/Koniec sesji\. Poprawnie 1 z 1\. Do wyższego pudełka przeszło: 1/);
    h.unmount();
  });
});
