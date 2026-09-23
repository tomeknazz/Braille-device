// Mode "Kurs": the lesson list L0-L7 with lock state and progress, and a
// button that lays a lesson's characters under the fingers (one lesson = one
// row of 5 cells). Attempts are recorded by the exercise modes; this view
// only reads them.

import { cellsToBraille } from '../braille/translator';
import { curriculum, type Lesson, type LessonItem } from '../learn/curriculum';
import type { LessonStats, LessonStatus } from '../learn/progress';
import { BOXES, boxCounts, cardKey, dueCount } from '../learn/leitner';
import { leitner, persist, progress, resetAll } from '../learn/session';
import { describeResult } from './displayText';
import type { Mode, ModeContext } from './types';

const CELLS = 5;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const STATUS_TEXT: Record<LessonStatus, string> = {
  locked: 'zablokowana',
  available: 'dostępna',
  passed: 'zaliczona',
};

export function describeStats(s: LessonStats, window: number): string {
  if (s.attempts === 0) return `Brak prób. Do zaliczenia potrzeba ${window} prób.`;
  const pct = Math.round((s.accuracy ?? 0) * 100);
  const base = `Wynik z ostatnich prób (${s.attempts}): poprawnie ${s.correct}, czyli ${pct}%.`;
  // "brakuje" takes the genitive: 1 próby, 2+ prób.
  return s.missing > 0 ? `${base} Do oceny brakuje jeszcze ${s.missing} ${s.missing === 1 ? 'próby' : 'prób'}.` : base;
}

/** "w pudełku 1: 3, w pudełku 2: 1, opanowane: 2" for the cards among `keys`. */
export function describeBoxes(keys: readonly string[]): string {
  const counts = boxCounts(leitner, keys);
  const parts = BOXES.filter((b) => counts[b].length).map((b) =>
    b === 5 ? `opanowane: ${counts[b].length}` : `w pudełku ${b}: ${counts[b].length}`,
  );
  return parts.length ? parts.join(', ') : 'jeszcze żaden znak nie był ćwiczony';
}

/** Per lesson: which characters sit in which box ("opanowane: a, b; pudełko 1: d"). */
export function describeLessonBoxes(lesson: Lesson): string {
  // Dots are named ("punkt 3"): bare numbers would sound like counts.
  const keyOf = new Map(lesson.items.map((i) => [cardKey(i.key), lesson.kind === 'dots' ? i.spoken : i.key]));
  const counts = boxCounts(leitner, [...keyOf.keys()]);
  const parts = BOXES.filter((b) => counts[b].length).map(
    (b) => `${b === 5 ? 'opanowane' : `pudełko ${b}`}: ${counts[b].map((k) => keyOf.get(k)).join(', ')}`,
  );
  return parts.length ? `Powtórki — ${parts.join('; ')}.` : 'Powtórki — jeszcze bez ćwiczeń.';
}

