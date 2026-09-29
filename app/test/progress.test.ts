import { beforeEach, describe, expect, it } from 'vitest';
import { curriculum } from '../src/learn/curriculum';
import { CourseProgress, evaluate, MAX_STORED_ATTEMPTS, sanitize, type Attempt } from '../src/learn/progress';

const policy = curriculum.unlock;
let clock = 0;

function attempt(lessonId: string, correct: boolean, itemKey?: string, ms = 2000): Attempt {
  const lesson = curriculum.lessons.find((l) => l.id === lessonId)!;
  return { lessonId, itemKey: itemKey ?? lesson.items[0]!.key, correct, ms, at: ++clock };
}

/** Records `correct` right and `wrong` wrong answers, wrong ones first. */
function answer(p: CourseProgress, lessonId: string, correct: number, wrong: number) {
  const results = [];
  for (let i = 0; i < wrong; i++) results.push(p.record(attempt(lessonId, false)));
  for (let i = 0; i < correct; i++) results.push(p.record(attempt(lessonId, true)));
  return results;
}

describe('evaluate', () => {
  it('needs a full window of 20 attempts', () => {
    const s = evaluate(Array.from({ length: 19 }, () => attempt('L0', true)), policy);
    expect(s).toMatchObject({ attempts: 19, correct: 19, missing: 1, meetsCriteria: false });
  });

  it('passes at exactly 16/20 (80%) and fails at 15/20', () => {
    const at = (n: number) => [
      ...Array.from({ length: 20 - n }, () => attempt('L0', false)),
      ...Array.from({ length: n }, () => attempt('L0', true)),
    ];
    expect(evaluate(at(16), policy)).toMatchObject({ correct: 16, accuracy: 0.8, meetsCriteria: true });
    expect(evaluate(at(15), policy)).toMatchObject({ correct: 15, accuracy: 0.75, meetsCriteria: false });
  });

  it('only looks at the last 20 attempts', () => {
    const list = [
      ...Array.from({ length: 30 }, () => attempt('L0', false)),
      ...Array.from({ length: 20 }, () => attempt('L0', true)),
    ];
    expect(evaluate(list, policy)).toMatchObject({ attempts: 20, correct: 20, meetsCriteria: true });
  });

  it('applies the optional median-time limit', () => {
    const slow = Array.from({ length: 20 }, () => attempt('L0', true, undefined, 7000));
    expect(evaluate(slow, policy).meetsCriteria).toBe(true);
    expect(evaluate(slow, { ...policy, maxMedianMs: 6000 })).toMatchObject({ medianMs: 7000, meetsCriteria: false });
  });

  it('reports null accuracy and median before the first attempt', () => {
    expect(evaluate([], policy)).toMatchObject({ attempts: 0, accuracy: null, medianMs: null, missing: 20 });
  });
});

describe('CourseProgress', () => {
  let p: CourseProgress;
  beforeEach(() => {
    p = new CourseProgress(curriculum);
  });

  it('starts with only L0 available', () => {
    expect(curriculum.lessons.map((l) => p.status(l.id))).toEqual([
      'available', 'locked', 'locked', 'locked', 'locked', 'locked', 'locked', 'locked',
    ]);
    expect(p.current().id).toBe('L0');
  });

  it('passing L0 unlocks L1, reported on the attempt that crosses the threshold', () => {
    const results = answer(p, 'L0', 16, 4);
    expect(results.slice(0, -1).every((r) => r.passed === null)).toBe(true);
    expect(results.at(-1)!.passed?.id).toBe('L0');
    expect(results.at(-1)!.unlocked?.id).toBe('L1');
    expect(p.status('L0')).toBe('passed');
    expect(p.status('L1')).toBe('available');
    expect(p.current().id).toBe('L1');
  });

  it('does not unlock at 75%', () => {
    answer(p, 'L0', 15, 5);
    expect(p.status('L0')).toBe('available');
    expect(p.status('L1')).toBe('locked');
  });

  it('keeps a passed lesson unlocked after a bad streak', () => {
    answer(p, 'L0', 20, 0);
    answer(p, 'L0', 0, 20);
    expect(p.stats('L0').accuracy).toBe(0);
    expect(p.status('L0')).toBe('passed');
    expect(p.status('L1')).toBe('available');
  });

  it('reports a pass only once', () => {
    answer(p, 'L0', 20, 0);
    expect(answer(p, 'L0', 5, 0).every((r) => r.passed === null)).toBe(true);
  });

  it('refuses attempts on a locked lesson or with a foreign item', () => {
    expect(() => p.record(attempt('L1', true))).toThrow(/locked/);
    expect(() => p.record(attempt('L0', true, 'a'))).toThrow(/not part of L0/);
    expect(() => p.record(attempt('L9', true, 'a'))).toThrow();
  });

  it('teacher override makes every lesson available without passing them', () => {
    p.setTeacherUnlocked(true);
    expect(curriculum.lessons.every((l) => p.status(l.id) === 'available')).toBe(true);
    answer(p, 'L5', 20, 0);
    expect(p.status('L5')).toBe('passed');
    p.setTeacherUnlocked(false);
    expect(p.status('L1')).toBe('locked');
    expect(p.status('L5')).toBe('passed');
  });

  it('bounds stored attempts per lesson', () => {
    answer(p, 'L0', MAX_STORED_ATTEMPTS + 50, 0);
    expect(p.attempts('L0')).toHaveLength(MAX_STORED_ATTEMPTS);
  });

  it('round-trips through JSON and resets', () => {
    answer(p, 'L0', 18, 2);
    const copy = new CourseProgress(curriculum, JSON.parse(JSON.stringify(p.toJSON())));
    expect(copy.status('L1')).toBe('available');
    expect(copy.stats('L0')).toEqual(p.stats('L0'));
    copy.reset();
    expect(copy.status('L0')).toBe('available');
    expect(copy.attempts('L0')).toHaveLength(0);
  });
});

describe('sanitize', () => {
  it('drops unknown lessons, foreign items and malformed records', () => {
    const s = sanitize(
      {
        version: 1,
        teacherUnlocked: 'yes',
        passed: ['L0', 'L42'],
        attempts: {
          L0: [
            { lessonId: 'L0', itemKey: 'dot1', correct: true, ms: 100, at: 1 },
            { lessonId: 'L0', itemKey: 'a', correct: true, ms: 100, at: 2 },
            { lessonId: 'L0', itemKey: 'dot2', correct: 'yes', ms: 100, at: 3 },
            { lessonId: 'L0', itemKey: 'dot3', correct: false, ms: -5, at: 4 },
            null,
          ],
          L42: [{ lessonId: 'L42', itemKey: 'x', correct: true, ms: 1, at: 1 }],
        },
      },
      curriculum,
    );
    expect(s.passed).toEqual(['L0']);
    expect(s.teacherUnlocked).toBe(false);
    expect(Object.keys(s.attempts)).toEqual(['L0']);
    expect(s.attempts['L0']!.map((a) => a.itemKey)).toEqual(['dot1']);
  });

  it('ignores other versions and garbage', () => {
    expect(sanitize({ version: 2, passed: ['L0'] }, curriculum).passed).toEqual([]);
    expect(sanitize('nonsense', curriculum).passed).toEqual([]);
    expect(sanitize(null, curriculum).passed).toEqual([]);
  });
});
