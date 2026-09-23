// Mode "Poznaj znak" (docs/DYDAKTYKA.md §4.1, §4.2): presentation, no quiz.
// One character of the chosen lesson stands on cell 2 with the other cells
// blank; the app names it and its dots only after the device confirmed the
// move. Variants: dot-by-dot build-up (each dot named as it rises), blink, the whole lesson
// on all 5 cells, and the decade rule animated in place (a–e + dot 3 -> k–o:
// thanks to the device's diff only the added dots move). Nothing here is
// scored, so no attempts are recorded.

import './learn.css';
import { maskToDots } from '../braille/table';
import { cellsToBraille } from '../braille/translator';
import type { CommandResult, DeviceLink } from '../device/DeviceLink';
import type { Unsubscribe } from '../device/transport';
import { curriculum, lessonById, type Lesson, type LessonItem } from '../learn/curriculum';
import { progress } from '../learn/session';
import { describeResult } from './displayText';
import type { Mode, ModeContext } from './types';

const CELLS = 5;
/** Cell 2 (index 1): easy to find, blank cells on both sides. */
export const ITEM_CELL = 1;
/** Cascade step used for dot-by-dot and the rule animation (ms per dot). */
export const SLOW_STEP_MS = 400;
/** How long a blink keeps the dots down. */
export const BLINK_MS = 300;
/** Dot by dot: pause after clearing (DYDAKTYKA §4.9.1) and after each named dot. */
export const CLEAR_PAUSE_MS = 300;
export const DOT_STEP_MS = 800;
/**
 * The lesson picker announces the new lesson only after this quiet time, so
 * arrowing through a closed <select> (a change event per key press in Chrome)
 * does not talk over the screen reader reading the options.
 */
export const LESSON_ANNOUNCE_MS = 700;

/**
 * Links on which anim(0) did not get through after this mode slowed the
 * cascade (link closed or a timeout). The firmware keeps the step delay until
 * reboot, so anim(0) is retried every time the link becomes ready again, also
 * after the mode was unmounted. Value: unsubscribes the retry listener.
 */
const pendingRestore = new Map<DeviceLink, Unsubscribe>();

function dropRestoreRetry(link: DeviceLink): void {
  pendingRestore.get(link)?.();
  pendingRestore.delete(link);
}

