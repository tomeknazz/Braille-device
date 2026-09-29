// In-memory simulator of firmware protocol v1 (docs/PROTOCOL.md §4, §5).
// Mirrors the reply strings of the firmware in src/main.cpp (not the older
// sketch in PROTOCOL.md §8), diff-based "moved=" counting and simulated
// cascade timing, so the app and the tests run without hardware.
//
// Timers are looked up on globalThis at call time so vi.useFakeTimers() works.

import { letterByChar } from '../braille/table';
import {
  ANIM_MAX_MS,
  ANIM_MIN_MS,
  CMD_MAX_LEN,
  DEFAULT_ANIM_MS,
  MAX_CELLS,
  MAX_MASK,
  PROTO_VERSION,
  byteLength,
} from './protocol';
import { Emitter, type LineTransport, type Unsubscribe } from './transport';

const DOTS = 6;
const TOTAL_SERVOS = MAX_CELLS * DOTS;
const SERVOS_PER_MODULE = 16;
const IDLE_DOWN_S_DEFAULT = 2;
const IDLE_SLEEP_S_DEFAULT = 300;
const IDLE_MAX_S = 86400;
const PWM_MIN = 90;
const PWM_MAX = 520;
/** Firmware FULL_TRAVEL_MS: extra wait in go_to_sleep() when a dot's position is unknown. */
const FULL_TRAVEL_MS = 400;
/** Firmware RX_BUFFER_SIZE: bytes the UART holds while a command blocks; the rest is lost. */
const RX_BUFFER_SIZE = 1024;
export const MOCK_SETTLE_MS = 120;

/**
 * Snapshot of servo_range in src/main.cpp ({retracted, extended} per servo).
 * Only used for the `<i>,min|max` info line and `dump`; the app never reads it.
 */
export const SERVO_RANGE: readonly (readonly [number, number])[] = [
  [470, 430], [120, 160], [140, 180], [120, 160], [175, 210], [490, 465], // cell 0
  [140, 100], [120, 150], [115, 130], [120, 160], [165, 195], [480, 470], // cell 1
  [510, 470], [120, 175], [130, 170], [130, 160], [120, 160], [480, 450], // cell 2
  [500, 450], [120, 170], [110, 135], [145, 175], [140, 180], [475, 440], // cell 3
  [475, 450], [155, 190], [155, 185], [110, 140], [130, 170], [500, 460], // cell 4
];

export interface MockDeviceOptions {
  /** Simulate the DTR reset on port open: ignore input, then boot. Default true. */
  resetOnOpen?: boolean;
  /** Time from open to "EVT boot" (includes the boot retract cascade). Default 800 ms. */
  bootMs?: number;
  /** Behave like the pre-protocol firmware: no OK/ERR lines, "Unknown command" text. */
  legacy?: boolean;
  /** Protocol version reported by hello / EVT boot. Default 1. */
  proto?: number;
  fw?: string;
  pwm1Ok?: boolean;
  pwm2Ok?: boolean;
  /** Extra latency added to every reply (transport delay). Default 2 ms. */
  latencyMs?: number;
}

type Hold = 'unknown' | 'powered';

interface Outcome {
  lines: string[];
  durationMs: number;
}

/**
 * letter_mask(): A-Z mask from the firmware's braille_alphabet (letters a-z in
 * the app table). ASCII only, like toupper(): the Kelvin sign is not a "k".
 */
function firmwareLetterMask(ch: string): number | null {
  if (!/^[A-Za-z]$/.test(ch)) return null;
  return letterByChar.get(ch.toLowerCase())?.mask ?? null;
}

/** Arduino String::trim(): strips isspace() bytes only (not NBSP or other Unicode blanks). */
const ftrim = (s: string) => s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
/** Arduino String::toLowerCase() / equalsIgnoreCase(): ASCII only. */
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** serial_poll(): bytes below 0x20 except tab, and 0x7F, are control bytes. */
// eslint-disable-next-line no-control-regex
const CONTROL_BYTES = /[\x00-\x08\x0a-\x1f\x7f]/g;

const isUint = (s: string) => /^\d+$/.test(s);

