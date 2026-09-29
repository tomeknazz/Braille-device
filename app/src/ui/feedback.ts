// Routes messages and tones according to the settings:
//  - screen reader on  -> aria-live only (NVDA speaks it), no own speech;
//  - screen reader off -> aria-live (harmless without a reader) + speech
//    synthesis if enabled.
// Tones never collide with a screen reader, so they follow only `tones`.
// Both speech channels get digits rewritten as words (speechText): the
// aria-live region is visually hidden, so nothing on screen changes.

import type { Speaker } from '../audio/speech';
import { speechText } from '../audio/spokenNumbers';
import type { TonePlayer, ToneKind } from '../audio/tones';
import type { SettingsStore } from '../settings';

export interface Announce {
  announce(message: string): void;
}

export class Feedback {
  constructor(
    private readonly announcer: Announce,
    private readonly speaker: Speaker,
    private readonly tones: TonePlayer,
    private readonly settings: SettingsStore,
  ) {
    // Turning speech off (or switching to a screen reader) stops it at once.
    settings.onChange((s) => {
      if (s.screenReader || !s.speech) speaker.cancel();
    });
  }

  say(message: string): void {
    if (!message) return;
    const spoken = speechText(message);
    this.announcer.announce(spoken);
    const s = this.settings.get();
    if (!s.screenReader && s.speech) this.speaker.speak(spoken, s.rate);
  }

  tone(kind: ToneKind): void {
    if (this.settings.get().tones) this.tones.play(kind);
  }

  get speechAvailable(): boolean {
    return this.speaker.available;
  }
}
