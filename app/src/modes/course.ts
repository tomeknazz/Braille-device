// Mode "Kurs": the lesson list L0-L7 with lock state and progress, and a
// button that lays a lesson's characters under the fingers (one lesson = one
// row of 5 cells). Attempts are recorded by the exercise modes; this view
// only reads them.

import { cellsToBraille } from '../braille/translator';
import { curriculum, type Lesson, type LessonItem } from '../learn/curriculum';
import type { LessonStats, LessonStatus } from '../learn/progress';
import { persist, progress } from '../learn/session';
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
  const base = `Ostatnie ${s.attempts} ${s.attempts === 1 ? 'próba' : 'prób'}: ${s.correct} poprawnych (${pct}%).`;
  return s.missing > 0 ? `${base} Brakuje jeszcze ${s.missing} prób do oceny.` : base;
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
        'Próby zapisuje ćwiczenie Rozpoznawanie (w przygotowaniu).',
    );
    const current = h('p', { className: 'course-current', id: 'course-current' });
    const list = h('ol', { className: 'lesson-list', id: 'lesson-list' });

    const teacherBox = h('input', { type: 'checkbox', id: 'teacher-unlock' });
    const resetBtn = h('button', { type: 'button', id: 'course-reset' }, 'Wyzeruj postępy');
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
      resetBtn.textContent = 'Wyzeruj postępy';
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
        ctx.announce('Naciśnij ponownie w ciągu 5 sekund, aby wyzerować wszystkie postępy.');
        resetTimer = setTimeout(disarmReset, 5000);
        return;
      }
      disarmReset();
      progress.reset();
      persist();
      pages.clear();
      render();
      ctx.announce('Postępy wyzerowane. Zaczynasz od lekcji L0.');
    };
    teacherBox.addEventListener('change', onTeacher);
    resetBtn.addEventListener('click', onReset);

    root.append(intro, current, list, teacher);
    render();

    return () => {
      clearTimeout(resetTimer);
      teacherBox.removeEventListener('change', onTeacher);
      resetBtn.removeEventListener('click', onReset);
    };
  },
};