/** hex_nibble() on one byte: 0-15, or -1. */
function hexNibble(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  const l = b | 0x20;
  return l >= 0x61 && l <= 0x66 ? l - 0x61 + 10 : -1;
}

/** Firmware print_help(): the info lines before "OK help", also printed at boot. */
function helpLines(fw: string, proto: number): string[] {
  return [
    `Braille device ready (fw ${fw}, protocol ${proto}).`,
    '  hello                  - handshake, firmware and PCA9685 status',
    '  ping                   - keepalive, resets the sleep timer',
    '  show[,<m0>,...,<m4>]   - set every cell; mask 0-63, bit0 = dot 1 ... bit5 = dot 6',
    "                           '-' keeps a cell, missing cells are cleared,",
    '                           also show,xHHHH... (hex) or show,<braille chars>',
    '  cell,<i>,<mask>        - set one cell (0-4), others untouched',
    "  text,<chars>           - up to 5 of A-Z, '_' or space = blank cell",
    '  clear | space          - retract every cell (braille space)',
    '  clear,<i>              - retract one cell',
    '  get                    - current masks of all cells',
    '  anim[,<ms>]            - step delay between dots: 0 = normal, 20-2000 = slow',
    '  idle[,<down_s>,<sleep_s>] - idle policy, 0 disables a stage (default 2,300)',
    '  refresh                - re-drive every dot to match the current masks',
    '  sleep                  - clear the display and switch off all PWM',
    '  <letter>               - show an A-Z letter on every cell',
    '  min | max              - all pins down / up, one by one (also all,min / all,max)',
    '  <index>,<pwm>          - raw PWM value 90-520 on one servo (calibration)',
    '  <index>,min | max      - one servo to its calibrated retracted / extended position',
    '  dump                   - print the calibration table',
    '  help | ?               - this text',
    'Append " #<tag>" to any command to get the tag echoed in its OK/ERR line.',
  ];
}

/** Verbs that reject a stray ",..." instead of acting on the whole device (handle_command). */
const NO_ARG_VERBS = new Set(['hello', 'ping', 'get', 'refresh', 'sleep', 'dump', 'help', '?']);

/** Firmware parse_uint(): status 1 = ok, 0 = not a number, -1 = out of range. */
function parseUint(s: string, max: number): { status: 1 | 0 | -1; value: number } {
  if (!isUint(s)) return { status: 0, value: 0 };
  if (s.length > 9) return { status: -1, value: 0 }; // would overflow toInt()
  const value = Number(s);
  return { status: value <= max ? 1 : -1, value };
}

export class MockDevice implements LineTransport {
  readonly kind = 'mock' as const;
  readonly label = 'symulator urządzenia';

  /** Current display state (what the learner would feel). */
  readonly cells: number[] = new Array<number>(MAX_CELLS).fill(0);
  /** Every line the app sent, in order (for tests). */
  readonly received: string[] = [];
  /** Every line the device sent, in order (for tests). */
  readonly sent: string[] = [];
  stepMs = DEFAULT_ANIM_MS;
  idleDownS = IDLE_DOWN_S_DEFAULT;
  idleSleepS = IDLE_SLEEP_S_DEFAULT;
  booted: boolean;
  /** Extra delay added to every reply; may be changed at run time. */
  latencyMs: number;

