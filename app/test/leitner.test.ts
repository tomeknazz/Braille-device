import { describe, expect, it } from 'vitest';
import {
  cardKey,
  dueCount,
  emptyLeitner,
  endSession,
  FAST_MAX_MS,
  fastLimitMs,
  isDue,
  MIN_TIMING_SAMPLES,
  planSession,
  requeueIndex,
  review,
  sessionTouched,
  sanitizeLeitner,
  spreadRepeats,
  type Candidate,
  type LeitnerState,
} from '../src/learn/leitner';

const K = (ch: string) => cardKey(ch);

/** A deterministic pseudo-random sequence in [0, 1). */
function seeded(seed = 1): () => number {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x - 1) / 2147483646;
  };
}

function withCard(state: LeitnerState, ch: string, box: 1 | 2 | 3 | 4 | 5, lastSession: number): void {
  state.cards[K(ch)] = { box, lastSession, seen: 1, correct: 1 };
}

describe('review (box moves)', () => {
  it('a new card answered cleanly and fast goes to box 2; wrong starts in box 1', () => {
    const s = emptyLeitner();
    expect(review(s, K('a'), 'correct', 2000)).toEqual({ key: K('a'), from: null, to: 2, move: 'up' });
    expect(review(s, K('b'), 'wrong', 2000)).toEqual({ key: K('b'), from: null, to: 1, move: 'reset' });
  });

  it('correct + fast moves a DUE card up one box, up to 5', () => {
    const s = emptyLeitner();
    s.session = 9; // box 4 is due 8 sessions after session 1
    withCard(s, 'a', 4, 1);
    expect(review(s, K('a'), 'correct', 1000)).toMatchObject({ from: 4, to: 5, move: 'up' });
    s.session = 25;
    expect(review(s, K('a'), 'correct', 1000)).toMatchObject({ from: 5, to: 5, move: 'stay' });
  });

  it('a card that is not due stays put however often it is answered', () => {
    const s = emptyLeitner();
    for (let i = 0; i < 20; i++) review(s, K('a'), 'correct', 500);
    expect(s.cards[K('a')]!.box).toBe(2); // new -> 2 once, then never again this session
    s.session = 2;
    expect(review(s, K('a'), 'correct', 500).to).toBe(2); // box 2 is due only in session 3
    s.session = 3;
    expect(review(s, K('a'), 'correct', 500).to).toBe(3);
  });

  it('correct but slow, or after a hint, stays', () => {
    const s = emptyLeitner();
    withCard(s, 'a', 3, 1);
    expect(review(s, K('a'), 'correct', FAST_MAX_MS + 1)).toMatchObject({ to: 3, move: 'stay' });
    expect(review(s, K('a'), 'hinted', 500)).toMatchObject({ to: 3, move: 'stay' });
  });

  it('wrong goes back to box 1 from anywhere', () => {
    const s = emptyLeitner();
    withCard(s, 'a', 5, 1);
    expect(review(s, K('a'), 'wrong', 500)).toMatchObject({ from: 5, to: 1, move: 'reset' });
  });

  it('practice before a card is due does not postpone its review', () => {
    const s = emptyLeitner();
    review(s, K('a'), 'correct', 500); // new -> box 2 in session 1
    for (const session of [2, 2, 2]) {
      s.session = session;
      review(s, K('a'), 'correct', 500);
    }
    expect(s.cards[K('a')]).toMatchObject({ box: 2, lastSession: 1 });
    s.session = 3;
    expect(review(s, K('a'), 'correct', 500).to).toBe(3);
  });

  it('stamps the current session and counts answers', () => {
    const s = emptyLeitner();
    s.session = 7;
    review(s, K('a'), 'correct', 500);
    review(s, K('a'), 'wrong', 500);
    expect(s.cards[K('a')]).toEqual({ box: 1, lastSession: 7, seen: 2, correct: 1 });
  });
});

