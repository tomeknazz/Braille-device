import { courseMode } from './course';
import { displayTextMode } from './displayText';
import { learnMode } from './learn';
import { recognizeMode, reviewMode } from './recognize';
import type { Mode, PlannedMode } from './types';
import { wordsMode } from './words';

/** Modes available in the switcher, in display order. */
export const modes: Mode[] = [courseMode, learnMode, recognizeMode, reviewMode, wordsMode, displayTextMode];

/** Next steps (docs/PROPOZYCJA.md §4, docs/DYDAKTYKA.md §4). */
export const plannedModes: PlannedMode[] = [];
