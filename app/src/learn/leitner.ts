// Leitner boxes (docs/DYDAKTYKA.md §6.1). A card is (item, skill); only the
// "recognize" skill has an exercise so far, the key leaves room for "write"
// and "discriminate". Intervals are counted in review SESSIONS, not days:
// learners practise irregularly, and the pilot study runs 3 sessions a week.
//
//   box 1: every session, 2: every 2nd, 3: every 4th, 4: every 8th,
//   box 5: mastered, checked every 16th session.
//
// Outcome of a card's first answer in a trial (only a due review or a miss
// restarts the card's interval):
//   correct, no hint, fast -> one box up, but only when the card was due
//     (or is new): extra practice between reviews never skips boxes
//   correct but slow, or after a revealing hint -> stays
//   wrong (or answer revealed) -> back to box 1

export type Skill = 'recognize';
export type Box = 1 | 2 | 3 | 4 | 5;
export const BOXES: readonly Box[] = [1, 2, 3, 4, 5];
export const INTERVALS: Record<Box, number> = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 };

/** "Fast" is at most this, and at most FAST_FACTOR x the learner's median. */
export const FAST_MAX_MS = 6000;
export const FAST_FACTOR = 1.5;
/** Below this many timed correct answers the fixed limit alone applies. */
export const MIN_TIMING_SAMPLES = 10;
const MAX_TIMING_SAMPLES = 50;

export type AnswerKind = 'correct' | 'hinted' | 'wrong';
export type Move = 'up' | 'stay' | 'reset';

export interface Card {
  box: Box;
  /** Session number in which the card was last answered. */
  lastSession: number;
  seen: number;
  correct: number;
}

export interface LeitnerState {
  version: 1;
  /** The current review session (1-based); advances when a review session ends. */
  session: number;
  cards: Record<string, Card>;
  /** Answer times of recent clean correct answers, for the "fast" limit. */
  recentMs: number[];
}

export function emptyLeitner(): LeitnerState {
  return { version: 1, session: 1, cards: {}, recentMs: [] };
}

