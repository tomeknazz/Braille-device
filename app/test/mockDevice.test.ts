// The simulator must speak the same protocol subset as the firmware spec, or
// DeviceLink tests prove nothing. These tests drive it directly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, SERVO_RANGE } from '../src/device/MockDevice';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function run(mock: MockDevice, line: string, ms = 2000): Promise<string[]> {
  const before = mock.sent.length;
  await mock.writeLine(line);
  await vi.advanceTimersByTimeAsync(ms);
  return mock.sent.slice(before);
}

describe('MockDevice', () => {
  it('drops input while resetting, then announces EVT boot', async () => {
    const mock = new MockDevice({ resetOnOpen: true, bootMs: 800 });
    expect(await run(mock, 'hello', 500)).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    // setup(): print_help() banner (info lines), then EVT boot as the last line.
    expect(mock.sent[0]).toBe('Braille device ready (fw 0.4.0-mock, protocol 1).');
    expect(mock.sent).toHaveLength(23);
    expect(mock.sent.filter((l) => /^(OK|ERR|EVT) /.test(l))).toEqual([
      'EVT boot fw=0.4.0-mock proto=1 reason=poweron',
    ]);
    expect(mock.sent.at(-1)).toBe('EVT boot fw=0.4.0-mock proto=1 reason=poweron');
    expect(await run(mock, 'hello')).toEqual(['OK hello fw=0.4.0-mock proto=1 cells=5 dots=6 pwm1=ok pwm2=ok']);
  });

  it('answers show / get / cell / clear with the spec strings', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    expect(await run(mock, 'show,5,21,30')).toEqual(['OK show moved=9 ms=280']);
    expect(await run(mock, 'get')).toEqual(['OK get 5,21,30,0,0']);
    expect(await run(mock, 'show,5,21,30')).toEqual(['OK show moved=0 ms=0']);
    expect(await run(mock, 'cell,3,13')).toEqual(['OK cell 3 moved=3 ms=160']);
    expect(await run(mock, 'show,-,-,-,-,1')).toEqual(['OK show moved=1 ms=120']); // "-" keeps a cell
    expect(mock.cells).toEqual([5, 21, 30, 13, 1]);
    expect(await run(mock, 'clear,4')).toEqual(['OK clear 4 moved=1 ms=120']);
    expect(await run(mock, 'clear')).toEqual(['Clearing all cells', 'OK clear moved=12 ms=340']);
    expect(await run(mock, 'show')).toEqual(['OK show moved=0 ms=0']);
  });

  it('accepts hex and Unicode braille cell forms', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    await run(mock, 'show,x05151E');
    expect(mock.cells).toEqual([5, 21, 30, 0, 0]);
    await run(mock, 'show,⠯⠁⠃⠁');
    expect(mock.cells).toEqual([47, 1, 3, 1, 0]);
  });

  it('rejects bad input with ERR and never touches servo 0', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    expect(await run(mock, '7,mni')).toEqual(["ERR badarg pwm 'mni'"]);
    expect(await run(mock, 'show,1,64')).toEqual(['ERR range cell 1 0-63']);
    expect(await run(mock, 'show,1,x')).toEqual(["ERR badarg cell 1 'x'"]);
    expect(await run(mock, 'show,1,2,3,4,5,6')).toEqual(['ERR range max 5 cells']);
    expect(await run(mock, 'show,1,2,3,4,5,abc')).toEqual(['ERR range max 5 cells']);
    expect(await run(mock, 'bogus,1')).toEqual(['ERR badcmd bogus,1']);
    expect(await run(mock, 'text,ą')).toEqual(['ERR badarg use masks']);
    expect(await run(mock, 'text,ąąą')).toEqual(['ERR badarg use masks']); // characters are checked before length
    expect(await run(mock, 'text,abcdef')).toEqual(['ERR range max 5 cells']);
    expect(await run(mock, 'x'.repeat(100))).toEqual(['ERR range line too long']);
    expect(mock.cells).toEqual([0, 0, 0, 0, 0]);
  });

  it('mirrors the firmware replies for cell, clear, anim, idle and raw servo input', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    await run(mock, 'show,9,0,5');
    expect(await run(mock, 'cell,2,-')).toEqual(['OK cell 2 moved=0 ms=0']); // "-" keeps cell 2
    expect(await run(mock, 'get')).toEqual(['OK get 9,0,5,0,0']);
    expect(await run(mock, 'cell,1,1,2')).toEqual(['ERR badarg one mask']);
    expect(await run(mock, 'cell,3,')).toEqual(["ERR badarg mask ''"]);
    expect(await run(mock, 'cell,3,x0102')).toEqual(['ERR badarg one mask']);
    expect(await run(mock, 'cell,7,1')).toEqual(['ERR range cell 0-4']);
    expect(await run(mock, 'cell,a,1')).toEqual(['ERR badarg cell,<0-4>,<mask>']);

    expect(await run(mock, 'clear,x')).toEqual(['ERR badarg clear,<0-4>']);
    expect(await run(mock, 'clear,7')).toEqual(['ERR range cell 0-4']);
    expect(await run(mock, 'clear,02')).toEqual(['OK clear 2 moved=2 ms=140']);

    expect(await run(mock, 'anim,10')).toEqual(['ERR range 0 or 20-2000']);
    expect(await run(mock, 'anim,2001')).toEqual(['ERR range 0 or 20-2000']);
    expect(await run(mock, 'anim,abc')).toEqual(['ERR badarg anim,<ms>']);
    expect(await run(mock, 'anim')).toEqual(['OK anim 20']);

    expect(await run(mock, 'idle')).toEqual(['OK idle 2,300']);
    expect(await run(mock, 'idle, 5 , 10')).toEqual(['OK idle 5,10']);
    expect(await run(mock, 'idle')).toEqual(['OK idle 5,10']);
    expect(await run(mock, 'idle,abc')).toEqual(['ERR badarg idle,<down_s>,<sleep_s>']);
    expect(await run(mock, 'idle,1,86401')).toEqual(['ERR range 0-86400']);

    expect(await run(mock, '7a,5')).toEqual(['ERR badcmd 7a,5']);
    expect(await run(mock, '30,5')).toEqual(["ERR range servo '30'"]);
    expect(await run(mock, '7,5000')).toEqual(['ERR range pwm 90-520']);
    expect(await run(mock, '7,MIN')).toEqual(['Setting servo 7 to PWM 120', 'OK servo 7 min']);
    expect(await run(mock, '6,max')).toEqual(['Setting servo 6 to PWM 100', 'OK servo 6 max']);
    expect(await run(mock, '7,0430')).toEqual(['Setting servo 7 to PWM 430', 'OK servo 7 430']);
  });

  it('checks only the module that drives a raw servo', async () => {
    const mock = new MockDevice({ resetOnOpen: false, pwm2Ok: false });
    expect(await run(mock, '7,430')).toEqual(['Setting servo 7 to PWM 430', 'OK servo 7 430']);
    expect(await run(mock, '20,430')).toEqual(['ERR hw pwm2']);
    expect(await run(mock, '20,abc')).toEqual(["ERR badarg pwm 'abc'"]); // validated first
  });

  it('applies the firmware line-length and tag rules', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    const exactly96 = 'ping' + ' '.repeat(92);
    expect(await run(mock, exactly96)).toEqual(['OK ping']);
    expect(await run(mock, exactly96 + ' ')).toEqual(['ERR range line too long']);
    expect(await run(mock, 'hello #')).toEqual(['ERR badcmd hello #']);
    expect(await run(mock, 'show,1 #a b')).toEqual(["ERR badarg cell 0 '1 #a b'"]);
    expect(await run(mock, 'get #7')).toEqual(['OK get 0,0,0,0,0 #7']);
  });

  it('prints the calibration table for dump', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    const out = await run(mock, 'dump');
    expect(out[0]).toBe('index,cell,dot,retracted,extended');
    expect(out[1]).toBe('0,0,1,470,430');
    expect(out[30]).toBe('29,4,6,500,460');
    expect(out.at(-1)).toBe('OK dump 30');
    expect(out).toHaveLength(32);
  });

  it('echoes #tags and handles anim', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    expect(await run(mock, 'ping #42')).toEqual(['OK ping #42']);
    expect(await run(mock, 'anim,300')).toEqual(['OK anim 300']);
    expect(await run(mock, 'show,1')).toEqual(['OK show moved=1 ms=120']);
    expect(await run(mock, 'anim,0')).toEqual(['OK anim 20']);
  });

  it('keeps legacy calibration commands working with a terminal line', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    expect(await run(mock, '7,430')).toEqual(['Setting servo 7 to PWM 430', 'OK servo 7 430']);
    // Servo 7 (cell 1, dot 2) got a raw PWM, so its hold is UNKNOWN and it is re-driven too.
    expect(await run(mock, 'a')).toEqual(["Displaying 'A' on all cells", 'OK letter A moved=6 ms=220']);
    expect(await run(mock, 'max', 3000)).toEqual(['Setting all servos to max', 'OK max moved=30 ms=700']);
  });

  it('legacy firmware mode never replies OK/ERR', async () => {
    const mock = new MockDevice({ resetOnOpen: false, legacy: true });
    expect(await run(mock, 'hello')).toEqual(['Unknown command: hello']);
  });

  it('processes commands one at a time and never answers ERR busy (the firmware has no queue)', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    for (let i = 0; i < 10; i++) await mock.writeLine('ping');
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.sent).toEqual(new Array(10).fill('OK ping'));
  });

  it('silently loses input that overflows the 1024-byte UART RX buffer', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    await mock.writeLine('max'); // blocks for 700 ms while the rest waits in the buffer
    const filler = 'ping' + ' '.repeat(90); // 94 bytes + "\n" = 95 bytes per line
    for (let i = 0; i < 12; i++) await mock.writeLine(filler); // 10 fit (950 bytes), 2 are lost
    await vi.advanceTimersByTimeAsync(3000);
    expect(mock.sent.filter((l) => l === 'OK ping')).toHaveLength(10);
    expect(mock.sent.some((l) => l.startsWith('ERR'))).toBe(false);
  });

  it('prints the firmware help text before OK help', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    const out = await run(mock, '? #h');
    expect(out).toHaveLength(23);
    expect(out[0]).toBe('Braille device ready (fw 0.4.0-mock, protocol 1).');
    expect(out[17]).toBe('  <index>,<pwm>          - raw PWM value 90-520 on one servo (calibration)');
    expect(out[21]).toBe('Append " #<tag>" to any command to get the tag echoed in its OK/ERR line.');
    expect(out[22]).toBe('OK help #h');
  });
});

