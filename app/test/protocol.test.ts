import { describe, expect, it } from 'vitest';
import {
  LineSplitter,
  cmd,
  commandTimeoutMs,
  expectedOkVerb,
  padCells,
  parseAnim,
  parseGet,
  parseHello,
  parseKeyValues,
  parseLine,
  splitRequestTag,
  parseMotion,
} from '../src/device/protocol';

describe('LineSplitter', () => {
  it('splits on \\n and \\r\\n, across chunk boundaries', () => {
    const s = new LineSplitter();
    expect(s.push('OK hel')).toEqual([]);
    expect(s.push('lo fw=0.4.0 proto=1\r')).toEqual([]);
    expect(s.push('\nOK ping\nEVT sl')).toEqual(['OK hello fw=0.4.0 proto=1', 'OK ping']);
    expect(s.push('eep\r\n')).toEqual(['EVT sleep']);
  });

  it('keeps empty lines and flushes the rest', () => {
    const s = new LineSplitter();
    expect(s.push('a\n\nb')).toEqual(['a', '']);
    expect(s.flush()).toEqual(['b']);
    expect(s.flush()).toEqual([]);
  });

  it('does not buffer garbage forever', () => {
    const s = new LineSplitter(10);
    expect(s.push('x'.repeat(11))).toEqual(['x'.repeat(11)]);
    expect(s.push('ok\n')).toEqual(['ok']);
  });
});

describe('parseLine', () => {
  it('classifies OK lines', () => {
    expect(parseLine('OK show moved=7 ms=312')).toEqual({
      kind: 'ok',
      verb: 'show',
      data: 'moved=7 ms=312',
      raw: 'OK show moved=7 ms=312',
    });
    expect(parseLine('OK ping')).toMatchObject({ kind: 'ok', verb: 'ping', data: '' });
  });

  it('splits an optional #tag off terminal lines', () => {
    expect(parseLine('OK show moved=7 ms=312 #a1')).toMatchObject({ verb: 'show', data: 'moved=7 ms=312', tag: 'a1' });
    expect(parseLine('OK ping #7')).toMatchObject({ verb: 'ping', data: '', tag: '7' });
    expect(parseLine('ERR busy #x')).toMatchObject({ kind: 'err', code: 'busy', detail: '', tag: 'x' });
  });

  it('classifies ERR lines', () => {
    expect(parseLine("ERR badarg pwm 'mni'")).toMatchObject({ kind: 'err', code: 'badarg', detail: "pwm 'mni'" });
    expect(parseLine('ERR range line too long')).toMatchObject({ code: 'range', detail: 'line too long' });
  });

  it('classifies EVT lines', () => {
    expect(parseLine('EVT boot fw=0.4.0 proto=1 reason=poweron')).toMatchObject({
      kind: 'evt',
      name: 'boot',
      data: 'fw=0.4.0 proto=1 reason=poweron',
    });
    expect(parseLine('EVT sleep')).toMatchObject({ kind: 'evt', name: 'sleep', data: '' });
  });

  it('treats everything else as info (including old-firmware text)', () => {
    for (const l of ['Unknown command: hello', 'Setting servo 7 to PWM 430', '0,0,1,470,430', '', 'ok show', 'OK', 'OKAY']) {
      expect(parseLine(l).kind).toBe('info');
    }
  });

  it('strips a trailing \\r', () => {
    expect(parseLine('OK ping\r')).toMatchObject({ kind: 'ok', verb: 'ping', raw: 'OK ping' });
  });
});

describe('reply parsers', () => {
  it('parseKeyValues', () => {
    expect(parseKeyValues('fw=0.4.0 proto=1 cells=5')).toEqual({ fw: '0.4.0', proto: '1', cells: '5' });
  });

  it('parseHello', () => {
    const h = parseHello('fw=0.4.0 proto=1 cells=5 dots=6 pwm1=ok pwm2=fail');
    expect(h).toMatchObject({ fw: '0.4.0', proto: 1, cells: 5, dots: 6, pwm1Ok: true, pwm2Ok: false });
    expect(parseHello('fw=0.4.0')).toBeNull();
    expect(parseHello('proto=2')?.proto).toBe(2);
  });

  it('parseGet', () => {
    expect(parseGet('1,3,9,0,0')).toEqual([1, 3, 9, 0, 0]);
    expect(parseGet('5,21,30')).toEqual([5, 21, 30, 0, 0]);
    expect(parseGet('1,3,x')).toBeNull();
    expect(parseGet('64')).toBeNull();
    expect(parseGet('1,2,3,4,5,6')).toBeNull();
  });

  it('parseMotion and parseAnim', () => {
    expect(parseMotion('moved=7 ms=312')).toEqual({ moved: 7, ms: 312 });
    expect(parseMotion('2 moved=3 ms=150')).toEqual({ moved: 3, ms: 150 });
    expect(parseMotion('')).toEqual({});
    expect(parseAnim('300')).toBe(300);
    expect(parseAnim('abc')).toBeNull();
  });
});

