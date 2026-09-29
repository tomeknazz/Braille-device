// Contract between the shell (main.ts) and learning modes. Modes use only
// DeviceLink (show/clear/anim), the feedback channel and the key handlers.

import type { ToneKind } from '../audio/tones';
import type { DeviceLink } from '../device/DeviceLink';

/**
 * Global shortcuts (docs/PROPOZYCJA.md §4): F1 repeat, F2 hint, F3 blink the
 * current character. Esc (move to the mode menu) is handled by the shell.
 * Letters and digits stay free for answers.
 */
export interface KeyHandlers {
  repeat?(): void;
  hint?(): void;
  blink?(): void;
}

export interface ModeContext {
  link: DeviceLink;
  /**
   * Speaks a message: aria-live region, plus speech synthesis unless the
   * learner uses a screen reader. Same as `say`, kept for older modes.
   */
  announce(message: string): void;
  say(message: string): void;
  /** Short feedback tone (if enabled in the settings). */
  tone(kind: ToneKind): void;
  /** Registers F1/F2/F3 handlers for the active mode (null removes them). */
  setKeys(handlers: KeyHandlers | null): void;
  /** Monotonic clock in ms, for answer times (replaceable in tests). */
  now(): number;
}

export interface Mode {
  id: string;
  /** Polish name shown in the mode switcher. */
  title: string;
  /** Builds the UI inside `root`; returns a cleanup function. */
  mount(root: HTMLElement, ctx: ModeContext): () => void;
}

/** A mode that is designed (docs/DYDAKTYKA.md) but not implemented yet. */
export interface PlannedMode {
  id: string;
  title: string;
  description: string;
}