export function cardKey(itemKey: string, skill: Skill = 'recognize'): string {
  return `${skill}:${itemKey}`;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The answer-time limit for "fast", adapted to the learner once there is data. */
export function fastLimitMs(state: LeitnerState): number {
  if (state.recentMs.length < MIN_TIMING_SAMPLES) return FAST_MAX_MS;
  return Math.min(FAST_MAX_MS, FAST_FACTOR * median(state.recentMs)!);
}

export function isDue(card: Card, session: number): boolean {
  return session - card.lastSession >= INTERVALS[card.box];
}

export interface ReviewResult {
  key: string;
  from: Box | null;
  to: Box;
  move: Move;
}

/**
 * Applies one answer. `kind`: 'hinted' = correct after a hint; `ms` = time
 * from "ready" to the answer. A card seen for the first time starts in box 1.
 */
export function review(state: LeitnerState, key: string, kind: AnswerKind, ms: number): ReviewResult {
  const existing = state.cards[key];
  const from = existing?.box ?? null;
  const card: Card = existing ?? { box: 1, lastSession: state.session, seen: 0, correct: 0 };
  // Due now (or new): this answer is the card's scheduled review.
  const due = !existing || isDue(existing, state.session);
  card.seen++;
  let move: Move;
  if (kind === 'wrong') {
    move = 'reset';
    card.box = 1;
  } else {
    card.correct++;
    const fast = ms <= fastLimitMs(state);
    if (kind === 'correct') {
      // Timing samples come only from clean answers, before this one is judged.
      state.recentMs.push(ms);
      if (state.recentMs.length > MAX_TIMING_SAMPLES) state.recentMs.splice(0, state.recentMs.length - MAX_TIMING_SAMPLES);
    }
    // Strict Leitner: a card moves up only when its review was due. Answers
    // in between (Rozpoznawanie, a repeat in the same session) keep it put,
    // so twenty quick answers in one sitting cannot make a letter "mastered".
    // A brand-new card answered cleanly is known already: it goes to box 2.
    const next = existing ? (Math.min(5, card.box + 1) as Box) : 2;
    if (kind === 'correct' && fast && due && next !== from) {
      move = 'up';
      card.box = next;
    } else {
      move = 'stay';
    }
  }
  // Only a scheduled review or a reset restarts the card's interval; extra
  // practice before it is due (e.g. Rozpoznawanie every session) must not
  // keep postponing the review for ever.
  if (due || move === 'reset') card.lastSession = state.session;
  state.cards[key] = card;
  return { key, from, to: card.box, move };
}

// --- Session composition --------------------------------------------------------

/** Share of a review session per source (DYDAKTYKA §6.1): due / current lesson / new. */
export const MIX = { due: 0.6, current: 0.3, fresh: 0.1 } as const;
export const DEFAULT_SESSION_SIZE = 20;

export interface Candidate {
  /** Card key (skill + item). */
  key: string;
  /** Lesson the item belongs to. */
  lessonId: string;
}

export interface SessionPlanInput {
  state: LeitnerState;
  /** Items of every lesson that is not locked, in course order. */
  available: readonly Candidate[];
  /** Items of the learner's current lesson (empty once every lesson is passed). */
  current: readonly Candidate[];
  size?: number;
  random?: () => number;
}

export interface SessionPlan {
  queue: Candidate[];
  counts: { due: number; current: number; fresh: number };
}

function shuffle<T>(list: T[], random: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

/**
 * Reorders so the same card never comes twice in a row whenever that is
 * possible: always takes the most frequent remaining key that differs from
 * the previous one (ties keep the input order, which the caller shuffled).
 */
export function spreadRepeats<T extends { key: string }>(list: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const c of list) {
    const g = groups.get(c.key);
    if (g) g.push(c);
    else groups.set(c.key, [c]);
  }
  const out: T[] = [];
  let prev: string | undefined;
  while (out.length < list.length) {
    let best: string | undefined;
    for (const [k, g] of groups) {
      if (!g.length || k === prev) continue;
      if (best === undefined || g.length > groups.get(best)!.length) best = k;
    }
    // Only one key left: repeats are unavoidable.
    if (best === undefined) best = prev!;
    out.push(groups.get(best)!.shift()!);
    prev = best;
  }
  return out;
}

/**
 * Where to put a missed card back into the rest of the session: at least
 * `gap` trials later, between two different cards. -1 when there is no such
 * place (the queue is empty or only this card is left).
 */
export function requeueIndex(queue: readonly { key: string }[], key: string, gap = 3): number {
  for (let i = Math.min(gap, queue.length); i <= queue.length; i++) {
    const before = queue[i - 1]?.key;
    const after = queue[i]?.key;
    if (i === 0) continue; // never straight away
    if (before !== key && after !== key) return i;
  }
  return -1;
}

/**
 * Builds a review session: ~60% due cards (lowest box first, longest unseen
 * first), ~30% current-lesson items, ~10% items never seen. Missing due cards
 * are replaced by current-lesson items, then by any available item, so the
 * session always has `size` trials when anything is available.
 */
export function planSession(input: SessionPlanInput): SessionPlan {
  const { state, available } = input;
  const size = input.size ?? DEFAULT_SESSION_SIZE;
  const random = input.random ?? Math.random;
  const availableKeys = new Set(available.map((c) => c.key));
  const current = input.current.filter((c) => availableKeys.has(c.key));
  if (available.length === 0 || size <= 0) return { queue: [], counts: { due: 0, current: 0, fresh: 0 } };

  const due = available
    .filter((c) => state.cards[c.key] && isDue(state.cards[c.key]!, state.session))
    .sort((a, b) => {
      const ca = state.cards[a.key]!;
      const cb = state.cards[b.key]!;
      return ca.box - cb.box || ca.lastSession - cb.lastSession;
    });
  // New cards come in course order, so the learner meets letters as taught.
  const fresh = available.filter((c) => !state.cards[c.key]);

  const want = {
    due: Math.round(size * MIX.due),
    fresh: Math.max(fresh.length ? 1 : 0, Math.round(size * MIX.fresh)),
  };
  const pickedDue = due.slice(0, want.due);
  const pickedFresh = fresh.slice(0, Math.min(want.fresh, size - pickedDue.length));
  const queue: Candidate[] = [...pickedDue, ...pickedFresh];

  // The rest: current lesson, cycled; if it is empty, anything available.
  const filler = current.length ? current : available;
  let cycle: Candidate[] = [];
  while (queue.length < size) {
    if (!cycle.length) cycle = shuffle([...filler], random);
    queue.push(cycle.shift()!);
  }

  // Counted in trials, so the three numbers add up to the session length.
  // "New" covers every trial of a never-seen card, filler included.
  const freshTrials = queue.filter((c) => !state.cards[c.key]).length;
  const dueTrials = pickedDue.length;
  return {
    queue: spreadRepeats(shuffle(queue, random)),
    counts: { due: dueTrials, fresh: freshTrials, current: queue.length - dueTrials - freshTrials },
  };
}

/** Cards per box among `keys` (cards never seen are left out). */
export function boxCounts(state: LeitnerState, keys: readonly string[]): Record<Box, string[]> {
  const out: Record<Box, string[]> = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const k of keys) {
    const c = state.cards[k];
    if (c) out[c.box].push(k);
  }
  return out;
}

export function dueCount(state: LeitnerState, keys: readonly string[]): number {
  return keys.filter((k) => state.cards[k] && isDue(state.cards[k]!, state.session)).length;
}

/** Ends a review session: the next one is due-checked against a later number. */
export function endSession(state: LeitnerState): void {
  state.session++;
}

/** Something was answered under the current session number (an unfinished session). */
export function sessionTouched(state: LeitnerState): boolean {
  return Object.values(state.cards).some((c) => c.lastSession === state.session);
}

/** Drops anything malformed (manual edits, older formats). */
export function sanitizeLeitner(input: unknown): LeitnerState {
  const out = emptyLeitner();
  if (!input || typeof input !== 'object') return out;
  const s = input as Partial<LeitnerState>;
  if (s.version !== 1) return out;
  if (Number.isInteger(s.session) && s.session! >= 1) out.session = s.session!;
  if (Array.isArray(s.recentMs)) out.recentMs = s.recentMs.filter((n) => Number.isFinite(n) && n >= 0).slice(-MAX_TIMING_SAMPLES);
  if (s.cards && typeof s.cards === 'object') {
    for (const [k, c] of Object.entries(s.cards)) {
      if (
        c &&
        BOXES.includes(c.box) &&
        Number.isInteger(c.lastSession) &&
        c.lastSession >= 1 &&
        c.lastSession <= out.session &&
        Number.isInteger(c.seen) &&
        Number.isInteger(c.correct)
      ) {
        out.cards[k] = { box: c.box, lastSession: c.lastSession, seen: c.seen, correct: c.correct };
      }
    }
  }
  return out;
}