// ---------------------------------------------------------------------------
// Firmware reply table. Every expected line below was derived by reading
// src/main.cpp (serial_poll, handle_command, cmd_servo, parse_cells). Each row
// runs on a fresh, booted mock (all dots down and trusted), so moved= and ms=
// are deterministic: ms = (moved - 1) * 20 + 120, i.e. delay(step) between
// real moves plus SETTLE_MS once (apply_masks).
// ---------------------------------------------------------------------------

type Row = [input: string, expected: string[]];

const FIRMWARE_REPLIES: Row[] = [
  // serial_poll(): blank lines, CMD_MAX_LEN, control bytes, line terminators
  ['', []],
  [' \t  ', []], // spaces/tabs only: no reply at all
  ['x'.repeat(97), ['ERR range line too long']],
  ['ping' + ' '.repeat(92), ['OK ping']], // exactly 96 bytes
  ['ping' + ' '.repeat(92) + '\x01', ['ERR badarg control byte']], // control bytes are not stored/counted
  ['x'.repeat(97) + '\x01', ['ERR range line too long']], // too long wins
  ['ping #7\x7f', ['ERR badarg control byte']], // untagged
  ['ping\rget', ['OK ping', 'OK get 0,0,0,0,0']], // \r ends a line too
  [' ', ['ERR badcmd  ']], // String::trim() does not strip NBSP

  // handle_command(): " #tag" suffix, echoed only in the terminal line
  ['ping #42', ['OK ping #42']],
  ['hello #', ['ERR badcmd hello #']], // nothing after "#": not a tag
  ['get #a b', ['ERR badcmd get #a b']], // a space after the tag: not a tag
  ['bogus #t', ['ERR badcmd bogus #t']],
  ['7,430 #c', ['Setting servo 7 to PWM 430', 'OK servo 7 430 #c']],
  [',5', ['ERR badcmd ,5']],

  // hello / ping / get and the "takes no args" guard
  ['hello', ['OK hello fw=0.4.0-mock proto=1 cells=5 dots=6 pwm1=ok pwm2=ok']],
  ['HeLLo', ['OK hello fw=0.4.0-mock proto=1 cells=5 dots=6 pwm1=ok pwm2=ok']],
  ['ping', ['OK ping']],
  ['get', ['OK get 0,0,0,0,0']],
  ['HELLO,1', ['ERR badarg hello takes no args']],
  ['ping,', ['ERR badarg ping takes no args']],
  ['get,0', ['ERR badarg get takes no args']],
  ['refresh,2', ['ERR badarg refresh takes no args']],
  ['sleep,2', ['ERR badarg sleep takes no args']],
  ['dump,x', ['ERR badarg dump takes no args']],
  ['help,1', ['ERR badarg help takes no args']],
  ['?,1', ['ERR badarg ? takes no args']],

  // show + parse_cells()
  ['show', ['OK show moved=0 ms=0']],
  ['show,5,21,30', ['OK show moved=9 ms=280']],
  ['show, 1 ,-,2', ['OK show moved=2 ms=140']],
  ['show,x3F', ['OK show moved=6 ms=220']],
  ['show,x', ['ERR badarg hex']], // a bare "x" is a broken frame, not "clear all"
  ['show,x0', ['ERR badarg hex']],
  ['show,x0G', ['ERR badarg hex']],
  ['show,x40', ['ERR range cell 0']],
  ['show,x010203040506', ['ERR badarg hex']], // 6 cells
  ['show,⠁⠃', ['OK show moved=3 ms=160']],
  ['show,⠁a', ['ERR badarg utf8']],
  ['show,⣿', ['ERR badarg not 6-dot braille']], // U+28FF is 8-dot
  ['show,1,64', ['ERR range cell 1 0-63']],
  ['show,1234567890', ['ERR range cell 0 0-63']], // more than 9 digits
  ['show,1,,2', ["ERR badarg cell 1 ''"]],
  ['show,1,2,3,4,5,6', ['ERR range max 5 cells']],

  // cell,<i>,<mask>
  ['cell,2,9', ['OK cell 2 moved=2 ms=140']],
  ['cell, 02 ,9', ['OK cell 02 moved=2 ms=140']], // echoes the index as typed
  ['cell,3,x09', ['OK cell 3 moved=2 ms=140']],
  ['cell,3,⠉', ['OK cell 3 moved=2 ms=140']],
  ['cell,1,-', ['OK cell 1 moved=0 ms=0']],
  ['cell,1,64', ['ERR range mask 0-63']],
  ['cell,1,abc', ["ERR badarg mask 'abc'"]],
  ['cell,3,', ["ERR badarg mask ''"]],
  ['cell,3,x', ['ERR badarg hex']],
  ['cell,3,x0102', ['ERR badarg one mask']],
  ['cell,3,⠁⠁', ['ERR badarg one mask']],
  ['cell,1,1,2', ['ERR badarg one mask']],
  ['cell,7,1', ['ERR range cell 0-4']],
  ['cell,a,1', ['ERR badarg cell,<0-4>,<mask>']],
  ['cell,1', ['ERR badarg cell,<0-4>,<mask>']],

  // text,<chars>: args not trimmed; characters are checked before the length
  ['text', ['OK text moved=0 ms=0']],
  ['text,ab', ['OK text moved=3 ms=160']],
  ['text, AB', ['OK text moved=3 ms=160']],
  ['text,a_b', ['OK text moved=3 ms=160']],
  ['text,a1', ['ERR badarg use masks']],
  ['text,ąąą', ['ERR badarg use masks']],
  ['text,abcdef', ['ERR range max 5 cells']],

  // clear / space
  ['clear', ['Clearing all cells', 'OK clear moved=0 ms=0']],
  ['SPACE', ['Clearing all cells', 'OK clear moved=0 ms=0']],
  ['space,02', ['OK clear 2 moved=0 ms=0']],
  ['clear,x', ['ERR badarg clear,<0-4>']],
  ['clear,', ['ERR badarg clear,<0-4>']],
  ['clear,5', ['ERR range cell 0-4']],

  // anim / idle
  ['anim', ['OK anim 20']],
  ['anim,0', ['OK anim 20']],
  ['anim,300', ['OK anim 300']],
  ['anim,19', ['ERR range 0 or 20-2000']],
  ['anim,2001', ['ERR range 0 or 20-2000']],
  ['anim,-1', ['ERR badarg anim,<ms>']],
  ['idle', ['OK idle 2,300']],
  ['idle,0,0', ['OK idle 0,0']],
  ['idle, 5 , 10', ['OK idle 5,10']],
  ['idle,5', ['ERR badarg idle,<down_s>,<sleep_s>']],
  ['idle,1,2,3', ['ERR badarg idle,<down_s>,<sleep_s>']],
  ['idle,86401,1', ['ERR range 0-86400']],

  // refresh / sleep / whole-device min, max
  ['refresh', ['OK refresh moved=30 ms=700']],
  ['sleep', ['OK sleep']],
  ['min', ['Setting all servos to min', 'OK min moved=30 ms=700']],
  ['ALL, Max', ['Setting all servos to max', 'OK max moved=30 ms=700']],
  ['all', ['ERR badcmd all']],
  ['min,1', ['ERR badcmd min,1']],

  // a single letter on every cell
  ['a', ["Displaying 'A' on all cells", 'OK letter A moved=5 ms=200']],
  ['z', ["Displaying 'Z' on all cells", 'OK letter Z moved=20 ms=500']],
  ['a,1', ['ERR badcmd a,1']],
  ['ab', ['ERR badcmd ab']],
  ['ą', ['ERR badcmd ą']],
  ['K', ['ERR badcmd K']], // Kelvin sign: toupper() is ASCII only

  // legacy raw servo (cmd_servo)
  ['7', ['ERR badcmd 7']],
  ['7a,5', ['ERR badcmd 7a,5']],
  ['30,min', ["ERR range servo '30'"]],
  ['7,', ["ERR badarg pwm ''"]],
  ['7,mni', ["ERR badarg pwm 'mni'"]],
  ['7,89', ['ERR range pwm 90-520']],
  ['7,521', ['ERR range pwm 90-520']],
  ['7,5000', ['ERR range pwm 90-520']],
  ['7,90', ['Setting servo 7 to PWM 90', 'OK servo 7 90']],
  ['7, 0430 ', ['Setting servo 7 to PWM 430', 'OK servo 7 430']],
  ['0,MIN', ['Setting servo 0 to PWM 470', 'OK servo 0 min']],
  ['29,max', ['Setting servo 29 to PWM 460', 'OK servo 29 max']],
];