/** Sends anim(0); on anything but 'ok' keeps retrying on the next 'ready'. */
async function restoreStep(link: DeviceLink): Promise<void> {
  const r = await link.anim(0);
  if (r.status === 'ok') {
    dropRestoreRetry(link);
    return;
  }
  if (!pendingRestore.has(link)) {
    pendingRestore.set(
      link,
      link.on('state', (state) => {
        if (state === 'ready') void restoreStep(link);
      }),
    );
  }
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

// --- Spoken texts (exported for tests) ----------------------------------------

const POSITION: Record<number, [column: string, row: string]> = {
  1: ['lewa', 'na górze'],
  2: ['lewa', 'pośrodku'],
  3: ['lewa', 'na dole'],
  4: ['prawa', 'na górze'],
  5: ['prawa', 'pośrodku'],
  6: ['prawa', 'na dole'],
};

/** "lewa kolumna, na dole" for dot 3. */
export function dotPosition(dot: number): string {
  const [col, row] = POSITION[dot] ?? ['?', '?'];
  return `${col} kolumna, ${row}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

/** "3" / "3 i 6" / "1, 2 i 4". */
function andList(parts: readonly (string | number)[]): string {
  const s = parts.map(String);
  return s.length <= 1 ? s.join('') : `${s.slice(0, -1).join(', ')} i ${s[s.length - 1]}`;
}

/** "Punkt 1." / "Punkty 1, 3, 4." */
export function dotsPhrase(mask: number): string {
  const dots = maskToDots(mask);
  return `${dots.length === 1 ? 'Punkt' : 'Punkty'} ${dots.join(', ')}.`;
}

/** Swaps the columns: 1<->4, 2<->5, 3<->6. */
export function mirrorMask(mask: number): number {
  return ((mask & 0b000111) << 3) | ((mask >> 3) & 0b000111);
}

/**
 * Mirror pairs (columns swapped) are the most common confusion. Among the
 * course letters they are e/i, d/f, h/j, r/w, o/ś, s/ę, z/ź, u/ó, y/ż, m/ć and
 * p/ń (checked with mirrorMask; n and t have no mirror letter, so the n/t and
 * o/s pairs listed in DYDAKTYKA §1.4 are not mirrors). Name the partner once
 * the learner has met it (this or an earlier lesson).
 */
export function mirrorNote(lesson: Lesson, item: LessonItem): string {
  if (lesson.kind !== 'letters') return '';
  const m = mirrorMask(item.mask);
  if (m === item.mask) return '';
  const upTo = curriculum.lessons.indexOf(lesson);
  for (const l of curriculum.lessons.slice(0, upTo + 1)) {
    if (l.kind !== 'letters') continue;
    const other = l.items.find((i) => i.mask === m);
    if (other) return `Uwaga: to lustrzane odbicie litery ${other.spoken}.`;
  }
  return '';
}

/** "z dodanym punktem 3" / "z dodanymi punktami 3 i 6" (instrumental case). */
function withAddedDots(dots: readonly number[]): string {
  return dots.length === 1 ? `z dodanym punktem ${dots[0]}` : `z dodanymi punktami ${andList(dots)}`;
}

const DOT6 = 0b100000;

/**
 * The letter this one is built from (DYDAKTYKA §2.1: "10 shapes and 2
 * rules"), e.g. "Ka to a z dodanym punktem 3.". Rule lessons (k–t, u–z) use
 * their rule. A Polish letter whose mask minus dot 6 is a letter from an
 * earlier lesson gets "that letter + 6" (§1.2: ą = a + 6, ł = be + 6, ...).
 * The base is found by shape, never by sound (ł is not l + 6); ó (346 minus 6
 * = 34, no letter) gets nothing, and w stays the exception of L6.
 */
export function baseNote(lesson: Lesson, item: LessonItem): string {
  if (lesson.kind !== 'letters') return '';
  const i = lesson.items.indexOf(item);
  if (lesson.rule && i >= 0) {
    const base = lessonById(lesson.rule.from)?.items[i];
    if (base) return `${capitalize(item.spoken)} to ${base.spoken} ${withAddedDots(lesson.rule.addDots)}.`;
  }
  if (/^[a-z]$/.test(item.answer) || !(item.mask & DOT6)) return '';
  const baseMask = item.mask & ~DOT6;
  for (const l of curriculum.lessons.slice(0, curriculum.lessons.indexOf(lesson))) {
    if (l.kind !== 'letters') continue;
    const base = l.items.find((x) => x.mask === baseMask);
    if (base) return `${capitalize(item.spoken)} to ${base.spoken} ${withAddedDots([6])}.`;
  }
  return '';
}

/**
 * "To jest em. Punkty 1, 3, 4." or, in L0, "Punkt 3. Lewa kolumna, na dole."
 * The base letter (the memory hook) comes before the mirror warning.
 */
export function describeItem(lesson: Lesson, item: LessonItem): string {
  if (lesson.kind === 'dots') {
    const dot = maskToDots(item.mask)[0] ?? 0;
    return `Punkt ${dot}. ${capitalize(dotPosition(dot))}.`;
  }
  return [`To jest ${item.spoken}.`, dotsPhrase(item.mask), baseNote(lesson, item), mirrorNote(lesson, item)]
    .filter(Boolean)
    .join(' ');
}

/** F2: where every dot of the item is. */
export function describePositions(lesson: Lesson, item: LessonItem): string {
  const dots = maskToDots(item.mask);
  if (lesson.kind === 'dots') {
    const dot = dots[0] ?? 0;
    const col = dot <= 3 ? 'lewej' : 'prawej';
    const nth = ['górny', 'środkowy', 'dolny'][(dot - 1) % 3];
    return `Punkt ${dot} to ${nth} punkt ${col} kolumny. Lewa kolumna od góry: 1, 2, 3; prawa: 4, 5, 6.`;
  }
  const where = dots.map((d) => `${d} — ${dotPosition(d)}`).join('; ');
  return `Litera ${item.spoken} ma ${dots.length} ${plural(dots.length, 'punkt', 'punkty', 'punktów')}: ${where}.`;
}

/** "punkt 3" / "punkty 3 i 6" */
function addedDots(dots: readonly number[]): string {
  return `${dots.length === 1 ? 'punkt' : 'punkty'} ${andList(dots)}`;
}

function spokenList(items: readonly LessonItem[]): string {
  return items.map((i) => i.spoken).join(', ');
}

export function ruleIntro(base: Lesson, addDots: readonly number[], actionLabel: string): string {
  const verb = addDots.length === 1 ? 'wysunie się' : 'wysuną się';
  return (
    `To są litery ${spokenList(base.items)}. Teraz na każdej komórce ${verb} ${addedDots(addDots)}. ` +
    `Połóż palce lekko na komórkach, bez nacisku, i naciśnij „${actionLabel}”. Punkty wysuwają się powoli.`
  );
}

export function ruleResult(lesson: Lesson): string {
  return `Powstały litery ${spokenList(lesson.items)}.`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- Mode ------------------------------------------------------------------------

type RuleStage = 'idle' | 'base';

export const learnMode: Mode = {
  id: 'learn',
  title: 'Poznaj znak',

  mount(root: HTMLElement, ctx: ModeContext): () => void {
    const lessons = curriculum.lessons.filter((l) => progress.status(l.id) !== 'locked');
    let lesson: Lesson = progress.current();
    let index = 0;
    let wholePage = 0;
    let ruleStage: RuleStage = 'idle';

    /** Bumped by every device action; an older one stops at its next await. */
    let token = 0;
    let disposed = false;
    /** A slow-cascade sequence is running; other device actions wait for it. */
    let sequence = false;
    /** anim was set to a slow step and not yet restored. */
    let animChanged = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    /**
     * What this mode last asked the device to show, for blink. Set before the
     * show is awaited, so a blink pressed while a move is still on its way
     * repeats the new view, not the one it replaces.
     */
    let displayed: { cells: number[]; label: string } | null = null;
    let announceTimer: ReturnType<typeof setTimeout> | null = null;

    // --- DOM ---------------------------------------------------------------

    const select = h('select', { id: 'learn-lesson' });
    select.setAttribute('aria-describedby', 'learn-lesson-note');
    for (const l of lessons) {
      const passed = progress.status(l.id) === 'passed' ? ' (zaliczona)' : '';
      select.append(h('option', { value: l.id }, `${l.id}: ${l.title}${passed}`));
    }
    select.value = lesson.id;

    const note = h('p', { className: 'hint', id: 'learn-lesson-note' });
    const glyph = h('span', { className: 'braille-text learn-glyph' });
    glyph.setAttribute('aria-hidden', 'true');
    const itemText = h('span', { id: 'learn-item-text' });
    const itemBox = h('p', { className: 'learn-item', id: 'learn-item' }, glyph, itemText);

    const btn = (label: string, id: string, shortcut?: string) => {
      const b = h('button', { type: 'button', id }, label);
      if (shortcut) b.setAttribute('aria-keyshortcuts', shortcut);
      return b;
    };
    const prevBtn = btn('Poprzedni', 'learn-prev');
    const nextBtn = btn('Następny', 'learn-next');
    const repeatBtn = btn('Powtórz (F1)', 'learn-repeat', 'F1');
    const hintBtn = btn('Gdzie są punkty (F2)', 'learn-hint', 'F2');
    const blinkBtn = btn('Mrugnij (F3)', 'learn-blink', 'F3');
    const dotsBtn = btn('Punkt po punkcie', 'learn-dots');
    const wholeBtn = btn('Cała lekcja', 'learn-whole');
    const ruleBtn = btn('Pokaż regułę', 'learn-rule');

    const group = (label: string, ...buttons: HTMLButtonElement[]) => {
      const row = h('div', { className: 'button-row' }, ...buttons);
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', label);
      return row;
    };

    root.classList.add('learn');
    root.append(
      h(
        'p',
        { className: 'hint' },
        'Znak pojawia się na komórce 2, pozostałe komórki są puste. Nazwa i punkty padają dopiero, gdy punkty są już wysunięte. ' +
          'Skróty: F1 powtórz, F2 gdzie są punkty, F3 mrugnij.',
      ),
      h('div', { className: 'field' }, h('label', { htmlFor: 'learn-lesson' }, 'Lekcja'), select),
      note,
      itemBox,
      group('Znak', prevBtn, nextBtn, repeatBtn, hintBtn),
      group('Pokaz na urządzeniu', dotsBtn, blinkBtn, wholeBtn, ruleBtn),
    );

    const item = (): LessonItem => lesson.items[index]!;
    const itemCells = (it: LessonItem): number[] => {
      const cells = new Array<number>(CELLS).fill(0);
      cells[ITEM_CELL] = it.mask;
      return cells;
    };
    const ruleActionLabel = (): string => `Dodaj ${addedDots(lesson.rule?.addDots ?? [])}`;

    // Updates text and attributes in place: the buttons are never replaced,
    // so keyboard and screen-reader focus stays where the learner left it.
    function render(): void {
      const it = item();
      const n = lesson.items.length;
      note.textContent = lesson.note;
      glyph.textContent = cellsToBraille([it.mask]);
      itemText.textContent =
        lesson.kind === 'dots'
          ? `Znak ${index + 1} z ${n}: punkt ${it.answer} — ${dotPosition(Number(it.answer))}.`
          : `Znak ${index + 1} z ${n}: ${it.answer} (${it.spoken}) — ${dotsPhrase(it.mask).toLowerCase()}`;
      // aria-disabled instead of disabled: a disabled button would drop focus.
      prevBtn.setAttribute('aria-disabled', String(index === 0));
      nextBtn.setAttribute('aria-disabled', String(index === n - 1));
      const pages = Math.ceil(n / CELLS);
      wholeBtn.textContent = pages > 1 ? `Cała lekcja (${(wholePage % pages) + 1}/${pages})` : 'Cała lekcja';
      ruleBtn.hidden = !lesson.rule;
      ruleBtn.textContent = ruleStage === 'base' ? ruleActionLabel() : 'Pokaż regułę';
    }

    // --- Device helpers ----------------------------------------------------

    function cancelAnnounce(): void {
      if (announceTimer !== null) globalThis.clearTimeout(announceTimer);
      announceTimer = null;
    }

    function begin(): number | null {
      if (disposed) return null;
      if (sequence) {
        ctx.say('Poczekaj, punkty jeszcze się wysuwają.');
        return null;
      }
      cancelAnnounce();
      return ++token;
    }
    const alive = (t: number) => !disposed && t === token;

    /** true for ok/skipped (the dots are there); otherwise tells the learner why not. */
    function landed(r: CommandResult, t: number, what: string): boolean {
      if (!alive(t)) return false;
      if (r.status === 'ok' || r.status === 'skipped') return true;
      const msg = describeResult(r, what);
      if (msg) ctx.say(msg);
      return false;
    }

    function ready(message: string): void {
      ctx.say(message);
      ctx.tone('ready');
    }

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const id = globalThis.setTimeout(() => {
          timers.delete(id);
          resolve();
        }, ms);
        timers.add(id);
      });
    }

    function setSlow(): Promise<CommandResult> {
      animChanged = true;
      // This run restores the step itself; an older retry would fire mid-cascade.
      dropRestoreRetry(ctx.link);
      return ctx.link.anim(SLOW_STEP_MS);
    }
    /** anim(0); if it does not get through, restoreStep keeps retrying on reconnect. */
    async function restoreAnim(): Promise<void> {
      if (!animChanged) return;
      animChanged = false;
      await restoreStep(ctx.link);
    }

    // --- Actions -----------------------------------------------------------

    async function present(): Promise<void> {
      const t = begin();
      if (t === null) return;
      ruleStage = 'idle';
      render();
      const it = item();
      const cells = itemCells(it);
      displayed = { cells, label: it.spoken };
      const r = await ctx.link.show(cells);
      if (!landed(r, t, it.spoken)) return;
      ready(describeItem(lesson, it));
    }

    function step(delta: -1 | 1): void {
      const target = index + delta;
      if (target < 0) {
        ctx.say('To jest pierwszy znak tej lekcji.');
        return;
      }
      if (target >= lesson.items.length) {
        ctx.say('To jest ostatni znak tej lekcji. Możesz wybrać „Cała lekcja” albo następną lekcję.');
        return;
      }
      if (sequence) {
        ctx.say('Poczekaj, punkty jeszcze się wysuwają.');
        return;
      }
      index = target;
      void present();
    }

    /**
     * DYDAKTYKA §4.1: the dots rise one at a time and each is named as it
     * lands ("punkt 1… punkt 3… punkt 4"). Each step shows the dots so far;
     * the device's diff moves only the new dot, so no slow anim is needed.
     * Any other action (Następny, F1, F3…) interrupts it.
     */
    async function dotByDot(): Promise<void> {
      const t = begin();
      if (t === null) return;
      ruleStage = 'idle';
      render();
      const it = item();
      displayed = { cells: itemCells(it), label: it.spoken };
      // A cue before anything moves, so the button press is not met by silence.
      ctx.say('Punkt po punkcie.');
      if (!landed(await ctx.link.clear(), t, it.spoken)) return;
      await wait(CLEAR_PAUSE_MS);
      if (!alive(t)) return;
      const dots = maskToDots(it.mask);
      let mask = 0;
      for (const dot of dots) {
        mask |= 1 << (dot - 1);
        const cells = new Array<number>(CELLS).fill(0);
        cells[ITEM_CELL] = mask;
        if (!landed(await ctx.link.show(cells), t, it.spoken)) return;
        // A single dot is named by the summary right away.
        if (dots.length === 1) break;
        ctx.say(`Punkt ${dot}.`);
        await wait(DOT_STEP_MS);
        if (!alive(t)) return;
      }
      ready(describeItem(lesson, it));
    }

    async function blink(): Promise<void> {
      const t = begin();
      if (t === null) return;
      const it = item();
      const shown = displayed ?? { cells: itemCells(it), label: it.spoken };
      if (!landed(await ctx.link.clear(), t, shown.label)) return;
      await wait(BLINK_MS);
      if (!alive(t)) return;
      if (!landed(await ctx.link.show(shown.cells), t, shown.label)) return;
      displayed = shown;
      ready(`Wysunięte ponownie: ${shown.label}.`);
    }

    async function showWhole(): Promise<void> {
      const t = begin();
      if (t === null) return;
      ruleStage = 'idle';
      const pages = chunk(lesson.items, CELLS);
      const page = wholePage % pages.length;
      const items = pages[page]!;
      wholePage = (page + 1) % pages.length;
      render();
      const cells = items.map((i) => i.mask);
      const label = spokenList(items);
      displayed = { cells, label };
      if (!landed(await ctx.link.show(cells), t, label)) return;
      const parts = [
        lesson.kind === 'dots'
          ? `Na kolejnych komórkach od lewej: ${label}.`
          : `Lekcja ${lesson.id} na komórkach od lewej: ${label}.`,
      ];
      if (pages.length > 1) {
        const rest = pages.slice(page + 1).flat();
        parts.push(
          rest.length
            ? `Dalej ${rest.length === 1 ? 'jest' : 'są'} ${spokenList(rest)}. Naciśnij „Cała lekcja” jeszcze raz.`
            : `To koniec lekcji, strona ${page + 1} z ${pages.length}.`,
        );
      }
      ready(parts.join(' '));
    }

    async function rule(): Promise<void> {
      const r = lesson.rule;
      if (!r) return;
      const base = lessonById(r.from);
      if (!base) return;
      if (ruleStage === 'idle') {
        const t = begin();
        if (t === null) return;
        const cells = base.items.map((i) => i.mask);
        const label = spokenList(base.items);
        displayed = { cells, label };
        if (!landed(await ctx.link.show(cells), t, label)) return;
        ruleStage = 'base';
        render();
        // The learner puts the fingers on the row first; the change comes on
        // their own key press, never on a timer.
        ready(ruleIntro(base, r.addDots, ruleActionLabel()));
        return;
      }
      const t = begin();
      if (t === null) return;
      sequence = true;
      const cells = lesson.items.map((i) => i.mask);
      const label = spokenList(lesson.items);
      try {
        if (!landed(await setSlow(), t, label)) return;
        displayed = { cells, label };
        // Only the added dots differ from the base row, so only they move.
        if (!landed(await ctx.link.show(cells), t, label)) return;
        await restoreAnim();
        if (!alive(t)) return;
        ruleStage = 'idle';
        render();
        ready(ruleResult(lesson));
      } finally {
        await restoreAnim();
        sequence = false;
      }
    }

    function hint(): void {
      ctx.say(describePositions(lesson, item()));
    }

    // --- Events ------------------------------------------------------------

    const onLesson = () => {
      const next = lessonById(select.value);
      if (!next) return;
      if (sequence) {
        select.value = lesson.id;
        ctx.say('Poczekaj, punkty jeszcze się wysuwają.');
        return;
      }
      // WCAG 3.2.2: choosing a lesson moves nothing. Chrome fires 'change'
      // on every arrow key in a closed <select>; the learner shows the first
      // character with F1 once they settled on a lesson.
      token++; // an older action of the previous lesson stays silent
      lesson = next;
      index = 0;
      wholePage = 0;
      ruleStage = 'idle';
      displayed = null;
      render();
      cancelAnnounce();
      announceTimer = globalThis.setTimeout(() => {
        announceTimer = null;
        if (disposed) return;
        ctx.say(`Lekcja ${lesson.id} wybrana. ${lesson.note} Naciśnij Powtórz (F1), aby pokazać pierwszy znak.`);
      }, LESSON_ANNOUNCE_MS);
    };
    const onPrev = () => step(-1);
    const onNext = () => step(1);
    const onRepeat = () => void present();
    const onBlink = () => void blink();
    const onDots = () => void dotByDot();
    const onWhole = () => void showWhole();
    const onRule = () => void rule();

    const listeners: Array<[HTMLElement, string, () => void]> = [
      [select, 'change', onLesson],
      [prevBtn, 'click', onPrev],
      [nextBtn, 'click', onNext],
      [repeatBtn, 'click', onRepeat],
      [hintBtn, 'click', hint],
      [blinkBtn, 'click', onBlink],
      [dotsBtn, 'click', onDots],
      [wholeBtn, 'click', onWhole],
      [ruleBtn, 'click', onRule],
    ];
    for (const [el, ev, fn] of listeners) el.addEventListener(ev, fn);
    ctx.setKeys({ repeat: onRepeat, hint, blink: onBlink });

    render();
    void present();

    return () => {
      disposed = true;
      token++;
      for (const id of timers) globalThis.clearTimeout(id);
      timers.clear();
      cancelAnnounce();
      ctx.setKeys(null);
      if (animChanged) {
        animChanged = false;
        // Retried on the next 'ready' if it does not get through now.
        void restoreStep(ctx.link);
      }
      for (const [el, ev, fn] of listeners) el.removeEventListener(ev, fn);
      root.classList.remove('learn');
      root.replaceChildren();
    };
  },
};
