// SVG preview of the 5 x 6 display. It shows only the state CONFIRMED by the
// device (after "OK"), never what the app merely asked for. Every cell also
// gets a text line (dot numbers + meaning), so nothing depends on the picture
// or on colour alone.

import { describeMask, maskToChar, maskToDots } from '../braille/table';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CELLS = 5;
const CELL_W = 120;
const CELL_H = 160;
const GAP = 20;
const PAD = 10;
const DOT_R = 19;
// Braille layout: left column dots 1-2-3 (top to bottom), right column 4-5-6.
const DOT_POS: ReadonlyArray<readonly [number, number]> = [
  [38, 35],
  [38, 80],
  [38, 125],
  [82, 35],
  [82, 80],
  [82, 125],
];

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  text?: string,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "Komórka 1: punkty 1, 3 (k)" / "Komórka 2: pusta". */
export function describeCell(index: number, mask: number): string {
  if (mask === 0) return `Komórka ${index + 1}: pusta`;
  const dots = maskToDots(mask);
  return `Komórka ${index + 1}: punkt${dots.length > 1 ? 'y' : ''} ${dots.join(', ')} (${describeMask(mask)})`;
}

export class DevicePreview {
  private readonly figure: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly dots: SVGCircleElement[] = [];
  private readonly nums: SVGTextElement[] = [];
  private readonly caption: HTMLOListElement;
  private readonly stateLine: HTMLParagraphElement;

  constructor(private readonly root: HTMLElement) {
    this.figure = document.createElement('figure');
    this.figure.className = 'preview-figure';

    const width = PAD * 2 + CELLS * CELL_W + (CELLS - 1) * GAP;
    const height = PAD * 2 + CELL_H + 30;
    this.svg = el('svg', {
      class: 'preview-svg',
      viewBox: `0 0 ${width} ${height}`,
      'aria-hidden': 'true',
      focusable: 'false',
    });
    for (let c = 0; c < CELLS; c++) {
      const x0 = PAD + c * (CELL_W + GAP);
      const g = el('g', { transform: `translate(${x0} ${PAD})` });
      g.append(el('rect', { class: 'cell-frame', x: 0, y: 0, width: CELL_W, height: CELL_H, rx: 12 }));
      DOT_POS.forEach(([x, y], d) => {
        const circle = el('circle', { cx: x, cy: y, r: DOT_R, class: 'dot-off' });
        const num = el('text', { x, y, 'font-size': 17, class: 'dot-num-off' }, String(d + 1));
        this.dots.push(circle);
        this.nums.push(num);
        g.append(circle, num);
      });
      g.append(el('text', { x: CELL_W / 2, y: CELL_H + 18, 'font-size': 16, class: 'cell-num' }, `Komórka ${c + 1}`));
      this.svg.append(g);
    }

    this.stateLine = document.createElement('p');
    this.stateLine.className = 'preview-state';
    this.caption = document.createElement('ol');
    this.caption.className = 'preview-caption';
    this.caption.setAttribute('aria-label', 'Zawartość komórek');

    this.figure.append(this.svg);
    root.classList.add('preview');
    root.append(this.figure, this.stateLine, this.caption);
    this.render(null);
  }

  /** masks = confirmed state (5 masks) or null when the state is unknown. */
  render(masks: readonly number[] | null, pending = false): void {
    const known = masks !== null;
    this.root.classList.toggle('unknown', !known);
    this.root.setAttribute('aria-busy', pending ? 'true' : 'false');

    for (let c = 0; c < CELLS; c++) {
      const mask = masks?.[c] ?? 0;
      for (let d = 0; d < 6; d++) {
        const on = known && ((mask >> d) & 1) === 1;
        const i = c * 6 + d;
        this.dots[i]!.setAttribute('class', on ? 'dot-on' : 'dot-off');
        this.nums[i]!.setAttribute('class', on ? 'dot-num-on' : 'dot-num-off');
      }
    }

    this.caption.replaceChildren();
    if (known) {
      masks.forEach((mask, c) => {
        const li = document.createElement('li');
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.className = 'braille-glyph';
        glyph.textContent = maskToChar(mask) + ' ';
        li.append(glyph, describeCell(c, mask));
        this.caption.append(li);
      });
    }

    this.stateLine.textContent = !known
      ? 'Stan nieznany — brak potwierdzenia z urządzenia.'
      : pending
        ? 'Urządzenie wykonuje ruch… (podgląd pokazuje ostatni potwierdzony stan)'
        : 'Stan potwierdzony przez urządzenie.';
  }
}
