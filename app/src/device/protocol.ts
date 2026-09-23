// Firmware command protocol v1 (docs/PROTOCOL.md): framing, line
// classification, reply parsing and command builders. Pure functions only,
// no I/O, so it is shared by DeviceLink, MockDevice and the tests.

export const PROTO_VERSION = 1;
export const MAX_CELLS = 5;
export const MAX_MASK = 63;
/** Firmware CASCADE_DELAY_MS: the step delay reported by `anim` in normal mode. */
export const DEFAULT_ANIM_MS = 20;
/** Smallest non-zero `anim` step delay; the firmware rejects 1-19 ms. */
export const ANIM_MIN_MS = 20;
export const ANIM_MAX_MS = 2000;
/** Firmware CMD_MAX_LEN: longest accepted command line, 96 bytes, excluding the terminator. */
export const CMD_MAX_LEN = 96;

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Splits a byte-stream-turned-text into lines on "\n", dropping a trailing
 * "\r". Chunks may cut a line (or a "\r\n" pair) anywhere.
 */
export class LineSplitter {
  private buf = '';

  constructor(private readonly maxLineLength = 4096) {}

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      out.push(line);
    }
    // Garbage without newlines (wrong baud rate, boot ROM noise) must not grow forever.
    if (this.buf.length > this.maxLineLength) {
      out.push(this.buf);
      this.buf = '';
    }
    return out;
  }

  /** Returns and clears whatever partial line is buffered. */
  flush(): string[] {
    const rest = this.buf.endsWith('\r') ? this.buf.slice(0, -1) : this.buf;
    this.buf = '';
    return rest.length ? [rest] : [];
  }
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

export interface OkLine {
  kind: 'ok';
  verb: string;
  /** Everything after the verb, without the optional " #tag". */
  data: string;
  tag?: string;
  raw: string;
}
export interface ErrLine {
  kind: 'err';
  code: string;
  detail: string;
  tag?: string;
  raw: string;
}
export interface EvtLine {
  kind: 'evt';
  name: string;
  data: string;
  raw: string;
}
export interface InfoLine {
  kind: 'info';
  raw: string;
}
export type ParsedLine = OkLine | ErrLine | EvtLine | InfoLine;
export type TerminalLine = OkLine | ErrLine;

/** Splits "<head> <rest>" on the first run of spaces. */
function splitFirst(s: string): [string, string] {
  const m = /^(\S+)\s*(.*)$/s.exec(s);
  return m ? [m[1]!, m[2]!] : ['', ''];
}

/** Removes a trailing " #tag" (docs/PROTOCOL.md §2). */
function splitTag(rest: string): { body: string; tag?: string } {
  const m = /^(?:(.*?)\s+)?#(\S+)$/s.exec(rest);
  return m ? { body: m[1] ?? '', tag: m[2]! } : { body: rest };
}

/**
 * Classifies one line from the device. Only lines starting with exactly
 * "OK ", "ERR " or "EVT " are protocol lines; everything else (help text,
 * "Setting servo 7 to PWM 430", the dump CSV, "Unknown command: hello" from
 * old firmware) is an info line the app ignores.
 */
export function parseLine(line: string): ParsedLine {
  const raw = line.replace(/[\r\n]+$/, '');
  const text = raw.trimEnd();
  if (text.startsWith('OK ')) {
    const [verb, rest] = splitFirst(text.slice(3));
    if (verb) {
      const { body, tag } = splitTag(rest);
      return tag ? { kind: 'ok', verb, data: body, tag, raw } : { kind: 'ok', verb, data: body, raw };
    }
  } else if (text.startsWith('ERR ')) {
    const [code, rest] = splitFirst(text.slice(4));
    if (code) {
      const { body, tag } = splitTag(rest);
      return tag
        ? { kind: 'err', code, detail: body, tag, raw }
        : { kind: 'err', code, detail: body, raw };
    }
  } else if (text.startsWith('EVT ')) {
    const [name, data] = splitFirst(text.slice(4));
    if (name) return { kind: 'evt', name, data, raw };
  }
  return { kind: 'info', raw };
}

