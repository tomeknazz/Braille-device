import { afterEach, describe, expect, it, vi } from 'vitest';
import { curriculum } from '../src/learn/curriculum';
import { loadProgress, PROGRESS_KEY, saveProgress } from '../src/learn/storage';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('progress storage', () => {
  it('saves and loads progress', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const p = loadProgress(curriculum);
    for (let i = 0; i < 20; i++) p.record({ lessonId: 'L0', itemKey: 'dot1', correct: true, ms: 1000, at: i });
    expect(saveProgress(p)).toBe(true);
    const again = loadProgress(curriculum);
    expect(again.status('L1')).toBe('available');
    expect(again.attempts('L0')).toHaveLength(20);
  });

  it('starts empty on corrupt data', () => {
    const s = memoryStorage();
    s.setItem(PROGRESS_KEY, '{not json');
    vi.stubGlobal('localStorage', s);
    expect(loadProgress(curriculum).status('L1')).toBe('locked');
  });

  it('keeps working when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const p = loadProgress(curriculum);
    expect(p.current().id).toBe('L0');
    expect(saveProgress(p)).toBe(false);
  });
});
