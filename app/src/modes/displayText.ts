// Mode "Wyświetl tekst": type text, translate to Polish braille, page it in
// groups of 5 cells and show each page on the device.

import { cellsToBraille, paginate, translate, type Translation } from '../braille/translator';
import type { CommandResult } from '../device/DeviceLink';
import type { Mode, ModeContext } from './types';

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

export function describeResult(r: CommandResult, what: string): string | null {
  switch (r.status) {
    case 'ok':
      return `Gotowe: ${what}. Możesz dotknąć.`;
    case 'skipped':
      return `To już jest na urządzeniu: ${what}.`;
    case 'superseded':
      return null;
    case 'timeout':
      return 'Urządzenie nie potwierdziło ruchu w czasie. Sprawdzam jego stan…';
    case 'error':
      return `Urządzenie zgłosiło błąd: ${r.code}${r.detail ? ' ' + r.detail : ''}.`;
    case 'cancelled':
      return r.reason === 'not-connected'
        ? 'Nie wysłano — najpierw połącz urządzenie albo włącz tryb symulacji.'
        : 'Polecenie przerwane — połączenie z urządzeniem zostało zresetowane.';
  }
}

export const displayTextMode: Mode = {
  id: 'display-text',
  title: 'Wyświetl tekst',

  mount(root: HTMLElement, ctx: ModeContext): () => void {
    let translation: Translation = translate('');
    let pages: number[][] = [];
    let labels: string[] = [];
    let page = 0;

    const input = h('input', { type: 'text', id: 'text-input', autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-describedby', 'text-help');
    const capital = h('input', { type: 'checkbox', id: 'capital-sign' });
    const submit = h('button', { type: 'submit', className: 'primary' }, 'Wyświetl na urządzeniu');
    const clearBtn = h('button', { type: 'button' }, 'Wyczyść urządzenie');

    const form = h(
      'form',
      {},
      h(
        'div',
        { className: 'field' },
        h('label', { htmlFor: 'text-input' }, 'Tekst do wyświetlenia'),
        h(
          'p',
          { className: 'hint', id: 'text-help' },
          'Litery, polskie znaki, cyfry i podstawowa interpunkcja. Enter wyświetla pierwszą stronę (5 komórek).',
        ),
        input,
      ),
      h(
        'div',
        { className: 'field' },
        h('label', { className: 'checkbox' }, capital, 'Dodawaj znak wielkiej litery (jeszcze niezweryfikowany z normą PZN)'),
      ),
      h('div', { className: 'button-row' }, submit, clearBtn),
    );

    const braille = h('p', { className: 'braille-text' });
    braille.setAttribute('aria-hidden', 'true');
    const summary = h('p', { id: 'translation-summary' });
    const unknownBox = h('p', { className: 'notice error', hidden: true });
    const warningsBox = h('ul', { className: 'notice', hidden: true });

    const prev = h('button', { type: 'button' }, 'Poprzednia strona');
    const next = h('button', { type: 'button' }, 'Następna strona');
    const pageInfo = h('span', { id: 'page-info' });
    const pager = h('div', { className: 'button-row' }, prev, pageInfo, next);
    pager.setAttribute('role', 'group');
    pager.setAttribute('aria-label', 'Strony');

    const output = h('div', {}, summary, braille, unknownBox, warningsBox, pager);
    root.append(form, output);

    function retranslate(): void {
      translation = translate(input.value, { capitalSign: capital.checked });
      pages = paginate(translation.cells);
      labels = translation.segments.flatMap((s) => s.cells.map(() => s.label));
      page = Math.min(page, Math.max(0, pages.length - 1));

      const n = translation.cells.length;
      summary.textContent =
        n === 0
          ? 'Brak komórek do wyświetlenia.'
          : `${n} ${plural(n, 'komórka', 'komórki', 'komórek')}, ${pages.length} ${plural(pages.length, 'strona', 'strony', 'stron')}.`;
      braille.textContent = cellsToBraille(translation.cells);

      if (translation.unknown.length) {
        const list = translation.unknown.map((u) => `„${u.char}” (znak ${u.index + 1})`).join(', ');
        unknownBox.textContent = `Tych znaków nie ma w tabeli i zostały pominięte: ${list}.`;
        unknownBox.hidden = false;
      } else {
        unknownBox.hidden = true;
      }
      warningsBox.replaceChildren(...translation.warnings.map((w) => h('li', {}, w)));
      warningsBox.hidden = translation.warnings.length === 0;
      updatePager();
    }

    function updatePager(): void {
      const total = pages.length;
      pageInfo.textContent = total ? `Strona ${page + 1} z ${total}` : 'Brak stron';
      // A focused button that becomes disabled drops focus to <body>; hand it
      // to the other pager button so keyboard users keep their place.
      const focused = document.activeElement;
      prev.disabled = page <= 0;
      next.disabled = page >= total - 1;
      if (focused === next && next.disabled && !prev.disabled) prev.focus();
      else if (focused === prev && prev.disabled && !next.disabled) next.focus();
    }

    function pageDescription(i: number): string {
      const words = labels.slice(i * 5, i * 5 + 5).map((l) => (l === 'spacja' ? 'odstęp' : l));
      const total = pages.length;
      return total > 1 ? `strona ${i + 1} z ${total}: ${words.join(', ')}` : words.join(', ');
    }

    /**
     * `notes` (skipped characters, translation caveats) are spoken together
     * with the result: the announcer replaces its text, so a separate earlier
     * announcement would be cut off by the result.
     */
    async function showPage(i: number, notes: string[] = []): Promise<void> {
      page = i;
      updatePager();
      const cells = pages[i] ?? [];
      const what = cells.length ? pageDescription(i) : 'pusty wyświetlacz';
      const result = await ctx.link.show(cells);
      const text = [describeResult(result, what), ...notes].filter(Boolean).join(' ');
      if (text) ctx.announce(text);
    }

    const onSubmit = (e: Event) => {
      e.preventDefault();
      retranslate();
      // A blind learner must hear that what they feel may be incomplete or unverified.
      const notes: string[] = [];
      if (translation.unknown.length) notes.push(unknownBox.textContent ?? '');
      if (translation.warnings.length) notes.push(`Uwaga: ${translation.warnings.join(' ')}`);
      void showPage(0, notes);
    };
    const onPrev = () => page > 0 && void showPage(page - 1);
    const onNext = () => page < pages.length - 1 && void showPage(page + 1);
    const onClear = async () => {
      const r = await ctx.link.clear();
      const msg = describeResult(r, 'wyczyszczono wszystkie komórki');
      if (msg) ctx.announce(msg);
    };

    form.addEventListener('submit', onSubmit);
    input.addEventListener('input', retranslate);
    capital.addEventListener('change', retranslate);
    prev.addEventListener('click', onPrev);
    next.addEventListener('click', onNext);
    clearBtn.addEventListener('click', () => void onClear());
    retranslate();

    return () => {
      form.removeEventListener('submit', onSubmit);
      root.replaceChildren();
    };
  },
};