describe('MockDevice matches the firmware reply table', () => {
  it.each(FIRMWARE_REPLIES)('%j', async (input, expected) => {
    const mock = new MockDevice({ resetOnOpen: false });
    expect(await run(mock, input, 3000)).toEqual(expected);
  });
});

/** PCA9685 #2 missing: which commands validate first and which answer "ERR hw" first. */
const FIRMWARE_REPLIES_PWM2_MISSING: Row[] = [
  ['hello', ['OK hello fw=0.4.0-mock proto=1 cells=5 dots=6 pwm1=ok pwm2=fail']],
  ['show,1', ['ERR hw pwm2']],
  ['show,64', ['ERR hw pwm2']], // show checks the modules before parsing
  ['cell,1,64', ['ERR range mask 0-63']], // cell parses first
  ['cell,1,1', ['ERR hw pwm2']],
  ['text,ą', ['ERR badarg use masks']],
  ['text,a', ['ERR hw pwm2']],
  ['clear', ['ERR hw pwm2']], // no "Clearing all cells" info line
  ['clear,9', ['ERR range cell 0-4']],
  ['clear,1', ['ERR hw pwm2']],
  ['refresh', ['ERR hw pwm2']],
  ['sleep', ['ERR hw pwm2']],
  ['max', ['ERR hw pwm2']],
  ['a', ['ERR hw pwm2']],
  ['anim,300', ['OK anim 300']],
  ['20,430', ['ERR hw pwm2']],
  ['20,abc', ["ERR badarg pwm 'abc'"]],
  ['7,430', ['Setting servo 7 to PWM 430', 'OK servo 7 430']],
];

