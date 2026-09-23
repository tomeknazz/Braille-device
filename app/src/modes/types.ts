// Contract between the shell (main.ts) and learning modes. Upcoming modes
// (Poznaj znak, Rozpoznawanie, Słowa) implement the same interface and use
// only DeviceLink.show()/clear()/anim() plus the announcer.

import type { DeviceLink } from '../device/DeviceLink';

export interface ModeContext {
  link: DeviceLink;
  /** Speaks a message through the polite aria-live region. */
  announce(message: string): void;
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