function chunk(items: readonly LessonItem[], size: number): LessonItem[][] {
  const out: LessonItem[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Visual braille of the lesson; hidden from screen readers, which get the letters instead. */
function brailleSpan(lesson: Lesson): HTMLSpanElement {
  const span = h('span', { className: 'braille-text' }, cellsToBraille(lesson.items.map((i) => i.mask)));
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function itemsLabel(lesson: Lesson): string {
  return lesson.kind === 'dots'
    ? lesson.items.map((i) => i.answer).join(', ')
    : lesson.items.map((i) => i.key).join(', ');
}

export const courseMode: Mode = {
  id: 'course',
  title: 'Kurs',

  mount(root: HTMLElement, ctx: ModeContext): () => void {
    const { window, minAccuracy } = curriculum.unlock;
    const pages = new Map<string, number>(); // lesson id -> next page to show

    const intro = h(
      'p',
      { className: 'hint', id: 'course-rule' },
      `Każda lekcja to 5 znaków — cały rząd urządzenia. Następna lekcja odblokowuje się, gdy w ostatnich ${window} próbach ` +
        `bieżącej masz co najmniej ${Math.round(minAccuracy * 100)}% poprawnych odpowiedzi. ` +
        'Próby zapisują ćwiczenia Rozpoznawanie i Powtórki (w Powtórkach tylko znaki bieżącej lekcji).',
    );
    const current = h('p', { className: 'course-current', id: 'course-current' });
    const reviewLine = h('p', { id: 'course-review' });
    const list = h('ol', { className: 'lesson-list', id: 'lesson-list' });

    const teacherBox = h('input', { type: 'checkbox', id: 'teacher-unlock' });
    const resetBtn = h('button', { type: 'button', id: 'course-reset' }, 'Wyzeruj postępy i powtórki');
    const teacher = h(
      'details',
      { className: 'teacher-options' },
      h('summary', {}, 'Opcje nauczyciela'),
      h('label', { className: 'checkbox' }, teacherBox, 'Odblokuj wszystkie lekcje (np. do pokazu)'),
      h('p', { className: 'hint' }, 'Zaliczenia i historia prób zostają. Wyłączenie przywraca zwykłe zasady.'),
      h('div', { className: 'button-row' }, resetBtn),
    );

    // Re-rendering replaces the buttons; `focusLesson` puts keyboard and
    // screen-reader focus back on the button that was just used.
    function render(focusLesson?: string): void {
      const cur = progress.current();
      current.textContent = `Bieżąca lekcja: ${cur.id} — ${cur.title}.`;
      const openKeys = curriculum.lessons
        .filter((l) => progress.status(l.id) !== 'locked')
        .flatMap((l) => l.items.map((i) => cardKey(i.key)));
      reviewLine.textContent =
        `Powtórki (sesja nr ${leitner.session}): ${describeBoxes(openKeys)}. ` +
        `Na najbliższą sesję czeka: ${dueCount(leitner, openKeys)}.`;
      teacherBox.checked = progress.teacherUnlocked;
      list.replaceChildren(
        ...curriculum.lessons.map((lesson) => {
          const status = progress.status(lesson.id);
          const stats = progress.stats(lesson.id);
          const headingId = `lesson-${lesson.id}-title`;
          const pageCount = Math.ceil(lesson.items.length / CELLS);
          const nextPage = pages.get(lesson.id) ?? 0;

          const show = h(
            'button',
            { type: 'button', disabled: status === 'locked' },
            pageCount > 1 ? `Pokaż na urządzeniu (${nextPage + 1}/${pageCount})` : 'Pokaż na urządzeniu',
          );
          show.setAttribute('aria-describedby', headingId);
          show.dataset['lesson'] = lesson.id;
          show.addEventListener('click', () => void showLesson(lesson));

          const li = h(
            'li',
            { className: `lesson lesson-${status}` },
            h('h4', { id: headingId }, `${lesson.id}: ${lesson.title} `, h('span', { className: 'lesson-status' }, `(${STATUS_TEXT[status]})`)),
            h(
              'p',
              { className: 'lesson-items' },
              brailleSpan(lesson),
              ' ',
              h('span', {}, lesson.kind === 'dots' ? `Punkty: ${itemsLabel(lesson)}` : `Znaki: ${itemsLabel(lesson)}`),
            ),
            h('p', { className: 'hint' }, lesson.note),
            h('p', { className: 'lesson-stats' }, status === 'locked' ? 'Zalicz poprzednią lekcję, aby odblokować.' : describeStats(stats, window)),
            ...(status === 'locked' ? [] : [h('p', { className: 'lesson-boxes' }, describeLessonBoxes(lesson))]),
            h('div', { className: 'button-row' }, show),
          );
          if (lesson.id === cur.id && status !== 'passed') li.setAttribute('aria-current', 'step');
          return li;
        }),
      );
      if (focusLesson) list.querySelector<HTMLButtonElement>(`button[data-lesson="${focusLesson}"]`)?.focus();
    }

    async function showLesson(lesson: Lesson): Promise<void> {
      const chunks = chunk(lesson.items, CELLS);
      const page = (pages.get(lesson.id) ?? 0) % chunks.length;
      const items = chunks[page]!;
      pages.set(lesson.id, (page + 1) % chunks.length);
      render(lesson.id);
      const what =
        lesson.kind === 'dots'
          ? `${items.map((i) => i.spoken).join(', ')} na kolejnych komórkach`
          : `lekcja ${lesson.id}: ${items.map((i) => i.spoken).join(', ')}`;
      const r = await ctx.link.show(items.map((i) => i.mask));
      const msg = describeResult(r, what);
      if (msg) ctx.announce(msg);
    }

    let resetArmed = false;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    function disarmReset(): void {
      resetArmed = false;
      resetBtn.textContent = 'Wyzeruj postępy i powtórki';
      clearTimeout(resetTimer);
    }

    const onTeacher = () => {
      progress.setTeacherUnlocked(teacherBox.checked);
      persist();
      render();
      ctx.announce(teacherBox.checked ? 'Wszystkie lekcje odblokowane.' : 'Przywrócono zwykłe zasady odblokowania.');
    };
    // Two-step reset instead of a modal confirm(): the first press arms it.
    const onReset = () => {
      if (!resetArmed) {
        resetArmed = true;
        resetBtn.textContent = 'Na pewno? Naciśnij ponownie, aby wyzerować';
        ctx.announce('Naciśnij ponownie w ciągu 5 sekund, aby wyzerować wszystkie postępy i pudełka powtórek.');
        resetTimer = setTimeout(disarmReset, 5000);
        return;
      }
      disarmReset();
      resetAll();
      pages.clear();
      render();
      ctx.announce('Postępy i powtórki wyzerowane. Zaczynasz od lekcji L0.');
    };
    teacherBox.addEventListener('change', onTeacher);
    resetBtn.addEventListener('click', onReset);

    root.append(intro, current, reviewLine, list, teacher);
    render();

    return () => {
      clearTimeout(resetTimer);
      teacherBox.removeEventListener('change', onTeacher);
      resetBtn.removeEventListener('click', onReset);
    };
  },
};
