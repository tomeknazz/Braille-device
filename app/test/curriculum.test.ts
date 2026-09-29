import { describe, expect, it } from 'vitest';
import { table } from '../src/braille/table';
import { buildCurriculum, curriculum, lessonById } from '../src/learn/curriculum';
import raw from '../src/learn/curriculum.json';

type Raw = Parameters<typeof buildCurriculum>[0];
const clone = (): Raw => structuredClone(raw) as Raw;

describe('curriculum.json', () => {
  it('has lessons L0-L7 in order', () => {
    expect(curriculum.lessons.map((l) => l.id)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  });

  it('unlocks at 80% of the last 20 attempts, no time limit by default', () => {
    expect(curriculum.unlock).toEqual({ window: 20, minAccuracy: 0.8, maxMedianMs: null });
  });

  it('L0 teaches the six single dots', () => {
    const l0 = lessonById('L0')!;
    expect(l0.kind).toBe('dots');
    expect(l0.items.map((i) => [i.key, i.mask, i.answer, i.spoken])).toEqual([
      ['dot1', 1, '1', 'punkt 1'],
      ['dot2', 2, '2', 'punkt 2'],
      ['dot3', 4, '3', 'punkt 3'],
      ['dot4', 8, '4', 'punkt 4'],
      ['dot5', 16, '5', 'punkt 5'],
      ['dot6', 32, '6', 'punkt 6'],
    ]);
  });

  it('every letter lesson has exactly 5 letters, so it fits the device', () => {
    for (const l of curriculum.lessons.filter((x) => x.kind === 'letters')) {
      expect(l.items, l.id).toHaveLength(5);
    }
  });

  it('L1-L7 cover all 35 letters of the table exactly once', () => {
    const taught = curriculum.lessons.filter((l) => l.kind === 'letters').flatMap((l) => l.items.map((i) => i.key));
    expect(taught).toHaveLength(35);
    expect(new Set(taught)).toEqual(new Set(table.letters.map((l) => l.char)));
  });

  it('follows the decade order a-e, f-j, k-o, p-t, u v x y z', () => {
    const letters = (id: string) => lessonById(id)!.items.map((i) => i.key).join('');
    expect(letters('L1')).toBe('abcde');
    expect(letters('L2')).toBe('fghij');
    expect(letters('L3')).toBe('klmno');
    expect(letters('L4')).toBe('pqrst');
    expect(letters('L5')).toBe('uvxyz');
    expect(letters('L6')).toBe('wąćęł');
    expect(letters('L7')).toBe('ńóśźż');
  });

  it('uses the verified masks and Polish letter names', () => {
    const l7 = lessonById('L7')!;
    expect(l7.items.map((i) => i.mask)).toEqual([57, 44, 42, 46, 47]);
    expect(lessonById('L1')!.items[2]!.spoken).toBe(table.letters.find((l) => l.char === 'c')!.name);
  });

  it('keeps the decade rules: L3 = L1 + 3, L4 = L2 + 3, L5 = L1 + 3,6', () => {
    expect(lessonById('L3')!.rule).toEqual({ from: 'L1', addDots: [3] });
    expect(lessonById('L4')!.rule).toEqual({ from: 'L2', addDots: [3] });
    expect(lessonById('L5')!.rule).toEqual({ from: 'L1', addDots: [3, 6] });
  });

  describe('validation', () => {
    it('rejects a rule that does not hold', () => {
      const bad = clone();
      bad.lessons[3]!.items = ['k', 'l', 'm', 'o', 'n'];
      expect(() => buildCurriculum(bad)).toThrow(/"o" is not "d" \+ dots 3/);
    });

    it('rejects a rule that points forward', () => {
      const bad = clone();
      bad.lessons[3]!.rule = { from: 'L5', addDots: [3] };
      expect(() => buildCurriculum(bad)).toThrow(/not an earlier lesson/);
    });

    it('rejects unknown letters, duplicates and bad dots', () => {
      const unknown = clone();
      unknown.lessons[1]!.items = ['a', 'b', 'c', 'd', '#'];
      expect(() => buildCurriculum(unknown)).toThrow(/not in pl-braille.json/);

      const dup = clone();
      dup.lessons[1]!.items = ['a', 'b', 'c', 'd', 'a'];
      expect(() => buildCurriculum(dup)).toThrow(/duplicate items/);

      const dot = clone();
      dot.lessons[0]!.items = ['1', '7'];
      expect(() => buildCurriculum(dot)).toThrow(/not a dot number/);
    });

    it('rejects a nonsensical unlock policy', () => {
      const bad = clone();
      bad.unlock.minAccuracy = 1.5;
      expect(() => buildCurriculum(bad)).toThrow(/minAccuracy/);
    });
  });
});
