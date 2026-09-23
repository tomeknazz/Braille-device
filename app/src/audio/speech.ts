// Polish speech synthesis through the Web Speech API. A local Windows voice
// ("Paulina") works offline; network voices may fall silent without
// internet. Without any Polish voice the speaker stays silent and the
// aria-live region remains the only channel.

export interface Speaker {
  /** Speaks `text`, interrupting whatever is being said. */
  speak(text: string, rate?: number): void;
  cancel(): void;
  /** A Polish voice exists (may turn true once the voice list loads). */
  readonly available: boolean;
}

export class WebSpeechSpeaker implements Speaker {
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private readonly synth: SpeechSynthesis | undefined = globalThis.speechSynthesis) {
    if (!this.synth) return;
    this.pickVoice();
    // Chrome fills the voice list asynchronously.
    this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
  }

  private pickVoice(): void {
    const voices = this.synth?.getVoices?.() ?? [];
    const polish = voices.filter((v) => v.lang.toLowerCase().startsWith('pl'));
    // Prefer an installed voice: it works offline and starts without delay.
    this.voice = polish.find((v) => v.localService) ?? polish[0] ?? null;
  }

  get available(): boolean {
    return !!this.synth && this.voice !== null;
  }

  speak(text: string, rate = 1): void {
    if (!this.synth || !text) return;
    try {
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pl-PL';
      if (this.voice) u.voice = this.voice;
      u.rate = rate;
      this.synth.speak(u);
    } catch {
      // Speech is a convenience; the aria-live text is still there.
    }
  }

  cancel(): void {
    try {
      this.synth?.cancel();
    } catch {
      // ignore
    }
  }
}

/** Speaker that does nothing (tests, browsers without speech). */
export const silentSpeaker: Speaker = { speak() {}, cancel() {}, available: false };