describe('fast limit', () => {
  it('uses 6 s until there are enough clean answers', () => {
    const s = emptyLeitner();
    for (let i = 0; i < MIN_TIMING_SAMPLES - 1; i++) review(s, K('a'), 'correct', 1000);
    expect(fastLimitMs(s)).toBe(FAST_MAX_MS);
  });

  it('then adapts to 1.5 x the learner median, never above 6 s', () => {
    const fastLearner = emptyLeitner();
    for (let i = 0; i < 20; i++) review(fastLearner, K('a'), 'correct', 2000);
    expect(fastLimitMs(fastLearner)).toBe(3000);
    const slowLearner = emptyLeitner();
    slowLearner.recentMs = Array.from({ length: 20 }, () => 5000);
    expect(fastLimitMs(slowLearner)).toBe(FAST_MAX_MS);
  });

  it('only clean correct answers feed the timing', () => {
    const s = emptyLeitner();
    review(s, K('a'), 'hinted', 100);
    review(s, K('a'), 'wrong', 100);
    expect(s.recentMs).toEqual([]);
  });
});

describe('due intervals (sessions)', () => {
  it('box 1 every session, 2 every 2nd, 3 every 4th, 4 every 8th, 5 every 16th', () => {
    const at = (box: 1 | 2 | 3 | 4 | 5, gap: number) => isDue({ box, lastSession: 10, seen: 1, correct: 1 }, 10 + gap);
    expect([at(1, 0), at(1, 1)]).toEqual([false, true]);
    expect([at(2, 1), at(2, 2)]).toEqual([false, true]);
    expect([at(3, 3), at(3, 4)]).toEqual([false, true]);
    expect([at(4, 7), at(4, 8)]).toEqual([false, true]);
    expect([at(5, 15), at(5, 16)]).toEqual([false, true]);
  });

  it('endSession advances the counter so cards become due', () => {
    const s = emptyLeitner();
    review(s, K('a'), 'wrong', 500);
    expect(dueCount(s, [K('a')])).toBe(0);
    endSession(s);
    expect(dueCount(s, [K('a')])).toBe(1);
  });
});

describe('planSession', () => {
  const lessonA: Candidate[] = ['a', 'b', 'c', 'd', 'e'].map((ch) => ({ key: K(ch), lessonId: 'L1' }));
  const lessonB: Candidate[] = ['f', 'g', 'h', 'i', 'j'].map((ch) => ({ key: K(ch), lessonId: 'L2' }));

  it('has the requested size and never the same card twice in a row', () => {
    const plan = planSession({ state: emptyLeitner(), available: lessonA, current: lessonA, size: 20, random: seeded(3) });
    expect(plan.queue).toHaveLength(20);
    for (let i = 1; i < plan.queue.length; i++) expect(plan.queue[i]!.key).not.toBe(plan.queue[i - 1]!.key);
  });

  it('takes due cards first (lowest box first), up to 60%', () => {
    const s = emptyLeitner();
    s.session = 20;
    ['f', 'g', 'h', 'i', 'j'].forEach((ch, i) => withCard(s, ch, (i + 1) as 1 | 2 | 3 | 4 | 5, 1));
    ['a', 'b', 'c', 'd', 'e'].forEach((ch) => withCard(s, ch, 1, 20)); // seen this session: not due
    const plan = planSession({ state: s, available: [...lessonA, ...lessonB], current: lessonB, size: 20, random: seeded(5) });
    expect(plan.counts.due).toBe(5);
    expect(plan.counts.fresh).toBe(0);
    expect(plan.counts.current).toBe(15);
    expect(plan.queue.filter((c) => c.lessonId === 'L1')).toHaveLength(0);
  });

  it('caps due cards at 60% and fills the rest from the current lesson', () => {
    const s = emptyLeitner();
    s.session = 5;
    const many: Candidate[] = Array.from({ length: 30 }, (_, i) => ({ key: `recognize:x${i}`, lessonId: 'L9' }));
    many.forEach((c) => (s.cards[c.key] = { box: 1, lastSession: 1, seen: 1, correct: 0 }));
    const plan = planSession({ state: s, available: [...many, ...lessonA], current: lessonA, size: 20, random: seeded(7) });
    expect(plan.counts.due).toBe(12);
  });

  it('introduces new cards in course order (about 10%)', () => {
    const s = emptyLeitner();
    ['a', 'b', 'c', 'd', 'e'].forEach((ch) => withCard(s, ch, 2, 1)); // L1 known, none due
    const plan = planSession({ state: s, available: [...lessonA, ...lessonB], current: lessonA, size: 20, random: seeded(9) });
    const freshKeys = [...new Set(plan.queue.filter((c) => !s.cards[c.key]).map((c) => c.key))];
    expect(new Set(freshKeys)).toEqual(new Set([K('f'), K('g')])); // the first two of L2, in course order
    expect(plan.counts).toEqual({ due: 0, fresh: 2, current: 18 });
  });

  it('counts add up to the session length', () => {
    const s = emptyLeitner();
    const plan = planSession({ state: s, available: lessonA, current: lessonA, size: 20, random: seeded(2) });
    expect(plan.counts.due + plan.counts.current + plan.counts.fresh).toBe(20);
  });

  it('never repeats a card back to back, over many random plans', () => {
    const s = emptyLeitner();
    s.session = 30;
    [...lessonA, ...lessonB].forEach((c, i) => (s.cards[c.key] = { box: ((i % 5) + 1) as 1, lastSession: 1, seen: 1, correct: 1 }));
    for (let seed = 1; seed <= 500; seed++) {
      const plan = planSession({ state: s, available: [...lessonA, ...lessonB], current: lessonB, size: 20, random: seeded(seed) });
      for (let i = 1; i < plan.queue.length; i++) expect(plan.queue[i]!.key, `seed ${seed}`).not.toBe(plan.queue[i - 1]!.key);
    }
  });

  it('with only the six L0 dots, still no back-to-back repeats', () => {
    const dots: Candidate[] = [1, 2, 3, 4, 5, 6].map((d) => ({ key: `recognize:dot${d}`, lessonId: 'L0' }));
    for (const random of [() => 0, seeded(4), seeded(8)]) {
      const plan = planSession({ state: emptyLeitner(), available: dots, current: dots, size: 20, random });
      for (let i = 1; i < plan.queue.length; i++) expect(plan.queue[i]!.key).not.toBe(plan.queue[i - 1]!.key);
    }
  });

  it('is empty only when nothing is available', () => {
    expect(planSession({ state: emptyLeitner(), available: [], current: [], size: 20 }).queue).toEqual([]);
  });
});

