// User settings for feedback and accessibility, kept in localStorage.
// Storage may be unavailable (private window) — defaults are used then.

export interface Settings {
  /**
   * The learner uses a screen reader (NVDA). Messages then go only to the
   * aria-live region, which the screen reader speaks; the app's own speech
   * synthesis stays silent so the two never talk over each other.
   */
  screenReader: boolean;
  /** Speak messages with the browser's Polish speech synthesis. */
  speech: boolean;
  /** Short tones: ready / correct / wrong / unlocked. */
  tones: boolean;
  /** Speech rate, 0.5-2 (1 = normal). */
  rate: number;
}

export const SETTINGS_KEY = 'braillelab.settings.v1';

export const DEFAULT_SETTINGS: Settings = { screenReader: false, speech: true, tones: true, rate: 1 };

function sanitize(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Partial<Record<keyof Settings, unknown>>;
  if (typeof r.screenReader === 'boolean') s.screenReader = r.screenReader;
  if (typeof r.speech === 'boolean') s.speech = r.speech;
  if (typeof r.tones === 'boolean') s.tones = r.tones;
  if (typeof r.rate === 'number' && r.rate >= 0.5 && r.rate <= 2) s.rate = r.rate;
  return s;
}

export class SettingsStore {
  private value: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(private readonly storage: Storage | null = SettingsStore.defaultStorage()) {
    let raw: unknown = null;
    try {
      const text = this.storage?.getItem(SETTINGS_KEY);
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }
    this.value = sanitize(raw);
  }

  static defaultStorage(): Storage | null {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  get(): Settings {
    return { ...this.value };
  }

  set(patch: Partial<Settings>): void {
    this.value = sanitize({ ...this.value, ...patch });
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(this.value));
    } catch {
      // Not saved; the setting still applies for this session.
    }
    for (const l of this.listeners) l(this.get());
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
