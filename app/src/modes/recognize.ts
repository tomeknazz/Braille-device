// Modes "Rozpoznawanie" and "Powtórki" (docs/DYDAKTYKA.md §4.4, §4.9, §5.3,
// §6.1): the quiz. One character on cell 3, the learner types what it is.
// Both variants share the trial below and differ only in where items come
// from: one chosen lesson, or a Leitner review plan across all unlocked
// lessons. Both move Leitner cards; course attempts (which pass lessons) are
// recorded by Rozpoznawanie always, by Powtórki only for the current lesson.
//
// Trial: clear -> 300 ms -> show on cell 3 -> (after the device confirms)
// ready tone + prompt, start the clock. Only the first answer of a trial is
// recorded. The first wrong answer leaves the character in place ("Spróbuj
// jeszcze raz"); later ones (and F2) walk the hint ladder: blink, number of
// dots, which dots, the answer built up dot by dot. A wrong answer is then
// contrasted with the shown character on the device: [shown] [_] [answer].

import { dotsToMask, letterByChar, maskToDots, table } from '../braille/table';
import { sameCells } from '../device/protocol';
import type { CommandResult } from '../device/DeviceLink';
import { curriculum, lessonById, type Lesson, type LessonItem } from '../learn/curriculum';
import {
  cardKey,
  DEFAULT_SESSION_SIZE,
  dueCount,
  planSession,
  requeueIndex,
  type AnswerKind,
  type Box,
  type Candidate,
} from '../learn/leitner';
import type { Attempt, RecordResult } from '../learn/progress';
import { finishReviewSession, leitner, openReviewSession, progress, recordAttempt, recordReview } from '../learn/session';
import { describeBoxes, describeStats } from './course';
import { describeResult } from './displayText';
import type { KeyHandlers, Mode, ModeContext } from './types';
import './recognize.css';

/** Cell the quiz uses (0-based): cell 3, the middle one, surrounded by blanks. */
const QUIZ_CELL = 2;
/** Highest hint step: 1 blink, 2 dot count, 3 dot numbers, 4 the answer. */
const LAST_HINT = 4;
/** From this hint step on a correct first answer is not counted as correct. */
const REVEALING_HINT = 2;

