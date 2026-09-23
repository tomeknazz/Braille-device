// Mode "Słowa" (docs/DYDAKTYKA.md §4.6, §5.3): a word of up to 5 letters,
// made only of letters from lessons the learner has opened, appears on
// cells 1..n. The learner reads it with the fingers and types it. A wrong
// answer leaves the word on the device; F2 climbs the hint ladder:
//   1. blink (the word hides and rises again),
//   2. the first letter,
//   3. the letters one by one — built up on the device letter after letter,
//      each one named ("pierwsza: ka"),
//   4. the word itself; it stays under the fingers until the learner moves on.
// Words keep only a session score: course attempts are recorded by the
// single-letter exercises, whose items are the lesson letters.
//
// Every new word follows the trial hygiene of §4.9: clear -> short pause ->
// show, and "Przeczytaj słowo" comes only after the device confirmed the move.

import './words.css';
import { cellsToBraille } from '../braille/translator';
import type { CommandResult } from '../device/DeviceLink';
import { curriculum } from '../learn/curriculum';
import { progress as sessionProgress } from '../learn/session';
import {
  availableWords,
  pickWord,
  words as allWords,
  wordsWithLessonLetters,
  type LessonAccess,
  type WordEntry,
} from '../learn/words';
import { describeResult } from './displayText';
import type { Mode, ModeContext } from './types';

export interface WordsModeOptions {
  /** Lesson access (default: the learner's course progress). */
  progress?: LessonAccess;
  words?: readonly WordEntry[];
  random?: () => number;
  /** Pause between clearing the display and showing a new word (§4.9). */
  pauseMs?: number;
  /** Delay before the next word after a correct answer. */
  nextDelayMs?: number;
  /** Time for each letter of hint 3 to be named before the next one rises. */
  letterStepMs?: number;
  /** Time for the hint 3 announcement before the first letter is named. */
  hintLeadMs?: number;
}

/** How many recent words are not repeated. */
const RECENT = 8;
const MAX_HINT = 4;
const ORDINALS = ['pierwsza', 'druga', 'trzecia', 'czwarta', 'piąta'];

const ordinal = (i: number) => ORDINALS[i] ?? `${i + 1}.`;
const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase('pl') + s.slice(1);