describe('spreadRepeats', () => {
  it('separates neighbours when possible', () => {
    const out = spreadRepeats([{ key: 'a' }, { key: 'a' }, { key: 'b' }]);
    expect(out.map((c) => c.key)).toEqual(['a', 'b', 'a']);
  });

  it('handles a trailing cluster the greedy way could not', () => {
    const out = spreadRepeats(['a', 'b', 'c', 'd', 'd', 'd'].map((key) => ({ key })));
    for (let i = 1; i < out.length; i++) expect(out[i]!.key).not.toBe(out[i - 1]!.key);
  });
});

describe('requeueIndex', () => {
  const q = (keys: string) => [...keys].map((key) => ({ key }));

  it('puts a missed card about 3 trials later, between different cards', () => {
    expect(requeueIndex(q('bcdef'), 'a')).toBe(3);
    expect(requeueIndex(q('bcaef'), 'a')).toBe(4); // index 3 would follow another "a"
  });

  it('never straight away: -1 when the queue is empty', () => {
    expect(requeueIndex([], 'a')).toBe(-1);
    expect(requeueIndex(q('b'), 'a')).toBe(1);
    expect(requeueIndex(q('a'), 'a')).toBe(-1);
  });
});

describe('sessionTouched', () => {
  it('is true once a card was answered under the current number', () => {
    const s = emptyLeitner();
    expect(sessionTouched(s)).toBe(false);
    review(s, K('a'), 'correct', 500);
    expect(sessionTouched(s)).toBe(true);
    endSession(s);
    expect(sessionTouched(s)).toBe(false);
  });
});

describe('sanitizeLeitner', () => {
  it('keeps valid cards and drops broken ones', () => {
    const s = sanitizeLeitner({
      version: 1,
      session: 4,
      recentMs: [1000, -5, 'x', 2000],
      cards: {
        [K('a')]: { box: 3, lastSession: 2, seen: 4, correct: 3 },
        [K('b')]: { box: 9, lastSession: 2, seen: 1, correct: 1 },
        [K('c')]: { box: 1, lastSession: 99, seen: 1, correct: 1 },
      },
    });
    expect(s.session).toBe(4);
    expect(s.recentMs).toEqual([1000, 2000]);
    expect(Object.keys(s.cards)).toEqual([K('a')]);
  });

  it('starts empty for other versions and garbage', () => {
    expect(sanitizeLeitner({ version: 2 })).toEqual(emptyLeitner());
    expect(sanitizeLeitner(null)).toEqual(emptyLeitner());
  });
});