export interface RecognizeOptions {
  /** 'lesson' = Rozpoznawanie (one chosen lesson), 'review' = Powtórki (Leitner plan). */
  variant?: 'lesson' | 'review';
  /** Trials in one review session. */
  reviewSize?: number;
  /** Random source in [0, 1) for picking items (tests pass a fixed sequence). */
  random?: () => number;
  /** Blank pause between clear and show (new trial, blink). */
  blankMs?: number;
  /** Pause after a correct answer before the next trial starts (lets the feedback finish). */
  nextDelayMs?: number;
  /** Hint step 4: pause after "pokażę punkt po punkcie" before the first dot. */
  buildIntroMs?: number;
  /** Hint step 4: pause after each "punkt N". */
  buildStepMs?: number;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

// --- Pure helpers (exported for tests) ----------------------------------------

/**
 * Picks the next item: never the previous one (when there is a choice), and
 * items answered wrongly in `recent` attempts are proportionally more likely
 * (weight 1 + 2 per recent mistake).
 */
export function pickItem(
  items: readonly LessonItem[],
  previousKey: string | null,
  recent: readonly Attempt[],
  random: () => number = Math.random,
): LessonItem {
  if (items.length === 0) throw new Error('pickItem: no items');
  const pool = items.length > 1 ? items.filter((i) => i.key !== previousKey) : [...items];
  const wrong = new Map<string, number>();
  for (const a of recent) if (!a.correct) wrong.set(a.itemKey, (wrong.get(a.itemKey) ?? 0) + 1);
  const weights = pool.map((i) => 1 + 2 * (wrong.get(i.key) ?? 0));
  const total = weights.reduce((s, w) => s + w, 0);
  const r = Math.min(Math.max(random(), 0), 1 - Number.EPSILON) * total;
  let acc = 0;
  for (let i = 0; i < pool.length; i++) {
    acc += weights[i]!;
    if (r < acc) return pool[i]!;
  }
  return pool[pool.length - 1]!;
}

/** A recognised answer: what the learner meant, whether right or wrong. */
export interface ParsedAnswer {
  key: string;
  mask: number;
  spoken: string;
}

export type AnswerParse = { ok: true; answer: ParsedAnswer } | { ok: false; message: string };

/** Case-insensitive, NFC; letters by character or Polish name, L0 by dot number 1-6. */
export function parseAnswer(kind: Lesson['kind'], raw: string): AnswerParse {
  const v = raw.normalize('NFC').trim().toLocaleLowerCase('pl');
  if (kind === 'dots') {
    if (/^[1-6]$/.test(v)) {
      const dot = Number(v);
      return { ok: true, answer: { key: `dot${dot}`, mask: dotsToMask([dot]), spoken: `punkt ${dot}` } };
    }
    return { ok: false, message: 'Wpisz numer punktu od 1 do 6.' };
  }
  const letter = letterByChar.get(v) ?? table.letters.find((l) => l.name === v);
  if (letter) return { ok: true, answer: { key: letter.char, mask: letter.mask, spoken: letter.name } };
  return { ok: false, message: `Nie rozpoznaję odpowiedzi „${raw.trim()}”. Wpisz jedną literę.` };
}

/** "1", "1 i 5", "1, 3 i 4" (dot numbers). */
export function andList(items: readonly (string | number)[]): string {
  const s = items.map(String);
  if (s.length <= 1) return s.join('');
  return `${s.slice(0, -1).join(', ')} i ${s[s.length - 1]}`;
}

/**
 * How feedback refers to an item. Bare single-vowel letter names (a, i, o, u,
 * e) are also Polish words, so letters are always "litera X" (DYDAKTYKA §7.1).
 */
export function spokenName(kind: Lesson['kind'], spoken: string): string {
  return kind === 'letters' ? `litera ${spoken}` : spoken;
}

/** A lesson as it is spoken: its letters by name, never the raw title with a dash. */
export function spokenLesson(l: Lesson): string {
  if (l.kind === 'letters') return `${l.id}, litery: ${l.items.map((i) => i.spoken).join(', ')}`;
  return `${l.id}, ${l.title.replace(/\s*[–—-]\s*/g, ' do ')}`;
}

/** Letters only: "Różnią się punktem 5: tylko litera en ma punkt 5." */
export function describeDifference(shown: ParsedAnswer, chosen: ParsedAnswer): string {
  const diff = maskToDots(shown.mask ^ chosen.mask);
  if (diff.length === 0) return 'Mają te same punkty.';
  const only = (mask: number, name: string) => {
    const dots = maskToDots(mask);
    if (dots.length === 0) return null;
    return `tylko litera ${name} ma ${dots.length === 1 ? 'punkt' : 'punkty'} ${andList(dots)}`;
  };
  const parts = [only(shown.mask & ~chosen.mask, shown.spoken), only(chosen.mask & ~shown.mask, chosen.spoken)].filter(
    (p): p is string => p !== null,
  );
  const head = diff.length === 1 ? `Różnią się punktem ${diff[0]}` : `Różnią się punktami ${andList(diff)}`;
  return `${head}: ${parts.join(', ')}.`;
}

const ROWS = ['górnym', 'środkowym', 'dolnym'];

/** Hint text for steps 2-4 (step 1 is the blink). */
export function hintText(lesson: Lesson, item: LessonItem, step: number): string {
  const dots = maskToDots(item.mask);
  if (lesson.kind === 'dots') {
    const dot = dots[0]!;
    const column = dot <= 3 ? 'lewej' : 'prawej';
    if (step === 2) return `Punkt jest w ${column} kolumnie.`;
    if (step === 3) return `Punkt jest w ${column} kolumnie, w ${ROWS[(dot - 1) % 3]} rzędzie.`;
    return `To jest ${item.spoken}.`;
  }
  if (step === 2) return `Ten znak ma ${dots.length} ${plural(dots.length, 'punkt', 'punkty', 'punktów')}.`;
  const which = dots.length === 1 ? `Wysunięty jest punkt ${dots[0]}.` : `Wysunięte są punkty ${andList(dots)}.`;
  if (step === 3) return which;
  return `To jest litera ${item.spoken}. ${dots.length === 1 ? 'Punkt' : 'Punkty'} ${andList(dots)}.`;
}

/** Every item of the lessons that are not locked, as Leitner candidates, in course order. */
export function reviewCandidates(): { available: Candidate[]; current: Candidate[] } {
  const open = curriculum.lessons.filter((l) => progress.status(l.id) !== 'locked');
  const toCandidates = (l: Lesson) => l.items.map((i) => ({ key: cardKey(i.key), lessonId: l.id }));
  // Once every lesson is passed there is no "current" lesson to favour.
  const cur = progress.current();
  const current = progress.status(cur.id) === 'passed' ? [] : toCandidates(cur);
  return { available: open.flatMap(toCandidates), current };
}

function findItem(c: Candidate): { lesson: Lesson; item: LessonItem } | null {
  const lesson = lessonById(c.lessonId);
  const item = lesson?.items.find((i) => cardKey(i.key) === c.key);
  return lesson && item ? { lesson, item } : null;
}

// --- The mode ------------------------------------------------------------------

type Phase =
  /** No session. */
  | 'idle'
  /** Clearing / pausing / showing the next item. */
  | 'preparing'
  /** Item confirmed on the device; waiting for an answer. */
  | 'answering'
  /** Correct; the next trial starts by itself. */
  | 'correct'
  /** Hint step 4: the answer is being built on the device dot by dot. */
  | 'revealing'
  /** Contrast, revealed answer or passed lesson: waiting for "Dalej". */
  | 'waiting';

const CONTINUE = 'Gdy skończysz, zdejmij palce i naciśnij Enter albo Dalej.';

export function createRecognizeMode(options: RecognizeOptions = {}): Mode {
  const random = options.random ?? Math.random;
  const blankMs = options.blankMs ?? 300;
  const nextDelayMs = options.nextDelayMs ?? 1500;
  const buildIntroMs = options.buildIntroMs ?? 4000;
  const buildStepMs = options.buildStepMs ?? 1200;
  const review = options.variant === 'review';
  const reviewSize = options.reviewSize ?? DEFAULT_SESSION_SIZE;

  return {
    id: review ? 'review' : 'recognize',
    title: review ? 'Powtórki' : 'Rozpoznawanie',

    mount(root: HTMLElement, ctx: ModeContext): () => void {
      const { link } = ctx;
      const { window } = curriculum.unlock;

      // --- DOM -------------------------------------------------------------
      const intro = h(
        'p',
        { className: 'hint', id: 'recognize-intro' },
        (review
          ? 'Powtórki mieszają znaki ze wszystkich odblokowanych lekcji: najpierw te, które czekają na powtórkę w pudełkach Leitnera, ' +
            'do tego znaki bieżącej lekcji i kilka nowych. Dobra, szybka odpowiedź bez podpowiedzi przesuwa zaległy znak do wyższego pudełka, ' +
            'a po pomyłce znak wraca do pudełka 1. Do zaliczenia lekcji liczą się tu tylko znaki bieżącej lekcji. '
          : '') +
          'Znak pojawia się na komórce 3. Po sygnale dotknij go i wpisz, co to za znak, potem Enter. ' +
          'Po pierwszej pomyłce spróbuj jeszcze raz, po drugiej dostaniesz podpowiedź. ' +
          'Liczy się pierwsza odpowiedź; po podpowiedzi z punktami próba nie liczy się jako poprawna (mrugnięcie nie szkodzi). ' +
          'F1 powtarza polecenie, F2 daje podpowiedź, F3 mruga znakiem. Nie ma limitu czasu.',
      );
      const lessonSelect = h('select', { id: 'recognize-lesson' });
      const startBtn = h('button', { type: 'button', className: 'primary', id: 'recognize-start' }, 'Start');
      const stopBtn = h('button', { type: 'button', id: 'recognize-stop', disabled: true }, 'Zakończ');
      const lessonNote = h('p', { className: 'hint', id: 'recognize-lesson-note' });
      const setup = h(
        'div',
        { className: 'field' },
        ...(review ? [lessonNote] : [h('label', { htmlFor: 'recognize-lesson' }, 'Lekcja'), lessonSelect, lessonNote]),
        h('div', { className: 'button-row' }, startBtn, stopBtn),
      );

      const deviceNotice = h('p', { className: 'notice', id: 'recognize-device' });

      const answer = h('input', { type: 'text', id: 'recognize-answer', autocomplete: 'off', spellcheck: false });
      answer.setAttribute('aria-describedby', 'recognize-status');
      answer.setAttribute('autocapitalize', 'off');
      const idleText = review ? 'Naciśnij Start, aby zacząć sesję powtórek.' : 'Wybierz lekcję i naciśnij Start.';
      const status = h('p', { className: 'recognize-status', id: 'recognize-status' }, idleText);
      const submitBtn = h('button', { type: 'submit', id: 'recognize-submit' }, 'Odpowiedz');
      const nextBtn = h('button', { type: 'button', className: 'primary', id: 'recognize-next', hidden: true }, 'Dalej');
      const repeatBtn = h('button', { type: 'button', id: 'recognize-repeat' }, 'Powtórz (F1)');
      const hintBtn = h('button', { type: 'button', id: 'recognize-hint' }, 'Podpowiedź (F2)');
      const blinkBtn = h('button', { type: 'button', id: 'recognize-blink' }, 'Mrugnij znakiem (F3)');
      const form = h(
        'form',
        { className: 'recognize-quiz' },
        h(
          'div',
          { className: 'field' },
          h('label', { htmlFor: 'recognize-answer' }, 'Twoja odpowiedź'),
          answer,
        ),
        status,
        h('div', { className: 'button-row' }, submitBtn, nextBtn, repeatBtn, hintBtn, blinkBtn),
      );

      const sessionStats = h('p', { className: 'recognize-session', id: 'recognize-session' });
      const lessonStats = h('p', { className: 'recognize-lesson-stats', id: 'recognize-lesson-stats' });
      const stats = h(
        'div',
        { className: 'recognize-stats' },
        h('h4', {}, 'Wyniki'),
        sessionStats,
        lessonStats,
      );

      root.append(intro, setup, deviceNotice, form, stats);

      // --- State -----------------------------------------------------------
      let alive = true;
      let phase: Phase = 'idle';
      /** Bumped on every phase change; async continuations bail when it moved on. */
      let seq = 0;
      /** Bumped on everything said; a late blink stays quiet if newer feedback came meanwhile. */
      let msgSeq = 0;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      /** The unlock tone outlives trial changes (only unmount cancels it). */
      const toneTimers = new Set<ReturnType<typeof setTimeout>>();

      let lesson: Lesson = progress.current();
      let item: LessonItem | null = null;
      let previousKey: string | null = null;
      let readyAt = 0;
      let recorded = false;
      let hintStep = 0;
      let wrongCount = 0;
      let lastWrong: ParsedAnswer | null = null;
      let blinking = false;
      /** What F1 repeats in the current phase. */
      let lastMessage = '';
      /** Cells the device should hold in the current phase. */
      let expected: number[] = [];

      let sessionTotal = 0;
      let sessionCorrect = 0;
      /** Review variant: the planned trials still to come, and card moves so far. */
      let queue: Candidate[] = [];
      const requeued = new Set<string>();
      /** Review variant: the box of every card touched this session, before its first answer. */
      let startBoxes = new Map<string, Box | null>();

      function later(ms: number, fn: () => void): void {
        const id = setTimeout(() => {
          timers.delete(id);
          fn();
        }, ms);
        timers.add(id);
      }
      /** Resolves after `ms` unless the timers are cleared (stop / unmount): then never. */
      const wait = (ms: number) => new Promise<void>((resolve) => later(ms, resolve));
      function clearTimers(): void {
        for (const id of timers) clearTimeout(id);
        timers.clear();
      }

      function enter(next: Phase): number {
        phase = next;
        blinking = false;
        seq++;
        renderControls();
        return seq;
      }
      const current = (s: number) => alive && s === seq;
      const succeeded = (r: CommandResult) => r.status === 'ok' || r.status === 'skipped';

      const cellsFor = (mask: number) => {
        const cells = [0, 0, 0, 0, 0];
        cells[QUIZ_CELL] = mask;
        return cells;
      };
      const prompt = () => (lesson.kind === 'dots' ? 'Który punkt jest wysunięty?' : 'Jaki to znak?');
      const shownAnswer = (): ParsedAnswer => ({ key: item!.key, mask: item!.mask, spoken: item!.spoken });
      const named = (a: { spoken: string }) => spokenName(lesson.kind, a.spoken);

      // --- Rendering -------------------------------------------------------
      function renderLessons(): void {
        const selected = lesson.id;
        lessonSelect.replaceChildren(
          ...curriculum.lessons
            .filter((l) => progress.status(l.id) !== 'locked')
            .map((l) => {
              const passed = progress.status(l.id) === 'passed';
              return h('option', { value: l.id }, `${l.id}: ${l.title}${passed ? ' (zaliczona)' : ''}`);
            }),
        );
        lessonSelect.value = selected;
        // In Powtórki the note line describes the plan, not one lesson.
        if (review) renderPlanNote();
        else lessonNote.textContent = lesson.note;
      }

      function renderStats(): void {
        sessionStats.textContent =
          sessionTotal === 0
            ? 'W tej sesji: brak prób.'
            : `W tej sesji: ${sessionCorrect} z ${sessionTotal} poprawnie.`;
        if (review) {
          const keys = reviewCandidates().available.map((c) => c.key);
          lessonStats.textContent =
            `Pudełka Leitnera: ${describeBoxes(keys)}. ` +
            `Sesja powtórek nr ${leitner.session}, czeka na powtórkę: ${dueCount(leitner, keys)}.`;
          return;
        }
        lessonStats.textContent = `Lekcja ${lesson.id}: ${describeStats(progress.stats(lesson.id), window)}`;
      }

      function renderPlanNote(): void {
        if (!review) return;
        const { available } = reviewCandidates();
        const lessons = new Set(available.map((c) => c.lessonId)).size;
        lessonNote.textContent = available.length
          ? `Znaki z odblokowanych lekcji (${lessons}). Sesja ma ${reviewSize} ${plural(reviewSize, 'próbę', 'próby', 'prób')}.`
          : 'Brak znaków do powtórki.';
      }

      function renderDevice(): void {
        const ready = link.state === 'ready';
        deviceNotice.hidden = ready;
        deviceNotice.textContent = ready
          ? ''
          : 'Urządzenie nie jest połączone. Połącz je albo włącz tryb symulacji, potem naciśnij Start.';
      }

      /** Disabling or hiding a focused control drops focus to <body>; hand it on first. */
      function renderControls(): void {
        const running = phase !== 'idle';
        const focused = document.activeElement;
        const waiting = phase === 'waiting' || phase === 'revealing';
        // Move focus only to controls that are enabled at that moment.
        if (!waiting && focused === nextBtn) answer.focus();
        if (running && focused === startBtn) answer.focus();
        startBtn.disabled = running;
        if (!running && focused === stopBtn) startBtn.focus();
        stopBtn.disabled = !running;
        nextBtn.hidden = !waiting;
        lessonSelect.disabled = running;
      }

      function setStatus(text: string): void {
        status.textContent = text;
      }

      /** Everything spoken goes through here, so a late blink can tell it was overtaken. */
      function say(text: string): void {
        msgSeq++;
        ctx.say(text);
      }
      /** The current message: shown, spoken, and what F1 repeats. */
      function speak(text: string, statusText = text): void {
        lastMessage = text;
        setStatus(statusText);
        say(text);
      }

      // --- Session ---------------------------------------------------------
      function start(): void {
        if (phase !== 'idle') return;
        if (link.state !== 'ready') {
          renderDevice();
          say(
            describeResult({ status: 'cancelled', reason: 'not-connected' }, '') ??
              'Urządzenie nie jest połączone.',
          );
          return;
        }
        let opening = '';
        if (review) {
          openReviewSession();
          const { available, current } = reviewCandidates();
          const plan = planSession({ state: leitner, available, current, size: reviewSize, random });
          if (!plan.queue.length) {
            say('Brak znaków do powtórki.');
            return;
          }
          queue = plan.queue;
          requeued.clear();
          startBoxes = new Map();
          const c = plan.counts;
          opening =
            `Sesja powtórek: ${queue.length} ${plural(queue.length, 'próba', 'próby', 'prób')}. ` +
            `Zaległe: ${c.due}, z bieżącej lekcji: ${c.current}, nowe: ${c.fresh}.`;
          renderPlanNote();
        } else {
          const chosen = lessonById(lessonSelect.value);
          if (chosen && progress.status(chosen.id) !== 'locked') lesson = chosen;
        }
        sessionTotal = 0;
        sessionCorrect = 0;
        previousKey = null;
        renderStats();
        // Spoken now; the first prompt comes only after the device confirms,
        // and it may cut this short — the status line keeps it visible.
        if (opening) {
          setStatus(opening);
          say(opening);
        }
        answer.focus();
        void nextTrial();
      }

      function stop(reason?: string): void {
        if (phase === 'idle') return;
        clearTimers();
        enter('idle');
        item = null;
        answer.value = '';
        if (link.state === 'ready') void link.clear();
        let summary =
          sessionTotal === 0
            ? 'Koniec sesji. Nie było ocenionych prób.'
            : `Koniec sesji. Poprawnie ${sessionCorrect} z ${sessionTotal}.`;
        if (review && sessionTotal > 0) summary += ` ${closeReviewSession()}`;
        queue = [];
        setStatus(`${reason ? reason + ' ' : ''}${summary} Naciśnij Start, aby zacząć od nowa.`);
        say(reason ? `${reason} ${summary}` : summary);
      }

      /** Advances the Leitner session counter and describes what moved. */
      function closeReviewSession(): string {
        // Distinct cards, compared by where they started and where they ended.
        let up = 0;
        let back = 0;
        for (const [key, from] of startBoxes) {
          const to = leitner.cards[key]?.box;
          if (to === undefined) continue;
          if (to > (from ?? 1)) up++;
          else if (to === 1 && from !== null && from > 1) back++;
        }
        startBoxes = new Map();
        finishReviewSession();
        const keys = reviewCandidates().available.map((c) => c.key);
        const due = dueCount(leitner, keys);
        renderStats();
        return (
          `Do wyższego pudełka przeszło: ${up}, do pudełka 1 wróciło: ${back}. ` +
          `Na następną sesję czeka: ${due}.`
        );
      }

      /** All planned trials done: close the session like "Zakończ", with its own words. */
      function finishReview(): void {
        const summary = sessionTotal > 0 ? `Poprawnie ${sessionCorrect} z ${sessionTotal}. ${closeReviewSession()}` : '';
        clearTimers();
        enter('idle');
        item = null;
        answer.value = '';
        queue = [];
        if (link.state === 'ready') void link.clear();
        const text = `Sesja powtórek zakończona. ${summary}`.trim();
        setStatus(`${text} Naciśnij Start, aby zacząć kolejną.`);
        say(text);
      }

      /**
       * A command that should have put the item on the device did not: end
       * without recording. Within this mode nothing replaces the trial's own
       * shows (F1/F3 wait while one is pending), so 'superseded' here means an
       * outside command took the display over.
       */
      function failed(r: CommandResult): void {
        const detail = describeResult(r, '') ?? 'Wyświetlanie zostało zastąpione innym poleceniem.';
        stop(`Nie udało się ułożyć znaku. ${detail} Sesja zatrzymana.`);
      }

      async function nextTrial(): Promise<void> {
        clearTimers();
        if (review) {
          const c = queue.shift();
          const found = c ? findItem(c) : null;
          if (!found) {
            finishReview();
            return;
          }
          lesson = found.lesson;
          item = found.item;
        } else {
          item = pickItem(lesson.items, previousKey, progress.attempts(lesson.id).slice(-window), random);
        }
        const s = enter('preparing');
        previousKey = item.key;
        recorded = false;
        hintStep = 0;
        wrongCount = 0;
        lastWrong = null;
        answer.value = '';
        expected = cellsFor(item.mask);
        setStatus('Układam znak — zdejmij palce z urządzenia.');

        // DYDAKTYKA §4.9: clear, pause, show — so even a similar character is felt as new.
        const cleared = await link.clear();
        if (!current(s)) return;
        if (!succeeded(cleared)) return failed(cleared);
        await wait(blankMs);
        if (!current(s)) return;
        const shown = await link.show(expected);
        if (!current(s)) return;
        if (!succeeded(shown)) return failed(shown);

        enter('answering');
        ctx.tone('ready');
        speak(prompt(), `${prompt()} Dotknij komórki 2 i wpisz odpowiedź.`);
        readyAt = ctx.now();
      }

      /**
       * Records the FIRST answer of a trial (null for later ones). `correct`
       * goes to the course progress; `kind` moves the Leitner card.
       */
      function record(correct: boolean, kind: AnswerKind): { course: RecordResult | null } | null {
        if (recorded || !item) return null;
        recorded = true;
        const ms = Math.max(0, Math.round(ctx.now() - readyAt));
        // Powtórki count towards passing only for the current lesson's characters.
        const countsForCourse = !review || lesson.id === progress.current().id;
        let course: RecordResult | null = null;
        if (countsForCourse) {
          const attempt: Attempt = { lessonId: lesson.id, itemKey: item.key, correct, ms, at: Date.now() };
          try {
            course = recordAttempt(attempt);
          } catch {
            // The lesson was locked meanwhile (teacher option switched off): not counted at all.
            if (!review) return null;
          }
        }
        const key = cardKey(item.key);
        if (review && !startBoxes.has(key)) startBoxes.set(key, leitner.cards[key]?.box ?? null);
        recordReview(key, kind, ms);
        // A missed card comes back later in the same review session (once), never back to back.
        if (review && kind === 'wrong' && !requeued.has(item.key)) {
          const at = requeueIndex(queue, key);
          if (at >= 0) {
            requeued.add(item.key);
            queue.splice(at, 0, { key, lessonId: lesson.id });
          }
        }
        sessionTotal++;
        if (correct) sessionCorrect++;
        renderStats();
        return { course };
      }

      /** Text for a passed lesson; also refreshes the picker and plays the tone. */
      function passedText(result: RecordResult | null): string {
        if (!result?.passed) return '';
        // After the correct/wrong earcon; its own timer, so an early Enter cannot drop it.
        const id = setTimeout(() => {
          toneTimers.delete(id);
          if (alive) ctx.tone('unlock');
        }, 400);
        toneTimers.add(id);
        renderLessons();
        let text = ` Lekcja ${result.passed.id} zaliczona!`;
        if (result.unlocked) {
          text +=
            ` Odblokowano lekcję ${spokenLesson(result.unlocked)}.` +
            (review
              ? ' Jej znaki pojawią się w następnej sesji powtórek; możesz też ćwiczyć ją w trybie Rozpoznawanie.'
              : ' Aby ją ćwiczyć, naciśnij Zakończ, wybierz lekcję z listy i Start.');
        }
        return text;
      }

      /**
       * Waits for "Dalej", with the contrast on the device if there was a wrong
       * answer. `answerIsLatest`: the wrong answer is the one just given (not an
       * earlier one followed by a correct answer).
       */
      async function conclude(prefix: string, answerIsLatest = false): Promise<void> {
        const s = enter('waiting');
        if (!lastWrong || !item || lastWrong.key === item.key) {
          speak(`${prefix} ${CONTINUE}`.trim());
          return;
        }
        const shownA = shownAnswer();
        const chosen = lastWrong;
        expected = [shownA.mask, 0, chosen.mask, 0, 0];
        // What F1 says while the contrast is still moving.
        lastMessage = `${prefix} Pokazuję porównanie na komórkach 1 i 3.`.trim();
        setStatus(lastMessage);
        const r = await link.show(expected);
        if (!current(s)) return;
        if (!succeeded(r)) return failed(r);
        // For single dots (L0) the positions say it all; letters get the differing dots.
        const difference = lesson.kind === 'letters' ? ` ${describeDifference(shownA, chosen)}` : '';
        const whose = answerIsLatest ? 'Twoja odpowiedź' : 'Twoja wcześniejsza odpowiedź';
        ctx.tone('ready');
        speak(
          `${prefix} Na komórce 1 ${named(shownA)}, na komórce 3 ${named(chosen)} — ${whose}.${difference} ${CONTINUE}`.trim(),
        );
      }

      function onCorrect(): void {
        const withHint = hintStep >= REVEALING_HINT;
        // A revealing hint keeps the Leitner card where it is; a blink does not.
        const recordedNow = record(!withHint, withHint ? 'hinted' : 'correct');
        ctx.tone('correct');
        let text = `Dobrze, to ${named(item!)}.`;
        if (withHint && recordedNow) text += ' Ta próba była z podpowiedzią, więc nie liczy się jako poprawna.';
        const passed = passedText(recordedNow?.course ?? null);
        text += passed;
        // Longer feedback waits for "Dalej", so the next prompt cannot cut it off.
        if (lastWrong || passed || withHint) {
          void conclude(text);
          return;
        }
        enter('correct');
        speak(`${text} Zdejmij palce.`);
        later(nextDelayMs, () => void nextTrial());
      }

      function onWrong(chosen: ParsedAnswer): void {
        wrongCount++;
        const passed = passedText(record(false, 'wrong')?.course ?? null);
        lastWrong = chosen;
        ctx.tone('wrong');
        const no = `Nie, to nie ${named(chosen)}.`;
        if (passed) {
          // A milestone always waits for "Dalej".
          void conclude(`${no}${passed}`, true);
          return;
        }
        if (wrongCount === 1) {
          // DYDAKTYKA §5.3: the first mistake leaves the character under the finger.
          speak(`${no} Spróbuj jeszcze raz.`);
          return;
        }
        hint(no, true);
      }

      /** Tells why F2/F3 do nothing right now; true when the caller should stop. */
      function busyPhase(): boolean {
        if (phase === 'idle') say('Najpierw naciśnij Start.');
        else if (phase === 'preparing') say('Chwileczkę, układam znak.');
        else if (phase === 'correct') say('Chwileczkę, zaraz następny znak.');
        else if (phase === 'revealing') say('Chwileczkę, pokazuję znak punkt po punkcie.');
        else return false;
        return true;
      }

      /**
       * Next step of the hint ladder; `prefix` is spoken with it. `justAnswered`:
       * a wrong answer brought us here (for the wording of the contrast).
       */
      function hint(prefix = '', justAnswered = false): void {
        if (busyPhase()) return;
        if (phase === 'waiting') {
          say(lastMessage);
          return;
        }
        if (!item) return;
        hintStep = Math.min(hintStep + 1, LAST_HINT);
        if (hintStep === 1) {
          void blink(prefix);
          return;
        }
        if (hintStep < LAST_HINT) {
          let text = `${prefix} ${hintText(lesson, item, hintStep)}`;
          if (hintStep === REVEALING_HINT && !recorded) text += ' Od tej podpowiedzi próba nie liczy się jako poprawna.';
          speak(text.trim());
          return;
        }
        void reveal(prefix, justAnswered);
      }

      /**
       * Hint step 4 (DYDAKTYKA §5.3.4): the answer, then the character built up
       * dot by dot so touch and name meet. A trial revealed before any answer
       * counts as wrong.
       */
      async function reveal(prefix: string, justAnswered: boolean): Promise<void> {
        const s = enter('revealing');
        const it = item!;
        const passed = passedText(record(false, 'wrong')?.course ?? null);
        const answerText = hintText(lesson, it, LAST_HINT);
        const dots = maskToDots(it.mask);
        // A single dot has nothing to build.
        if (dots.length < 2) return conclude(`${prefix} ${answerText}${passed}`.trim(), justAnswered);

        speak(`${prefix} To jest ${named(it)}. Zdejmij palce, pokażę ją punkt po punkcie.`.trim());
        expected = cellsFor(0);
        const cleared = await link.clear();
        if (!current(s)) return;
        if (!succeeded(cleared)) return failed(cleared);
        await wait(buildIntroMs); // let the sentence finish before the first "punkt"
        if (!current(s)) return;
        let partial = 0;
        for (const d of dots) {
          partial |= dotsToMask([d]);
          expected = cellsFor(partial);
          const r = await link.show(expected);
          if (!current(s)) return;
          if (!succeeded(r)) return failed(r);
          say(`punkt ${d}`);
          await wait(buildStepMs);
          if (!current(s)) return;
        }
        expected = cellsFor(it.mask);
        await conclude(`${answerText}${passed}`, justAnswered);
      }

      /** Clear, pause, show again (hint step 1 and F3). */
      async function blink(prefix = ''): Promise<void> {
        if (busyPhase()) return;
        if (phase !== 'answering' && phase !== 'waiting') return;
        // Never replace a show that is still on its way (it would be 'superseded').
        if (blinking || link.busy) {
          say(`${prefix} Chwileczkę, znak właśnie się układa.`.trim());
          return;
        }
        blinking = true;
        const s = seq;
        const target = expected;
        const back = `${prefix} ${phase === 'answering' ? prompt() : ''}`.trim();
        say(`${prefix} Mrugam znakiem.`.trim());
        setStatus(`${prefix} Mrugam znakiem.`.trim());
        const m = msgSeq;
        const cleared = await link.clear();
        if (!current(s)) return;
        if (!succeeded(cleared)) {
          blinking = false;
          return cleared.status === 'superseded' ? undefined : failed(cleared);
        }
        await wait(blankMs);
        if (!current(s)) return;
        const shown = await link.show(target);
        if (!current(s)) return;
        blinking = false;
        if (!succeeded(shown)) return shown.status === 'superseded' ? undefined : failed(shown);
        ctx.tone('ready');
        // Newer feedback was spoken meanwhile: the tone is enough, do not cut it
        // off, and F1 keeps repeating that newer message.
        if (msgSeq !== m) return;
        if (phase === 'answering') lastMessage = back;
        say('Dotknij jeszcze raz.');
        setStatus(`${back ? back + ' ' : ''}Dotknij jeszcze raz.`);
      }

      /** F1: say the current message again; put the character back first if the display lost it. */
      async function repeat(): Promise<void> {
        if (phase === 'idle') {
          say(review ? idleText : `${idleText} Wybrana lekcja: ${lessonSelect.value}.`);
          return;
        }
        if (phase === 'preparing') {
          say('Chwileczkę, układam znak.');
          return;
        }
        // Re-show only what the app is not already bringing up: comparing with
        // `desired` (not `confirmed`) never replaces a show still in the queue.
        const lost =
          !sameCells(link.desired, expected) || (!link.busy && !sameCells(link.confirmed, expected));
        if (phase !== 'revealing' && !blinking && lost) {
          const s = seq;
          const r = await link.show(expected);
          if (!current(s)) return;
          if (r.status === 'superseded') return; // a newer show is on its way and will announce itself
          if (!succeeded(r)) return failed(r);
          ctx.tone('ready');
        }
        say(lastMessage);
      }

      function next(): void {
        if (phase !== 'waiting' && phase !== 'revealing') return;
        void nextTrial();
      }

      const onSubmit = (e: Event) => {
        e.preventDefault();
        if (phase === 'waiting' || phase === 'revealing') {
          answer.value = '';
          next();
          return;
        }
        if (phase === 'idle') {
          say('Najpierw naciśnij Start.');
          return;
        }
        if (phase === 'preparing') {
          say('Chwileczkę, znak jeszcze się układa.');
          return;
        }
        if (phase === 'correct') {
          say('Chwileczkę, zaraz następny znak.');
          return;
        }
        if (!item) return;
        const raw = answer.value;
        if (!raw.trim()) {
          say('Wpisz odpowiedź i naciśnij Enter.');
          return;
        }
        const parsed = parseAnswer(lesson.kind, raw);
        answer.value = '';
        if (!parsed.ok) {
          setStatus(parsed.message);
          say(parsed.message);
          return;
        }
        if (parsed.answer.key === item.key) onCorrect();
        else onWrong(parsed.answer);
      };

      const onNextClick = () => {
        answer.focus();
        next();
      };
      const onLessonChange = () => {
        const chosen = lessonById(lessonSelect.value);
        if (!chosen || phase !== 'idle') return;
        lesson = chosen;
        lessonNote.textContent = lesson.note;
        renderStats();
      };

      form.addEventListener('submit', onSubmit);
      startBtn.addEventListener('click', start);
      const onStop = () => stop();
      stopBtn.addEventListener('click', onStop);
      nextBtn.addEventListener('click', onNextClick);
      const onRepeat = () => void repeat();
      const onHint = () => hint();
      const onBlink = () => void blink();
      repeatBtn.addEventListener('click', onRepeat);
      hintBtn.addEventListener('click', onHint);
      blinkBtn.addEventListener('click', onBlink);
      lessonSelect.addEventListener('change', onLessonChange);

      const offState = link.on('state', (state) => {
        renderDevice();
        if (phase !== 'idle' && state !== 'ready' && state !== 'connecting') {
          stop('Połączenie z urządzeniem zostało przerwane. Sesja zatrzymana.');
        }
      });

      const keys: KeyHandlers = { repeat: onRepeat, hint: onHint, blink: onBlink };
      ctx.setKeys(keys);

      renderLessons();
      renderPlanNote();
      renderStats();
      renderDevice();
      renderControls();

      return () => {
        alive = false;
        clearTimers();
        for (const id of toneTimers) clearTimeout(id);
        toneTimers.clear();
        offState();
        ctx.setKeys(null);
        form.removeEventListener('submit', onSubmit);
        startBtn.removeEventListener('click', start);
        stopBtn.removeEventListener('click', onStop);
        nextBtn.removeEventListener('click', onNextClick);
        repeatBtn.removeEventListener('click', onRepeat);
        hintBtn.removeEventListener('click', onHint);
        blinkBtn.removeEventListener('click', onBlink);
        lessonSelect.removeEventListener('change', onLessonChange);
        root.replaceChildren();
      };
    },
  };
}

export const recognizeMode: Mode = createRecognizeMode();
export const reviewMode: Mode = createRecognizeMode({ variant: 'review' });