/** "druga", "druga i trzecia", "pierwsza, druga i czwarta". */
function listOrdinals(indices: readonly number[]): string {
  const words = indices.map(ordinal);
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} i ${words.at(-1)}`;
}

/**
 * Letter-by-letter feedback for a wrong answer of the right length
 * (docs/DYDAKTYKA.md §4.6): which positions do not match. Empty when the
 * lengths differ, since positions no longer line up.
 */
export function letterFeedback(typed: readonly string[], expected: readonly string[]): string {
  if (typed.length !== expected.length) return '';
  const wrong = expected.flatMap((ch, i) => (typed[i] === ch ? [] : [i]));
  if (wrong.length === 0) return '';
  if (wrong.length === expected.length) return 'Żadna litera się nie zgadza.';
  if (wrong.length === 1) return `${capitalize(ordinal(wrong[0]!))} litera się nie zgadza.`;
  return `Nie zgadzają się litery: ${listOrdinals(wrong)}.`;
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

export function letterCount(n: number): string {
  return `${n} ${plural(n, 'literę', 'litery', 'liter')}`;
}

/** What the learner typed, compared case- and space-insensitively. */
export function normalizeAnswer(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('pl').replace(/\s+/gu, '');
}

const shown = (r: CommandResult) => r.status === 'ok' || r.status === 'skipped';

type Phase =
  /** No word yet (or the pool is empty). */
  | 'idle'
  /** Clearing / pausing / showing a new word; answers wait. */
  | 'showing'
  /** The word is under the fingers; answers are checked. */
  | 'ready'
  /** Answered correctly; the next word follows shortly. */
  | 'solved'
  /** Hint 4 gave the word away; it stays until the learner moves on. */
  | 'revealed'
  /** The device did not take the word (not connected, error). */
  | 'no-device';

interface Score {
  words: number;
  solved: number;
  /** Solved with no mistake and no hint. */
  clean: number;
}

export function createWordsMode(options: WordsModeOptions = {}): Mode {
  const access = options.progress ?? sessionProgress;
  const list = options.words ?? allWords;
  const random = options.random ?? Math.random;
  const pauseMs = options.pauseMs ?? 300;
  const nextDelayMs = options.nextDelayMs ?? 1500;
  const letterStepMs = options.letterStepMs ?? 1500;
  const hintLeadMs = options.hintLeadMs ?? 1800;

  return {
    id: 'words',
    title: 'Słowa',

    mount(root: HTMLElement, ctx: ModeContext): () => void {
      let phase: Phase = 'idle';
      let word: WordEntry | null = null;
      let hintLevel = 0;
      let mistakes = 0;
      let readyAt: number | null = null;
      const recent: string[] = [];
      const score: Score = { words: 0, solved: 0, clean: 0 };
      // Every user action bumps the generation; async flows (new word,
      // blink, spelling) stop as soon as a newer action took over.
      let gen = 0;
      let alive = true;
      const timers = new Set<ReturnType<typeof setTimeout>>();

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            timers.delete(t);
            resolve();
          }, ms);
          timers.add(t);
        });
      const clearTimers = () => {
        for (const t of timers) clearTimeout(t);
        timers.clear();
      };
      const current = (g: number) => alive && g === gen;

      // --- UI ------------------------------------------------------------
      const intro = h(
        'p',
        { className: 'hint', id: 'words-help' },
        'Na urządzeniu pojawi się słowo z liter, które już znasz. Przeczytaj je palcami, wpisz w pole i naciśnij Enter. ' +
          'Enter w pustym polu zaczyna ćwiczenie i przechodzi dalej po odpowiedzi; słowo pominiesz przyciskiem „Następne słowo”. ' +
          'F1 powtarza polecenie, F2 daje podpowiedź, F3 mruga słowem.',
      );
      const pool = h('p', { id: 'words-pool' });
      const input = h('input', { type: 'text', id: 'words-answer', autocomplete: 'off', spellcheck: false });
      // The short last message, not the long intro: NVDA reads the
      // description on every focus.
      input.setAttribute('aria-describedby', 'words-status');
      input.setAttribute('autocapitalize', 'off');
      const check = h('button', { type: 'submit', className: 'primary' }, 'Sprawdź');
      const nextBtn = h('button', { type: 'button', id: 'words-next' }, 'Następne słowo');
      const repeatBtn = h('button', { type: 'button', id: 'words-repeat' }, 'Powtórz (F1)');
      const hintBtn = h('button', { type: 'button', id: 'words-hint' }, 'Podpowiedź (F2)');
      const blinkBtn = h('button', { type: 'button', id: 'words-blink' }, 'Mrugnij (F3)');
      const helpRow = h('div', { className: 'button-row' }, repeatBtn, hintBtn, blinkBtn);
      helpRow.setAttribute('role', 'group');
      helpRow.setAttribute('aria-label', 'Pomoc');
      const form = h(
        'form',
        { className: 'words-form' },
        h('div', { className: 'field' }, h('label', { htmlFor: 'words-answer' }, 'Twoja odpowiedź'), input),
        h('div', { className: 'button-row' }, check, nextBtn),
        helpRow,
      );

      // Visible copy of the last message for sighted helpers. Not a live
      // region: ctx.say() already speaks it, twice would be noise.
      const status = h('p', { className: 'words-status', id: 'words-status' });
      const reveal = h('p', { className: 'words-reveal', id: 'words-reveal', hidden: true });
      const scoreLine = h('p', { className: 'words-score', id: 'words-score' });
      const history = h('ol', { className: 'words-history', id: 'words-history' });
      const historyBox = h(
        'details',
        { className: 'words-history-box' },
        h('summary', {}, 'Przebieg sesji'),
        history,
      );
      root.append(intro, pool, form, status, reveal, scoreLine, historyBox);

      function say(message: string): void {
        status.textContent = message;
        ctx.say(message);
      }

      function noWordsMessage(): string {
        const first = curriculum.lessons.find((l) => l.kind === 'letters');
        return first
          ? `Brak słów do ćwiczenia. Słowa pojawią się po odblokowaniu lekcji ${first.id} (${first.title}) — zalicz wcześniejszą lekcję w ćwiczeniu Rozpoznawanie.`
          : 'Brak słów do ćwiczenia.';
      }

      function renderPool(): void {
        const available = availableWords(list, access);
        if (available.length === 0) {
          pool.textContent = noWordsMessage();
          return;
        }
        const lesson = access.current();
        const fresh = wordsWithLessonLetters(available, lesson);
        const n = available.length;
        pool.textContent =
          `Dostępnych słów: ${n}.` +
          (fresh.length ? ` Częściej pojawiają się słowa z liter bieżącej lekcji ${lesson.id} (${lesson.items.map((i) => i.key).join(', ')}).` : '');
      }

      function renderScore(): void {
        scoreLine.textContent =
          score.words === 0
            ? 'Wynik sesji: jeszcze nic.'
            : `Wynik sesji: przeczytane ${score.solved} z ${score.words}, w tym ${score.clean} bez błędu i bez podpowiedzi.`;
      }

      function addHistory(text: string): void {
        history.append(h('li', {}, text));
      }

      function showReveal(w: WordEntry | null): void {
        reveal.hidden = !w;
        reveal.replaceChildren();
        if (!w) return;
        const braille = h('span', { className: 'braille-text' }, cellsToBraille(w.cells));
        braille.setAttribute('aria-hidden', 'true');
        reveal.append(`Słowo: ${w.word} `, braille);
      }

      const prompt = (w: WordEntry) => `Przeczytaj słowo. Ma ${letterCount(w.letters.length)}.`;

      /** Tells the learner the device did not take the word. */
      function deviceProblem(r: CommandResult, g: number): void {
        if (!current(g)) return;
        // A revealed word is already scored; it only failed to rise again.
        if (phase !== 'revealed') phase = 'no-device';
        const msg = describeResult(r, 'słowo');
        if (msg) say(`${msg} Gdy urządzenie będzie gotowe, naciśnij F1.`);
      }

      /** Shows the current word (all of it) and prompts once the device confirmed. */
      async function present(g: number, message: (w: WordEntry) => string = prompt): Promise<void> {
        const w = word;
        if (!w) return;
        const r = await ctx.link.show(w.cells);
        if (!current(g)) return;
        if (!shown(r)) return deviceProblem(r, g);
        if (phase === 'showing' || phase === 'no-device') phase = 'ready';
        readyAt ??= ctx.now();
        ctx.tone('ready');
        say(message(w));
      }

      /** Leaves the current word; an unfinished one counts as not read. */
      function closeUnfinished(): void {
        if (!word || !(phase === 'ready' || phase === 'showing' || phase === 'no-device')) return;
        if (readyAt === null) return; // never reached the fingers: nothing to count
        score.words++;
        addHistory(`${word.word} — pominięte`);
        renderScore();
      }

      /**
       * @param announce Ask aloud to lift the fingers (§4.9.2) before the
       *   dots move. Off when the request was already part of the praise.
       */
      async function nextWord(announce = true): Promise<void> {
        const g = ++gen;
        clearTimers();
        // Something may be under the fingers: a word that reached the device.
        const onDevice = word !== null && readyAt !== null;
        closeUnfinished();
        showReveal(null);
        renderPool();
        const w = pickWord(list, access, random, recent);
        if (!w) {
          phase = 'idle';
          word = null;
          say(noWordsMessage());
          return;
        }
        word = w;
        recent.push(w.word);
        if (recent.length > RECENT) recent.shift();
        phase = 'showing';
        hintLevel = 0;
        mistakes = 0;
        readyAt = null;
        input.value = '';
        if (announce && onDevice) say('Zdejmij palce.');
        else status.textContent = 'Nowe słowo pojawia się na urządzeniu…';

        const c = await ctx.link.clear();
        if (!current(g)) return;
        if (!shown(c)) return deviceProblem(c, g);
        await sleep(pauseMs);
        if (!current(g)) return;
        await present(g);
      }

      async function blink(g: number, message: (w: WordEntry) => string): Promise<void> {
        const w = word;
        if (!w) return;
        const c = await ctx.link.clear();
        if (!current(g)) return;
        if (!shown(c)) return deviceProblem(c, g);
        await sleep(pauseMs);
        if (!current(g)) return;
        await present(g, message);
      }

      /** Hint 3: the word rises letter by letter; only the new letter's dots move. */
      async function spell(g: number): Promise<void> {
        const w = word;
        if (!w) return;
        // The lead is its own utterance with time to finish: the next say()
        // would cut it off, and with it the first letter's name.
        say('Podpowiedź 3: litery po kolei.');
        const c = await ctx.link.clear();
        if (!current(g)) return;
        if (!shown(c)) return deviceProblem(c, g);
        await sleep(Math.max(pauseMs, hintLeadMs));
        for (let i = 0; i < w.cells.length; i++) {
          if (!current(g)) return;
          const r = await ctx.link.show(w.cells.slice(0, i + 1));
          if (!current(g)) return;
          if (!shown(r)) return deviceProblem(r, g);
          say(`${ordinal(i)}: ${w.names[i]}`);
          await sleep(letterStepMs);
        }
        if (!current(g)) return;
        ctx.tone('ready');
        say('Całe słowo jest na urządzeniu. Wpisz je.');
      }

      function reveal4(g: number): void {
        const w = word!;
        phase = 'revealed';
        score.words++;
        addHistory(`${w.word} — pokazane w podpowiedzi`);
        renderScore();
        showReveal(w);
        void present(
          g,
          () => `Podpowiedź 4: to słowo „${w.word}”. Litery: ${w.names.join(', ')}. Naciśnij Enter, aby przejść do następnego słowa.`,
        );
      }

      function notNow(): boolean {
        switch (phase) {
          case 'idle':
            say(word === null && availableWords(list, access).length === 0 ? noWordsMessage() : 'Naciśnij Enter w polu odpowiedzi albo przycisk „Następne słowo”, aby zacząć.');
            return true;
          case 'showing':
            say('Chwileczkę, słowo jeszcze się wysuwa.');
            return true;
          case 'solved':
            say('Za chwilę następne słowo.');
            return true;
          default:
            return false;
        }
      }

      // --- Actions -------------------------------------------------------
      function repeat(): void {
        if (notNow()) return;
        const g = ++gen;
        if (phase === 'revealed') {
          void present(g, (w) => `To słowo „${w.word}”. Naciśnij Enter, aby przejść dalej.`);
        } else {
          void present(g);
        }
      }

      function doBlink(): void {
        if (notNow()) return;
        const g = ++gen;
        void blink(g, (w) => (phase === 'revealed' ? `To słowo „${w.word}”.` : `Mrugnięcie. ${prompt(w)}`));
      }

      function hint(): void {
        if (notNow()) return;
        if (phase === 'revealed') {
          say('To już ostatnia podpowiedź. Naciśnij Enter, aby przejść do następnego słowa.');
          return;
        }
        if (phase === 'no-device') {
          repeat();
          return;
        }
        const g = ++gen;
        hintLevel = Math.min(MAX_HINT, hintLevel + 1);
        switch (hintLevel) {
          case 1:
            void blink(g, (x) => `Podpowiedź 1: mrugnięcie. Słowo wysunęło się ponownie. Ma ${letterCount(x.letters.length)}.`);
            break;
          case 2:
            // Through present(): if hint 1 was still blinking (F2 pressed
            // twice), the word must rise again. Already up -> no motion.
            void present(g, (x) => `Podpowiedź 2: pierwsza litera to ${x.names[0]}.`);
            break;
          case 3:
            void spell(g);
            break;
          default:
            reveal4(g);
        }
      }

      function answer(text: string): void {
        const typed = normalizeAnswer(text);
        switch (phase) {
          case 'solved':
            void nextWord(false); // the praise already asked to lift the fingers
            return;
          case 'idle':
          case 'revealed':
            void nextWord();
            return;
          case 'showing':
            say('Chwileczkę, słowo jeszcze się wysuwa. Odpowiedz po sygnale.');
            return;
          case 'no-device':
            if (typed === '') {
              void nextWord();
            } else {
              say('Słowa nie ma na urządzeniu. Połącz urządzenie i naciśnij F1, aby je pokazać.');
            }
            return;
          case 'ready':
            break;
        }
        const w = word!;
        if (typed === '') {
          say('Wpisz słowo i naciśnij Enter. F2 daje podpowiedź.');
          return;
        }
        if (typed === w.word) {
          gen++; // stops a running hint
          clearTimers();
          const ms = readyAt === null ? null : Math.max(0, ctx.now() - readyAt);
          const clean = mistakes === 0 && hintLevel === 0;
          score.words++;
          score.solved++;
          if (clean) score.clean++;
          phase = 'solved';
          input.value = '';
          const time = ms === null ? '' : `, ${(ms / 1000).toFixed(1).replace('.', ',')} s`;
          const how = clean ? 'dobrze' : hintLevel ? `dobrze, z podpowiedzią ${hintLevel}` : `dobrze, po ${mistakes} ${plural(mistakes, 'błędzie', 'błędach', 'błędach')}`;
          addHistory(`${w.word} — ${how}${time}`);
          renderScore();
          showReveal(w);
          ctx.tone('correct');
          say(`Dobrze, ${w.word}. Zdejmij palce.`);
          const t = setTimeout(() => {
            timers.delete(t);
            if (alive && phase === 'solved') void nextWord(false);
          }, nextDelayMs);
          timers.add(t);
          return;
        }
        mistakes++;
        ctx.tone('wrong');
        const typedLetters = Array.from(typed);
        const note =
          typedLetters.length !== w.letters.length
            ? `Słowo ma ${letterCount(w.letters.length)}.`
            : letterFeedback(typedLetters, w.letters);
        say(`Nie, to nie „${text.trim()}”.${note ? ` ${note}` : ''} Spróbuj jeszcze raz. F2 daje podpowiedź.`);
        if (document.activeElement === input) input.select();
      }

      // --- Wiring --------------------------------------------------------
      const onSubmit = (e: Event) => {
        e.preventDefault();
        answer(input.value);
      };
      const onNext = () => void nextWord();
      form.addEventListener('submit', onSubmit);
      nextBtn.addEventListener('click', onNext);
      repeatBtn.addEventListener('click', repeat);
      hintBtn.addEventListener('click', hint);
      blinkBtn.addEventListener('click', doBlink);
      ctx.setKeys({ repeat, hint, blink: doBlink });

      renderPool();
      renderScore();

      return () => {
        alive = false;
        gen++;
        clearTimers();
        ctx.setKeys(null);
        form.removeEventListener('submit', onSubmit);
        nextBtn.removeEventListener('click', onNext);
        repeatBtn.removeEventListener('click', repeat);
        hintBtn.removeEventListener('click', hint);
        blinkBtn.removeEventListener('click', doBlink);
        root.replaceChildren();
      };
    },
  };
}

/** The mode as registered in the app: the learner's own course progress. */
export const wordsMode: Mode = createWordsMode();
