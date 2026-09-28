import { describe, expect, it } from 'vitest';
import type { Speaker } from '../src/audio/speech';
import { TONE_PATTERNS, type ToneKind } from '../src/audio/tones';
import { DEFAULT_SETTINGS, SETTINGS_KEY, SettingsStore } from '../src/settings';
import { Feedback } from '../src/ui/feedback';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function setup(initial: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const settings = new SettingsStore(memoryStorage());
  settings.set(initial);
  const announced: string[] = [];
  const spoken: string[] = [];
  const tones: ToneKind[] = [];
  let cancelled = 0;
  const speaker: Speaker = {
    speak: (t) => spoken.push(t),
    cancel: () => void cancelled++,
    available: true,
  };
  const fb = new Feedback({ announce: (m) => announced.push(m) }, speaker, { play: (k) => tones.push(k) }, settings);
  return { settings, fb, announced, spoken, tones, cancelled: () => cancelled };
}

describe('Feedback routing', () => {
  it('without a screen reader: aria-live and speech', () => {
    const t = setup();
    t.fb.say('Dobrze');
    expect(t.announced).toEqual(['Dobrze']);
    expect(t.spoken).toEqual(['Dobrze']);
  });

  it('with a screen reader: aria-live only, own speech silent', () => {
    const t = setup({ screenReader: true });
    t.fb.say('Dobrze');
    expect(t.announced).toEqual(['Dobrze']);
    expect(t.spoken).toEqual([]);
  });

  it('speech can be switched off; switching stops current speech', () => {
    const t = setup();
    t.settings.set({ speech: false });
    expect(t.cancelled()).toBe(1);
    t.fb.say('x');
    expect(t.spoken).toEqual([]);
    expect(t.announced).toEqual(['x']);
  });

  it('both speech channels get numbers as words', () => {
    const t = setup();
    t.fb.say('Różnią się punktem 4.');
    expect(t.announced).toEqual(['Różnią się punktem cztery.']);
    expect(t.spoken).toEqual(['Różnią się punktem cztery.']);
    const r = setup({ screenReader: true });
    r.fb.say('Na komórce 1 litera a.');
    expect(r.announced).toEqual(['Na komórce jeden litera a.']);
  });

  it('tones follow only the tones setting', () => {
    const t = setup({ screenReader: true });
    t.fb.tone('correct');
    t.settings.set({ tones: false });
    t.fb.tone('wrong');
    expect(t.tones).toEqual(['correct']);
  });

  it('every tone has a pattern', () => {
    for (const k of ['ready', 'correct', 'wrong', 'unlock'] as ToneKind[]) expect(TONE_PATTERNS[k].length).toBeGreaterThan(0);
  });
});

describe('SettingsStore', () => {
  it('persists and reloads', () => {
    const storage = memoryStorage();
    new SettingsStore(storage).set({ screenReader: true, rate: 1.4 });
    expect(new SettingsStore(storage).get()).toEqual({ ...DEFAULT_SETTINGS, screenReader: true, rate: 1.4 });
  });

  it('falls back to defaults on bad data and clamps nonsense values', () => {
    expect(new SettingsStore(memoryStorage({ [SETTINGS_KEY]: '{oops' })).get()).toEqual(DEFAULT_SETTINGS);
    expect(new SettingsStore(memoryStorage({ [SETTINGS_KEY]: '{"rate":9,"tones":"no"}' })).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('works without storage', () => {
    const s = new SettingsStore(null);
    s.set({ tones: false });
    expect(s.get().tones).toBe(false);
  });
});