describe('command builders (PROTOCOL.md §4)', () => {
  it('show', () => {
    expect(cmd.show([5, 21, 30])).toBe('show,5,21,30');
    expect(cmd.show([47, 1, 3, 1])).toBe('show,47,1,3,1');
    expect(cmd.show([60, 3, 26, 3, 11])).toBe('show,60,3,26,3,11');
    expect(cmd.show([0, 0, 35, 0, 0])).toBe('show,0,0,35');
    expect(cmd.show([])).toBe('show');
    expect(cmd.show([0, 0, 0, 0, 0])).toBe('show');
    expect(() => cmd.show([64])).toThrow(RangeError);
    expect(() => cmd.show([1.5])).toThrow(RangeError);
    expect(() => cmd.show([1, 2, 3, 4, 5, 6])).toThrow(RangeError);
  });

  it('cell, clear, get, anim, ping, hello', () => {
    expect(cmd.cell(2, 13)).toBe('cell,2,13');
    expect(() => cmd.cell(5, 1)).toThrow(RangeError);
    expect(cmd.clear()).toBe('clear');
    expect(cmd.clear(1)).toBe('clear,1');
    expect(cmd.get()).toBe('get');
    expect(cmd.anim()).toBe('anim');
    expect(cmd.anim(300)).toBe('anim,300');
    expect(() => cmd.anim(2001)).toThrow(RangeError);
    // Firmware: 0 = normal, otherwise 20-2000 ("ERR range 0 or 20-2000").
    expect(cmd.anim(0)).toBe('anim,0');
    expect(cmd.anim(20)).toBe('anim,20');
    expect(() => cmd.anim(1)).toThrow(RangeError);
    expect(() => cmd.anim(19)).toThrow(RangeError);
    expect(cmd.ping()).toBe('ping');
    expect(cmd.hello()).toBe('hello');
  });

  it('padCells', () => {
    expect(padCells([1])).toEqual([1, 0, 0, 0, 0]);
  });

  it('expectedOkVerb maps commands to their terminal verb', () => {
    expect(expectedOkVerb('show,1,2')).toBe('show');
    expect(expectedOkVerb('SHOW,1')).toBe('show');
    expect(expectedOkVerb('7,430')).toBe('servo');
    expect(expectedOkVerb('7,min')).toBe('servo');
    expect(expectedOkVerb('all,max')).toBe('max');
    expect(expectedOkVerb('min')).toBe('min');
    expect(expectedOkVerb('a')).toBe('letter');
    expect(expectedOkVerb('space')).toBe('clear');
    expect(expectedOkVerb('?')).toBe('help');
    expect(expectedOkVerb('get #t1')).toBe('get');
  });

  it('splitRequestTag follows the firmware tag rule', () => {
    expect(splitRequestTag('get #t1')).toEqual({ body: 'get', tag: 't1' });
    expect(splitRequestTag(' show,1,2 #42 ')).toEqual({ body: 'show,1,2', tag: '42' });
    expect(splitRequestTag('hello #')).toEqual({ body: 'hello #' }); // empty tag
    expect(splitRequestTag('show,1 #a b')).toEqual({ body: 'show,1 #a b' }); // space after '#'
    expect(splitRequestTag('show,1#2')).toEqual({ body: 'show,1#2' });
  });

  it('timeout = 1500 + 30 * (anim + 5)', () => {
    expect(commandTimeoutMs(0)).toBe(1650);
    expect(commandTimeoutMs()).toBe(2250); // default step 20 ms
    expect(commandTimeoutMs(300)).toBe(10650);
  });
});
