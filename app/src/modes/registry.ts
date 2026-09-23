import { displayTextMode } from './displayText';
import type { Mode, PlannedMode } from './types';

/** Modes available in the switcher, in display order. */
export const modes: Mode[] = [displayTextMode];

/** Next steps (docs/PROPOZYCJA.md §4, docs/DYDAKTYKA.md §4). */
export const plannedModes: PlannedMode[] = [
  { id: 'learn', title: 'Poznaj znak', description: 'znak na komórce 2, nazwa i numery punktów, animacja reguł dekad' },
  { id: 'recognize', title: 'Rozpoznawanie', description: 'quiz z drabiną podpowiedzi i kontrastem pomyłek' },
  { id: 'words', title: 'Słowa', description: 'słowa do 5 komórek z już poznanych liter' },
];
