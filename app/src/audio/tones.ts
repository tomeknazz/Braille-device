// Short feedback tones made with WebAudio — no sound files needed. The
// AudioContext is created on first use, which happens after a user gesture
// (click / key press), as browsers require.

export type ToneKind = 'ready' | 'correct' | 'wrong' | 'unlock';

/** [frequency Hz, duration ms] steps played one after another. */
export const TONE_PATTERNS: Record<ToneKind, Array<[number, number]>> = {
  // One short high beep: "the dots are up, you can touch".
  ready: [[880, 90]],
  // Rising pair.
  correct: [
    [660, 90],
    [990, 130],
  ],
  // Low buzz.
  wrong: [[220, 260]],
  // Rising triad: lesson passed, next one unlocked.
  unlock: [
    [523, 110],
    [659, 110],
    [784, 220],
  ],
};

export interface TonePlayer {
  play(kind: ToneKind): void;
}

export class WebAudioTones implements TonePlayer {
  private ctx: AudioContext | null = null;

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  play(kind: ToneKind): void {
    const ctx = this.context();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume();
      let t = ctx.currentTime + 0.01;
      for (const [freq, ms] of TONE_PATTERNS[kind]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const end = t + ms / 1000;
        // Short fade in/out avoids clicks.
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.2, t + 0.01);
        gain.gain.setValueAtTime(0.2, end - 0.02);
        gain.gain.linearRampToValueAtTime(0, end);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(end);
        t = end + 0.03;
      }
    } catch {
      // Tones are optional feedback.
    }
  }
}

export const silentTones: TonePlayer = { play() {} };