/** "fw=0.4.0 proto=1 cells=5" -> { fw: "0.4.0", proto: "1", cells: "5" }. */
export function parseKeyValues(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of data.trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

function toInt(s: string | undefined): number | undefined {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined;
}

export interface HelloInfo {
  fw: string;
  proto: number;
  cells: number;
  dots: number;
  pwm1Ok: boolean;
  pwm2Ok: boolean;
  fields: Record<string, string>;
}

/** Parses the data of "OK hello fw=0.4.0 proto=1 cells=5 dots=6 pwm1=ok pwm2=ok". */
export function parseHello(data: string): HelloInfo | null {
  const kv = parseKeyValues(data);
  const proto = toInt(kv['proto']);
  if (proto === undefined) return null;
  return {
    fw: kv['fw'] ?? '?',
    proto,
    cells: toInt(kv['cells']) ?? MAX_CELLS,
    dots: toInt(kv['dots']) ?? 6,
    pwm1Ok: kv['pwm1'] === undefined ? true : kv['pwm1'] === 'ok',
    pwm2Ok: kv['pwm2'] === undefined ? true : kv['pwm2'] === 'ok',
    fields: kv,
  };
}

/** Parses the data of "OK get 1,3,9,0,0" into masks, or null if malformed. */
export function parseGet(data: string): number[] | null {
  const s = data.trim();
  if (!/^\d+(,\d+)*$/.test(s)) return null;
  const masks = s.split(',').map(Number);
  if (masks.length > MAX_CELLS || masks.some((m) => m > MAX_MASK)) return null;
  return padCells(masks);
}

export interface MotionInfo {
  moved?: number;
  ms?: number;
}

/** Parses "moved=7 ms=312" (also inside "2 moved=3 ms=150"). */
export function parseMotion(data: string): MotionInfo {
  const kv = parseKeyValues(data);
  const out: MotionInfo = {};
  const moved = toInt(kv['moved']);
  const ms = toInt(kv['ms']);
  if (moved !== undefined) out.moved = moved;
  if (ms !== undefined) out.ms = ms;
  return out;
}

/** Parses the data of "OK anim 300". */
export function parseAnim(data: string): number | null {
  const n = toInt(data.trim().split(/\s+/)[0]);
  return n === undefined ? null : n;
}

// ---------------------------------------------------------------------------
// Command builders (docs/PROTOCOL.md §4.1). Lines have no terminator; the
// transport appends "\n".
// ---------------------------------------------------------------------------

function checkMask(m: number, what = 'mask'): number {
  if (!Number.isInteger(m) || m < 0 || m > MAX_MASK) throw new RangeError(`Invalid ${what}: ${m}`);
  return m;
}

function checkCell(i: number): number {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_CELLS) throw new RangeError(`Invalid cell: ${i}`);
  return i;
}

/** Pads/validates to exactly MAX_CELLS masks (missing cells = blank). */
export function padCells(masks: readonly number[]): number[] {
  if (masks.length > MAX_CELLS) throw new RangeError(`At most ${MAX_CELLS} cells, got ${masks.length}`);
  const out = masks.map((m) => checkMask(m));
  while (out.length < MAX_CELLS) out.push(0);
  return out;
}

export const cmd = {
  hello: (): string => 'hello',
  ping: (): string => 'ping',
  get: (): string => 'get',
  refresh: (): string => 'refresh',
  sleep: (): string => 'sleep',
  /**
   * "show,5,21,30". Trailing blank cells are omitted because the firmware
   * clears every cell that is not given; an all-blank display is bare "show".
   */
  show(masks: readonly number[]): string {
    const cells = padCells(masks);
    let n = cells.length;
    while (n > 0 && cells[n - 1] === 0) n--;
    return n === 0 ? 'show' : `show,${cells.slice(0, n).join(',')}`;
  },
  cell: (i: number, mask: number): string => `cell,${checkCell(i)},${checkMask(mask)}`,
  clear: (i?: number): string => (i === undefined ? 'clear' : `clear,${checkCell(i)}`),
  anim(ms?: number): string {
    if (ms === undefined) return 'anim';
    // Firmware: 0 = normal speed, otherwise 20-2000 ("ERR range 0 or 20-2000").
    if (!Number.isInteger(ms) || (ms !== 0 && (ms < ANIM_MIN_MS || ms > ANIM_MAX_MS))) {
      throw new RangeError(`Invalid anim: ${ms}`);
    }
    return `anim,${ms}`;
  },
};

/** UTF-8 byte length (the firmware limits and counts bytes, not characters). */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Splits an optional request tag off a command line with the firmware's rule
 * (main.cpp handle_command): the last " #", followed by at least one
 * character and no further space. Returns the tag without "#".
 */
export function splitRequestTag(line: string): { body: string; tag?: string } {
  const t = line.trim();
  const h = t.lastIndexOf(' #');
  if (h >= 0 && h + 2 < t.length && t.indexOf(' ', h + 1) < 0) {
    return { body: t.slice(0, h).trim(), tag: t.slice(h + 2) };
  }
  return { body: t };
}

/**
 * Verb expected in the terminal "OK <verb>" for a command line, including the
 * legacy calibration commands (docs/PROTOCOL.md §4.2).
 */
export function expectedOkVerb(line: string): string {
  const trimmed = splitRequestTag(line).body;
  const comma = trimmed.indexOf(',');
  const verb = (comma < 0 ? trimmed : trimmed.slice(0, comma)).trim().toLowerCase();
  const args = comma < 0 ? '' : trimmed.slice(comma + 1).trim().toLowerCase();
  if (/^\d/.test(verb)) return 'servo';
  if (verb === 'all') return args;
  if (verb === 'space') return 'clear';
  if (verb === '?') return 'help';
  if (verb.length === 1 && /[a-z]/.test(verb) && comma < 0) return 'letter';
  return verb;
}

/** Stop-and-wait timeout for one command: 1500 + 30 * (anim_ms + 5) ms. */
export function commandTimeoutMs(animMs: number = DEFAULT_ANIM_MS): number {
  return 1500 + 30 * (animMs + 5);
}

export function sameCells(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