describe('MockDevice matches the firmware replies with PCA9685 #2 missing', () => {
  it.each(FIRMWARE_REPLIES_PWM2_MISSING)('%j', async (input, expected) => {
    const mock = new MockDevice({ resetOnOpen: false, pwm2Ok: false });
    expect(await run(mock, input, 3000)).toEqual(expected);
  });

  it('reports pwm1 when PCA9685 #1 is the missing one', async () => {
    const mock = new MockDevice({ resetOnOpen: false, pwm1Ok: false });
    expect(await run(mock, 'show,1')).toEqual(['ERR hw pwm1']);
    expect(await run(mock, '7,430')).toEqual(['ERR hw pwm1']);
    expect(await run(mock, '20,430')).toEqual(['Setting servo 20 to PWM 430', 'OK servo 20 430']);
  });
});

describe('calibration table', () => {
  it('matches servo_range in src/main.cpp', () => {
    // vitest runs with the app/ directory as root.
    const firmware = readFileSync(resolve(process.cwd(), '../src/main.cpp'), 'utf8');
    const define = (name: string) => Number(new RegExp(`#define ${name} (\\d+)`).exec(firmware)![1]);
    const value = (v: string) => (/^\d+$/.test(v) ? Number(v) : define(v));
    const body = /servo_range\[TOTAL_SERVOS\] = \{([\s\S]*?)\r?\n\};/.exec(firmware)![1]!;
    // Rows only: the comments repeat old values in the same {a, b} shape.
    const rows = [...body.replace(/\/\/.*$/gm, '').matchAll(/\{\s*(\w+)\s*,\s*(\w+)\s*\}/g)].map(
      (m) => [value(m[1]!), value(m[2]!)],
    );
    expect(rows).toHaveLength(30);
    expect(SERVO_RANGE).toEqual(rows);
  });
});