  private readonly opts: Required<Omit<MockDeviceOptions, 'latencyMs'>>;
  private readonly hold: Hold[] = new Array<Hold>(TOTAL_SERVOS).fill('unknown');
  private readonly events = new Emitter<{ line: [string]; close: [string | undefined] }>();
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private busy = false;
  private closed = false;
  private dropReplies = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: MockDeviceOptions = {}) {
    this.opts = {
      resetOnOpen: options.resetOnOpen ?? true,
      bootMs: options.bootMs ?? 800,
      legacy: options.legacy ?? false,
      proto: options.proto ?? PROTO_VERSION,
      fw: options.fw ?? '0.4.0-mock',
      pwm1Ok: options.pwm1Ok ?? true,
      pwm2Ok: options.pwm2Ok ?? true,
    };
    this.latencyMs = options.latencyMs ?? 2;
    this.booted = !this.opts.resetOnOpen;
    if (this.opts.resetOnOpen) this.reset('poweron', this.opts.bootMs);
    else this.bootRetract();
  }

  // --- LineTransport -------------------------------------------------------

  async writeLine(line: string): Promise<void> {
    if (this.closed) throw new Error('MockDevice is closed');
    this.received.push(line);
    if (!this.booted) return; // bytes sent during reset are lost, like on the ESP32
    // serial_poll() ends a line at every \r or \n; empty pieces carry nothing.
    for (const piece of line.split(/[\r\n]/)) {
      if (piece === '') continue;
      // The firmware has no command queue and never answers "ERR busy": input
      // waits in the UART RX buffer, and bytes that do not fit are lost silently.
      const bytes = byteLength(piece) + 1;
      if (this.queuedBytes + bytes > RX_BUFFER_SIZE) continue;
      this.queuedBytes += bytes;
      this.queue.push(piece);
    }
    this.pump();
  }

  onLine(handler: (line: string) => void): Unsubscribe {
    return this.events.on('line', handler);
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    return this.events.on('close', handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) globalThis.clearTimeout(t);
    this.timers.clear();
    this.events.emit('close', 'closed');
    this.events.clear();
  }

  // --- Test / demo hooks ---------------------------------------------------

  /** The next `n` terminal replies are swallowed (simulates a lost reply). */
  dropNextReplies(n = 1): void {
    this.dropReplies += n;
  }

  /** Simulates a reset (e.g. brownout): state lost, EVT boot after `bootMs`. */
  reset(reason = 'sw', bootMs = this.opts.bootMs): void {
    this.booted = false;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.busy = false;
    this.cells.fill(0);
    this.hold.fill('unknown');
    this.stepMs = DEFAULT_ANIM_MS;
    this.idleDownS = IDLE_DOWN_S_DEFAULT;
    this.idleSleepS = IDLE_SLEEP_S_DEFAULT;
    this.later(bootMs, () => {
      this.bootRetract();
      this.booted = true;
      if (this.opts.legacy) {
        this.emitLines(['Braille tester ready. Type help for commands.']);
      } else {
        // setup(): help text, missing-module notes, then EVT boot.
        this.emitLines([
          ...helpLines(this.opts.fw, this.opts.proto),
          ...(this.opts.pwm1Ok ? [] : ['PCA9685 #1 (0x40) not found - motion disabled']),
          ...(this.opts.pwm2Ok ? [] : ['PCA9685 #2 (0x41) not found - motion disabled']),
          `EVT boot fw=${this.opts.fw} proto=${this.opts.proto} reason=${reason}`,
        ]);
      }
    });
  }

  /** Simulates the idle auto-sleep (docs/PROTOCOL.md §6). */
  autoSleep(): void {
    this.cells.fill(0);
    this.emitLines(['EVT sleep']);
  }

  // --- Internals -------------------------------------------------------------

  private later(ms: number, fn: () => void): void {
    const t = globalThis.setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.timers.add(t);
  }

  private bootRetract(): void {
    // setup(): every hold UNKNOWN, then apply_masks(blank) -> all dots known and
    // down, but only when both PCA9685s answered.
    this.hold.fill('unknown');
    if (this.opts.pwm1Ok && this.opts.pwm2Ok) this.applyMasks(new Array<number>(MAX_CELLS).fill(0));
  }

  private emitLines(lines: string[]): void {
    for (const l of lines) {
      this.sent.push(l);
      this.events.emit('line', l);
    }
  }

  private reply(lines: string[], delayMs = 0): void {
    this.later(delayMs + this.latencyMs, () => {
      const terminalIdx = lines.findIndex((l) => l.startsWith('OK ') || l.startsWith('ERR '));
      if (terminalIdx >= 0 && this.dropReplies > 0) {
        this.dropReplies--;
        lines = lines.filter((_, i) => i !== terminalIdx);
      }
      this.emitLines(lines);
    });
  }

  private pump(): void {
    if (this.busy || this.closed) return;
    const line = this.queue.shift();
    if (line === undefined) return;
    this.queuedBytes -= byteLength(line) + 1;
    this.busy = true;
    const { lines, durationMs } = this.handle(line);
    this.reply(lines, durationMs);
    this.later(durationMs + this.latencyMs, () => {
      this.busy = false;
      this.pump();
    });
  }

  /**
   * apply_masks(): moves only dots that differ or whose hold is unknown. The
   * step delay runs only between two real moves, then SETTLE_MS once, so
   * ms = (moved - 1) * step + 120 (the firmware adds a little I2C time).
   */
  private applyMasks(target: readonly number[], stepMs = this.stepMs): { moved: number; ms: number } {
    let moved = 0;
    for (let pass = 0; pass < 2; pass++) {
      const extendPass = pass === 1;
      for (let c = 0; c < MAX_CELLS; c++) {
        for (let d = 0; d < DOTS; d++) {
          const want = ((target[c]! >> d) & 1) === 1;
          if (want !== extendPass) continue;
          const i = c * DOTS + d;
          const have = ((this.cells[c]! >> d) & 1) === 1;
          if (want === have && this.hold[i] !== 'unknown') continue;
          this.hold[i] = 'powered';
          moved++;
        }
      }
    }
    for (let c = 0; c < MAX_CELLS; c++) this.cells[c] = target[c]!;
    const ms = moved > 0 ? (moved - 1) * stepMs + MOCK_SETTLE_MS : 0;
    return { moved, ms };
  }

  private motion(target: readonly number[], lines: string[], okPrefix: string): Outcome {
    const { moved, ms } = this.applyMasks(target);
    lines.push(`${okPrefix} moved=${moved} ms=${ms}`);
    return { lines, durationMs: ms };
  }

  /**
   * parse_cells(): decimal list with "-", "xHHHH..." hex, or UTF-8 braille.
   * Returns the target masks and the number of cells given, or the ERR line.
   */
  private parseCells(arg: string): { t: number[]; n: number } | string {
    const a = ftrim(arg);
    const t = new Array<number>(MAX_CELLS).fill(0);
    if (a === '') return { t, n: 0 }; // "show" == clear all

    const bytes = new TextEncoder().encode(a);
    if (a[0] === 'x' || a[0] === 'X') {
      // Hex "x0103091911", counted in bytes. A bare "x" is a broken frame, not "clear all".
      const n = bytes.length - 1;
      if (n === 0 || n % 2 || n / 2 > MAX_CELLS) return 'ERR badarg hex';
      for (let c = 0; c < n / 2; c++) {
        const hi = hexNibble(bytes[1 + 2 * c]!);
        const lo = hexNibble(bytes[2 + 2 * c]!);
        if (hi < 0 || lo < 0) return 'ERR badarg hex';
        const v = hi * 16 + lo;
        if (v > MAX_MASK) return `ERR range cell ${c}`;
        t[c] = v;
      }
      return { t, n: n / 2 };
    }

    if (bytes[0] === 0xe2) {
      // U+2800..U+283F = E2 A0 80..BF
      if (bytes.length % 3 || bytes.length / 3 > MAX_CELLS) return 'ERR badarg utf8';
      for (let c = 0; c < bytes.length / 3; c++) {
        const b0 = bytes[3 * c]!;
        const b1 = bytes[3 * c + 1]!;
        const b2 = bytes[3 * c + 2]!;
        if (b0 !== 0xe2 || b1 !== 0xa0 || b2 < 0x80 || b2 > 0xbf) return 'ERR badarg not 6-dot braille';
        t[c] = b2 - 0x80;
      }
      return { t, n: bytes.length / 3 };
    }

    // Decimal "1,3,-,0". The "max 5 cells" check runs per token, like the firmware.
    const toks = a.split(',');
    for (let c = 0; c < toks.length; c++) {
      if (c >= MAX_CELLS) return 'ERR range max 5 cells';
      const tok = ftrim(toks[c]!);
      const p = parseUint(tok, MAX_MASK);
      if (tok === '-') t[c] = this.cells[c]!;
      else if (p.status > 0) t[c] = p.value;
      else if (p.status < 0) return `ERR range cell ${c} 0-63`;
      else return `ERR badarg cell ${c} '${tok}'`;
    }
    return { t, n: toks.length };
  }

  private handle(rawLine: string): Outcome {
    const none: Outcome = { lines: [], durationMs: 0 };
    if (this.opts.legacy) {
      const l = rawLine.trim();
      return l === '' ? none : this.handleLegacy(l);
    }
    // serial_poll(): control bytes are not stored, so they do not count toward
    // the CMD_MAX_LEN bytes the raw (untrimmed) line may hold. "Too long" wins
    // over "control byte"; neither reply carries a tag. A blank line (spaces
    // and tabs only) is dropped without a reply.
    const stored = rawLine.replace(CONTROL_BYTES, '');
    if (byteLength(stored) > CMD_MAX_LEN) {
      return { lines: ['ERR range line too long'], durationMs: 0 };
    }
    if (stored !== rawLine) return { lines: ['ERR badarg control byte'], durationMs: 0 };
    let line = ftrim(rawLine);
    if (line === '') return none;

    // Optional " #<tag>": non-empty, no further space (main.cpp handle_command).
    let tag = '';
    const h = line.lastIndexOf(' #');
    if (h >= 0 && h + 2 < line.length && line.indexOf(' ', h + 1) < 0) {
      tag = ' ' + line.slice(h + 1);
      line = ftrim(line.slice(0, h));
    }
    const out = this.dispatch(line);
    if (tag) {
      const last = out.lines.length - 1;
      if (last >= 0) out.lines[last] += tag;
    }
    return out;
  }

  private moduleOk(servo: number): boolean {
    return servo < SERVOS_PER_MODULE ? this.opts.pwm1Ok : this.opts.pwm2Ok;
  }

  /** Legacy "<index>,<pwm|min|max>" (cmd_servo). */
  private servo(target: string, rawValue: string): Outcome {
    const err = (s: string): Outcome => ({ lines: [`ERR ${s}`], durationMs: 0 });
    const idx = parseUint(target, TOTAL_SERVOS - 1);
    if (idx.status <= 0) return err(`range servo '${target}'`);
    const i = idx.value;
    const value = ftrim(rawValue);
    let pwm: number;
    let shown: string;
    if (asciiLower(value) === 'min') {
      pwm = SERVO_RANGE[i]![0];
      shown = 'min';
    } else if (asciiLower(value) === 'max') {
      pwm = SERVO_RANGE[i]![1];
      shown = 'max';
    } else {
      // Rejected, not clamped: "5,45" (typo for 450) must not report success.
      const p = parseUint(value, PWM_MAX);
      if (p.status === 0) return err(`badarg pwm '${value}'`);
      if (p.status < 0 || p.value < PWM_MIN) return err(`range pwm ${PWM_MIN}-${PWM_MAX}`);
      pwm = p.value;
      shown = String(pwm);
    }
    // Only the module that drives this servo has to be present (calibration).
    if (!this.moduleOk(i)) return err(`hw ${i < SERVOS_PER_MODULE ? 'pwm1' : 'pwm2'}`);
    this.hold[i] = 'unknown'; // next show/refresh re-drives it
    return { lines: [`Setting servo ${i} to PWM ${pwm}`, `OK servo ${i} ${shown}`], durationMs: MOCK_SETTLE_MS };
  }

  private dispatch(line: string): Outcome {
    const comma = line.indexOf(',');
    const verb = ftrim(comma < 0 ? line : line.slice(0, comma));
    const args = comma < 0 ? '' : line.slice(comma + 1); // NOT trimmed ("text, AB")
    const v = asciiLower(verb);
    const ok = (s: string): Outcome => ({ lines: [`OK ${s}`], durationMs: 0 });
    const err = (s: string): Outcome => ({ lines: [`ERR ${s}`], durationMs: 0 });
    const motionAllowed = this.opts.pwm1Ok && this.opts.pwm2Ok;
    const hwErr = () => err(`hw ${this.opts.pwm1Ok ? 'pwm2' : 'pwm1'}`);

    if (verb === '') return err(`badcmd ${line}`);

    // 1. Legacy raw servo: only an all-digit target followed by a value.
    if (/^\d/.test(verb)) {
      if (comma < 0 || !isUint(verb)) return err(`badcmd ${line}`);
      return this.servo(verb, args);
    }

    // "refresh,2" or "sleep,2" must not act on the whole device.
    if (comma >= 0 && NO_ARG_VERBS.has(v)) return err(`badarg ${v} takes no args`);

    // 2. New verbs.
    switch (v) {
      case 'hello':
        return ok(
          `hello fw=${this.opts.fw} proto=${this.opts.proto} cells=${MAX_CELLS} dots=${DOTS} ` +
            `pwm1=${this.opts.pwm1Ok ? 'ok' : 'fail'} pwm2=${this.opts.pwm2Ok ? 'ok' : 'fail'}`,
        );
      case 'ping':
        return ok('ping');
      case 'get':
        return ok(`get ${this.cells.join(',')}`);
      case 'show': {
        if (!motionAllowed) return hwErr();
        const p = this.parseCells(args);
        if (typeof p === 'string') return { lines: [p], durationMs: 0 };
        return this.motion(p.t, [], 'OK show');
      }
      case 'cell': {
        const c2 = args.indexOf(',');
        const si = ftrim(c2 < 0 ? args : args.slice(0, c2));
        const ci = parseUint(si, MAX_CELLS - 1);
        if (c2 < 0 || ci.status === 0) return err('badarg cell,<0-4>,<mask>');
        if (ci.status < 0) return err('range cell 0-4');
        const sm = ftrim(args.slice(c2 + 1));
        const t = [...this.cells];
        if (sm !== '-') {
          // "-" keeps the cell as it is
          if (sm.includes(',')) return err('badarg one mask');
          // Decimal is parsed here, so its errors name the mask, not "cell 0".
          const pm = parseUint(sm, MAX_MASK);
          if (pm.status > 0) {
            t[ci.value] = pm.value;
          } else if (pm.status < 0) {
            return err('range mask 0-63');
          } else if (sm[0] === 'x' || sm[0] === 'X' || new TextEncoder().encode(sm)[0] === 0xe2) {
            const one = this.parseCells(sm);
            if (typeof one === 'string') return { lines: [one], durationMs: 0 };
            if (one.n !== 1) return err('badarg one mask');
            t[ci.value] = one.t[0]!;
          } else {
            return err(`badarg mask '${sm}'`);
          }
        }
        if (!motionAllowed) return hwErr();
        return this.motion(t, [], `OK cell ${si}`);
      }
      case 'text': {
        // The firmware counts bytes; every byte of a non-ASCII letter fails A-Z.
        // Characters are checked first: "text,żółw" needs masks, it is not "too long".
        const bytes = new TextEncoder().encode(args);
        const t = new Array<number>(MAX_CELLS).fill(0);
        for (let c = 0; c < bytes.length; c++) {
          const ch = String.fromCharCode(bytes[c]!);
          const m = ch === ' ' || ch === '_' ? 0 : firmwareLetterMask(ch);
          if (m === null) return err('badarg use masks');
          if (c < MAX_CELLS) t[c] = m;
        }
        if (bytes.length > MAX_CELLS) return err('range max 5 cells');
        if (!motionAllowed) return hwErr();
        return this.motion(t, [], 'OK text');
      }
      case 'clear':
      case 'space': {
        if (comma >= 0) {
          const ci = parseUint(ftrim(args), MAX_CELLS - 1);
          if (ci.status === 0) return err('badarg clear,<0-4>');
          if (ci.status < 0) return err('range cell 0-4');
          if (!motionAllowed) return hwErr();
          const t = [...this.cells];
          t[ci.value] = 0;
          return this.motion(t, [], `OK clear ${ci.value}`);
        }
        if (!motionAllowed) return hwErr();
        return this.motion(new Array<number>(MAX_CELLS).fill(0), ['Clearing all cells'], 'OK clear');
      }
      case 'anim': {
        const a = ftrim(args);
        if (a.length) {
          const p = parseUint(a, ANIM_MAX_MS);
          if (p.status === 0) return err('badarg anim,<ms>');
          if (p.status < 0 || (p.value > 0 && p.value < ANIM_MIN_MS)) return err('range 0 or 20-2000');
          this.stepMs = p.value === 0 ? DEFAULT_ANIM_MS : p.value;
        }
        return ok(`anim ${this.stepMs}`);
      }
      case 'idle': {
        const a = ftrim(args);
        if (a.length) {
          const c2 = a.indexOf(',');
          if (c2 < 0) return err('badarg idle,<down_s>,<sleep_s>');
          const pd = parseUint(ftrim(a.slice(0, c2)), IDLE_MAX_S);
          const ps = parseUint(ftrim(a.slice(c2 + 1)), IDLE_MAX_S);
          if (pd.status === 0 || ps.status === 0) return err('badarg idle,<down_s>,<sleep_s>');
          if (pd.status < 0 || ps.status < 0) return err('range 0-86400');
          this.idleDownS = pd.value;
          this.idleSleepS = ps.value;
        }
        return ok(`idle ${this.idleDownS},${this.idleSleepS}`);
      }
      case 'refresh': {
        if (!motionAllowed) return hwErr();
        this.hold.fill('unknown');
        return this.motion([...this.cells], [], 'OK refresh');
      }
      case 'sleep': {
        if (!motionAllowed) return hwErr();
        // go_to_sleep(): normal pace whatever anim says, plus a full swing when a
        // dot's position was unknown (e.g. after a raw PWM). No moved=/ms= here.
        const unknown = this.hold.includes('unknown');
        const { ms } = this.applyMasks(new Array<number>(MAX_CELLS).fill(0), DEFAULT_ANIM_MS);
        return { lines: ['OK sleep'], durationMs: ms + (unknown ? FULL_TRAVEL_MS : 0) };
      }
      default:
        break;
    }

    // 3. Legacy words.
    if (v === 'dump') {
      const rows = SERVO_RANGE.map(([r, e], i) => `${i},${Math.floor(i / DOTS)},${(i % DOTS) + 1},${r},${e}`);
      return { lines: ['index,cell,dot,retracted,extended', ...rows, `OK dump ${TOTAL_SERVOS}`], durationMs: 0 };
    }
    if (v === 'help' || v === '?') {
      return { lines: [...helpLines(this.opts.fw, this.opts.proto), 'OK help'], durationMs: 0 };
    }

    // Whole device: "min" / "max" (also "all,min" / "all,max").
    const whole = v === 'all';
    const endstop = asciiLower(ftrim(whole ? args : verb));
    if ((whole || comma < 0) && (endstop === 'min' || endstop === 'max')) {
      if (!motionAllowed) return hwErr();
      this.hold.fill('unknown');
      const t = new Array<number>(MAX_CELLS).fill(endstop === 'max' ? MAX_MASK : 0);
      return this.motion(t, [`Setting all servos to ${endstop}`], `OK ${endstop}`);
    }
    // A single letter shows that character on every cell at once.
    if (comma < 0 && verb.length === 1) {
      const m = firmwareLetterMask(verb);
      if (m !== null) {
        if (!motionAllowed) return hwErr();
        const L = verb.toUpperCase();
        return this.motion(new Array<number>(MAX_CELLS).fill(m), [`Displaying '${L}' on all cells`], `OK letter ${L}`);
      }
    }
    return err(`badcmd ${line}`);
  }

  /** Old firmware (master @ c43969e): human text only, never OK/ERR. */
  private handleLegacy(line: string): Outcome {
    if (line.includes(',')) return { lines: [`Setting servo ${parseInt(line, 10) || 0} to PWM 90`], durationMs: 0 };
    const m = line.length === 1 ? firmwareLetterMask(line) : null;
    if (m !== null) {
      this.cells.fill(m);
      return { lines: [`Displaying '${line.toUpperCase()}' on all cells`], durationMs: MAX_CELLS * DOTS * DEFAULT_ANIM_MS };
    }
    return { lines: [`Unknown command: ${line}`], durationMs: 0 };
  }
}
