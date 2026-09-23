// Protocol client on top of any LineTransport (docs/PROTOCOL.md §2, §4;
// docs/PROPOZYCJA.md §4 "Kolejka komend").
//
//  - Hello gate: nothing but `hello` is sent until "OK hello ... proto=1".
//    Opening the USB port resets the ESP32, so hello is retried every 500 ms
//    for up to 3 s; "EVT boot" restarts that window and triggers hello at once.
//  - Stop-and-wait: at most one command in flight. Every command after the
//    hello gate carries a " #<seq>" tag; a tagged reply only completes the
//    command it belongs to, so a late reply after a timeout is ignored.
//  - Coalescing: a newer `show` replaces a still-queued older one, and a
//    `show` identical to the state the display will have anyway is not sent.
//  - Timeout 1500 + 30 * (anim + 5) ms, then `get` to resync. If that `get`
//    also times out, the link falls back to the hello handshake.
//  - `ping` keepalive every 60 s while connected and idle.
//
// Timers are looked up on globalThis at call time so vi.useFakeTimers() works.

import {
  CMD_MAX_LEN,
  DEFAULT_ANIM_MS,
  PROTO_VERSION,
  byteLength,
  cmd,
  commandTimeoutMs,
  expectedOkVerb,
  padCells,
  parseAnim,
  parseGet,
  parseHello,
  parseLine,
  parseMotion,
  sameCells,
  splitRequestTag,
  type ErrLine,
  type EvtLine,
  type HelloInfo,
  type MotionInfo,
  type OkLine,
  type ParsedLine,
} from './protocol';
import { Emitter, type LineTransport, type Unsubscribe } from './transport';

export type LinkState =
  /** No transport attached. */
  | 'disconnected'
  /** Transport open, waiting for "OK hello ... proto=1". */
  | 'connecting'
  /** Handshake done; commands flow. */
  | 'ready'
  /** Device answered hello with an unsupported protocol version. */
  | 'incompatible'
  /** No valid hello reply within the window (old firmware or silent device). */
  | 'no-response';

export type CommandResult =
  | { status: 'ok'; reply: OkLine; motion: MotionInfo }
  | { status: 'error'; code: string; detail: string; reply?: ErrLine }
  | { status: 'timeout' }
  /** A newer `show` replaced this one before it was sent. */
  | { status: 'superseded' }
  /** Identical to the state the display already has (or is about to have). */
  | { status: 'skipped' }
  /** Link closed, device reset or handshake failed before a reply came. */
  | { status: 'cancelled'; reason: string };

export interface LogEntry {
  dir: 'in' | 'out';
  text: string;
  kind: ParsedLine['kind'] | 'cmd';
  time: number;
}

export interface DeviceLinkOptions {
  helloIntervalMs?: number;
  helloWindowMs?: number;
  pingIntervalMs?: number;
  /** Maximum number of queued (not yet sent) commands. */
  maxQueue?: number;
}

type LinkEvents = {
  state: [LinkState, string];
  /** Display state confirmed by the device (5 masks), or null when unknown. */
  confirmed: [number[] | null];
  /** true while a command is in flight or queued. */
  busy: [boolean];
  line: [LogEntry];
  event: [EvtLine];
};

type AfterGet = 'restore' | 'adopt';

interface Job {
  line: string;
  expect: string;
  kind: 'show' | 'command';
  target?: number[];
  afterGet?: AfterGet;
  /** Request tag (without "#") the terminal reply must echo; unset = untagged. */
  tag?: string;
  resolve: (r: CommandResult) => void;
}

/** Verbs whose effect on the display the client cannot predict -> resync with `get`. */
const UNPREDICTABLE_MOTION = new Set(['cell', 'clear', 'text', 'letter', 'min', 'max', 'refresh', 'sleep', 'servo']);

/** A job whose effect on the display is only known after a `get`. */
function isUnpredictable(j: Pick<Job, 'kind' | 'expect' | 'target'>): boolean {
  // A `show` typed in the debug console has no parsed target.
  if (j.expect === 'show') return !j.target;
  return UNPREDICTABLE_MOTION.has(j.expect);
}

export class DeviceLink {
  private readonly events = new Emitter<LinkEvents>();
  private readonly opts: Required<DeviceLinkOptions>;

  private transport: LineTransport | null = null;
  private unsubs: Unsubscribe[] = [];
  private _state: LinkState = 'disconnected';
  private _hello: HelloInfo | null = null;
  private _confirmed: number[] | null = null;
  private _desired: number[] | null = null;
  private _animMs = DEFAULT_ANIM_MS;
  private _asleep = false;

  private inflight: Job | null = null;
  private inflightTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Job[] = [];
  private lastBusy = false;

  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloElapsed = 0;
  private sawLegacyText = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  constructor(options: DeviceLinkOptions = {}) {
    this.opts = {
      helloIntervalMs: options.helloIntervalMs ?? 500,
      helloWindowMs: options.helloWindowMs ?? 3000,
      pingIntervalMs: options.pingIntervalMs ?? 60_000,
      maxQueue: options.maxQueue ?? 16,
    };
  }

  // --- Public API ----------------------------------------------------------

  get state(): LinkState {
    return this._state;
  }
  get hello(): HelloInfo | null {
    return this._hello;
  }
  /** Last display state confirmed by an OK reply; null = unknown. */
  get confirmed(): number[] | null {
    return this._confirmed ? [...this._confirmed] : null;
  }
  /** What the app last asked the display to show. */
  get desired(): number[] | null {
    return this._desired ? [...this._desired] : null;
  }
  get animMs(): number {
    return this._animMs;
  }
  get asleep(): boolean {
    return this._asleep;
  }
  get timeoutMs(): number {
    return commandTimeoutMs(this._animMs);
  }
  get busy(): boolean {
    return this.inflight !== null || this.queue.length > 0;
  }
  get transportKind(): LineTransport['kind'] | null {
    return this.transport?.kind ?? null;
  }

  on<K extends keyof LinkEvents>(event: K, handler: (...args: LinkEvents[K]) => void): Unsubscribe {
    return this.events.on(event, handler);
  }

  /** Takes over an open transport and starts the hello handshake. */
  attach(transport: LineTransport): void {
    if (this.transport) this.detach('Zmieniono połączenie.');
    this.transport = transport;
    this.unsubs = [
      transport.onLine((l) => this.handleLine(l)),
      transport.onClose(() => this.detach('Urządzenie zostało odłączone.')),
    ];
    this.startHandshake(`Łączenie (${transport.label})…`);
  }

  /** Forgets the transport (does not close it). Pending commands are cancelled. */
  detach(message = 'Rozłączono.'): void {
    if (!this.transport && this._state === 'disconnected') return;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.transport = null;
    this.stopTimers();
    this.cancelAll('disconnected');
    this._hello = null;
    this.setConfirmed(null);
    this.setState('disconnected', message);
  }

  /** Detaches and closes the transport. */
  async close(): Promise<void> {
    const t = this.transport;
    this.detach();
    if (t) await t.close();
  }

  /** Sets the whole display (up to 5 masks; missing cells are blank). */
  show(masks: readonly number[]): Promise<CommandResult> {
    const target = padCells(masks);
    this._desired = target;
    // Single pending slot: any still-queued show is replaced by this one.
    for (const old of this.queue.filter((j) => j.kind === 'show')) old.resolve({ status: 'superseded' });
    this.queue = this.queue.filter((j) => j.kind !== 'show');
    if (sameCells(this.projectedState(), target)) {
      this.emitBusy();
      return Promise.resolve({ status: 'skipped' });
    }
    return this.enqueue({ line: cmd.show(target), expect: 'show', kind: 'show', target });
  }

  /** Clears every cell (same as show with no cells). */
  clear(): Promise<CommandResult> {
    return this.show([]);
  }

  /** Sets the cascade step delay (0 = normal). */
  anim(ms?: number): Promise<CommandResult> {
    return this.command(cmd.anim(ms));
  }

  /**
   * Sends any protocol line (e.g. `get`, `anim,300`, or a calibration command
   * from the debug console). Commands that move dots in ways the client cannot
   * predict (including a hand-typed `show`) are followed by `get` so the
   * preview stays truthful. A tag typed by the user is kept and used for matching.
   */
  command(line: string): Promise<CommandResult> {
    const { body, tag } = splitRequestTag(line);
    const expect = expectedOkVerb(body);
    const job: Omit<Job, 'resolve'> = { line: body, expect, kind: 'command' };
    if (tag !== undefined) job.tag = tag;
    if (expect === 'get') job.afterGet = 'adopt';
    return this.enqueue(job);
  }

  // --- Queue -----------------------------------------------------------------

  private enqueue(job: Omit<Job, 'resolve'>, front = false): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      if (!this.transport || (this._state !== 'ready' && this._state !== 'connecting')) {
        resolve({ status: 'cancelled', reason: 'not-connected' });
        return;
      }
      if (this.queue.length >= this.opts.maxQueue) {
        resolve({ status: 'error', code: 'queue', detail: 'Za dużo komend w kolejce.' });
        return;
      }
      const full: Job = { ...job, resolve };
      if (front) this.queue.unshift(full);
      else this.queue.push(full);
      this.emitBusy();
      this.pump();
    });
  }

  /** State the display will have once everything sent/queued completes (null = unpredictable). */
  private projectedState(): number[] | null {
    const jobs = this.inflight ? [this.inflight, ...this.queue] : [...this.queue];
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i]!;
      if (j.kind === 'show') return j.target ?? null;
      if (isUnpredictable(j)) return null;
    }
    return this._confirmed;
  }

  private pump(): void {
    if (this._state !== 'ready' || this.inflight || !this.transport) return;
    const job = this.queue.shift();
    if (!job) {
      this.emitBusy();
      return;
    }
    this.inflight = job;
    this.inflightTimer = globalThis.setTimeout(() => this.onTimeout(job), this.timeoutMs);
    this.write(this.tagged(job)).catch((err: unknown) => {
      if (this.inflight === job) {
        this.finish(job, { status: 'error', code: 'io', detail: String(err) });
      }
    });
    this.emitBusy();
  }

  /** The wire line: the job's line plus its " #<tag>" (a fresh seq unless the user gave one). */
  private tagged(job: Job): string {
    if (job.tag === undefined) {
      const tag = String((this.seq = (this.seq % 999_999) + 1));
      // A tag must not push the line past the firmware limit; then send it untagged.
      if (byteLength(`${job.line} #${tag}`) > CMD_MAX_LEN) return job.line;
      job.tag = tag;
    }
    return `${job.line} #${job.tag}`;
  }

  /** Untagged terminal lines ("ERR range line too long") go to whatever is in flight. */
  private isForInflight(tag: string | undefined): boolean {
    return tag === undefined || tag === this.inflight?.tag;
  }

  private finish(job: Job, result: CommandResult, pumpNext = true): void {
    if (this.inflight !== job) return;
    if (this.inflightTimer) globalThis.clearTimeout(this.inflightTimer);
    this.inflightTimer = null;
    this.inflight = null;

    if (result.status === 'ok') this.applyOk(job, result.reply);
    job.resolve(result);
    if (pumpNext) this.pump();
    this.emitBusy();
  }

  private applyOk(job: Job, reply: OkLine): void {
    switch (job.expect) {
      case 'show':
        this._asleep = false;
        if (job.target) this.setConfirmed(job.target);
        else this.queueResync('adopt'); // hand-typed show: masks not parsed here
        break;
      case 'get': {
        const masks = parseGet(reply.data);
        if (!masks) break;
        this.setConfirmed(masks);
        if (job.afterGet === 'adopt') {
          this._desired = masks;
        } else if (
          this._desired &&
          !sameCells(this._desired, masks) &&
          !this.queue.some((j) => j.kind === 'show')
        ) {
          void this.enqueue({ line: cmd.show(this._desired), expect: 'show', kind: 'show', target: this._desired });
        }
        break;
      }
      case 'anim': {
        const ms = parseAnim(reply.data);
        if (ms !== null) this._animMs = ms;
        break;
      }
      default:
        if (isUnpredictable(job)) this.queueResync('adopt');
    }
  }

  private queueResync(afterGet: AfterGet): void {
    if (this.queue[0]?.expect === 'get') return;
    void this.enqueue({ line: cmd.get(), expect: 'get', kind: 'command', afterGet }, true);
  }

  private onTimeout(job: Job): void {
    if (this.inflight !== job) return;
    this.finish(job, { status: 'timeout' }, false);
    this.setConfirmed(null);
    if (job.expect === 'get') {
      // Even the state query went unanswered: start over with the handshake.
      this.startHandshake('Urządzenie nie odpowiada — ponowne łączenie…');
    } else {
      this.queueResync('restore'); // goes to the front of the queue and is sent now
    }
  }

  private cancelAll(reason: string): void {
    const jobs = this.inflight ? [this.inflight, ...this.queue] : [...this.queue];
    if (this.inflightTimer) globalThis.clearTimeout(this.inflightTimer);
    this.inflightTimer = null;
    this.inflight = null;
    this.queue = [];
    for (const j of jobs) j.resolve({ status: 'cancelled', reason });
    this.emitBusy();
  }

  // --- Handshake -----------------------------------------------------------

  private startHandshake(message: string): void {
    this.stopTimers();
    // Anything in flight is lost (the device is resetting or silent), but queued
    // work stays and is sent once the gate opens.
    if (this.inflightTimer) globalThis.clearTimeout(this.inflightTimer);
    this.inflightTimer = null;
    if (this.inflight) {
      const j = this.inflight;
      this.inflight = null;
      j.resolve({ status: 'cancelled', reason: 'reset' });
    }
    this._hello = null;
    this.sawLegacyText = false;
    this.setState('connecting', message);
    this.helloElapsed = 0;
    this.sendHello();
  }

  private sendHello(): void {
    if (this.helloTimer) globalThis.clearTimeout(this.helloTimer);
    this.write(cmd.hello()).catch(() => undefined);
    this.helloTimer = globalThis.setTimeout(() => {
      this.helloTimer = null;
      this.helloElapsed += this.opts.helloIntervalMs;
      if (this.helloElapsed >= this.opts.helloWindowMs) this.handshakeFailed();
      else this.sendHello();
    }, this.opts.helloIntervalMs);
  }

  private handshakeFailed(): void {
    this.cancelAll('no-response');
    this.setState(
      'no-response',
      this.sawLegacyText
        ? 'Urządzenie odpowiada, ale ma stary firmware bez protokołu v1. Wgraj firmware 0.4 — do tego czasu aplikacja nic nie rusza.'
        : 'Urządzenie nie odpowiada na „hello”. Sprawdź kabel, port i zasilanie, potem połącz ponownie.',
    );
  }

  private onHello(reply: OkLine): void {
    const info = parseHello(reply.data);
    if (!info) return;
    if (this.helloTimer) globalThis.clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this._hello = info;
    if (info.proto !== PROTO_VERSION) {
      this.cancelAll('incompatible');
      this.setState(
        'incompatible',
        `Urządzenie używa protokołu ${info.proto}, a aplikacja obsługuje protokół ${PROTO_VERSION}. Zaktualizuj firmware lub aplikację.`,
      );
      return;
    }
    let msg = `Połączono (${this.transport?.label ?? 'urządzenie'}, firmware ${info.fw}).`;
    if (!info.pwm1Ok || !info.pwm2Ok) {
      const bad = [!info.pwm1Ok && '#1 (0x40)', !info.pwm2Ok && '#2 (0x41)'].filter(Boolean).join(' i ');
      msg += ` Uwaga: moduł PWM ${bad} nie odpowiada — punkty nie będą się ruszać.`;
    }
    // Learn the real step delay and display state first (the port open does not
    // always reset the ESP32, so an earlier `anim` may still be active); queued
    // shows follow once the gate opens. Both go to the front: anim, then get.
    this.queueResync('restore');
    void this.enqueue({ line: cmd.anim(), expect: 'anim', kind: 'command' }, true);
    this.setState('ready', msg);
    this.startPing();
  }

  private startPing(): void {
    if (this.pingTimer) globalThis.clearInterval(this.pingTimer);
    this.pingTimer = globalThis.setInterval(() => {
      if (this._state === 'ready' && !this.busy) void this.command(cmd.ping());
    }, this.opts.pingIntervalMs);
  }

  private stopTimers(): void {
    if (this.helloTimer) globalThis.clearTimeout(this.helloTimer);
    if (this.pingTimer) globalThis.clearInterval(this.pingTimer);
    this.helloTimer = null;
    this.pingTimer = null;
  }

  // --- Incoming lines --------------------------------------------------------

  private handleLine(raw: string): void {
    const parsed = parseLine(raw);
    this.events.emit('line', { dir: 'in', text: raw, kind: parsed.kind, time: Date.now() });

    switch (parsed.kind) {
      case 'info':
        if (this._state === 'connecting' && /unknown command/i.test(parsed.raw)) this.sawLegacyText = true;
        return;
      case 'evt':
        this.onEvent(parsed);
        return;
      case 'ok':
        if (parsed.verb === 'hello' && this._state === 'connecting') {
          this.onHello(parsed);
          return;
        }
        if (this.inflight && parsed.verb === this.inflight.expect && this.isForInflight(parsed.tag)) {
          this.finish(this.inflight, { status: 'ok', reply: parsed, motion: parseMotion(parsed.data) });
        }
        // Otherwise: a duplicate hello reply or a late reply after a timeout. Ignore.
        return;
      case 'err':
        if (this.inflight && this._state === 'ready' && this.isForInflight(parsed.tag)) {
          this.finish(this.inflight, { status: 'error', code: parsed.code, detail: parsed.detail, reply: parsed });
        }
        return;
    }
  }

  private onEvent(evt: EvtLine): void {
    this.events.emit('event', evt);
    if (evt.name === 'boot') {
      // The device (re)started: its display is blank and it forgot our state
      // (step delay back to CASCADE_DELAY_MS).
      this.setConfirmed(null);
      this._animMs = DEFAULT_ANIM_MS;
      if (this._state === 'connecting') {
        this.helloElapsed = 0;
        this.sendHello();
      } else if (this.transport) {
        this.startHandshake('Urządzenie uruchomiło się ponownie — łączenie…');
      }
    } else if (evt.name === 'sleep') {
      this._asleep = true;
      this.setConfirmed([0, 0, 0, 0, 0]);
      if (this._state === 'ready') {
        this.setState('ready', 'Urządzenie uśpiło się po bezczynności. Następne wyświetlenie je obudzi.');
      }
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private async write(line: string): Promise<void> {
    const t = this.transport;
    if (!t) throw new Error('No transport');
    this.events.emit('line', { dir: 'out', text: line, kind: 'cmd', time: Date.now() });
    await t.writeLine(line);
  }

  private setState(state: LinkState, message: string): void {
    this._state = state;
    this.events.emit('state', state, message);
    if (state === 'ready') this.pump();
  }

  private setConfirmed(masks: number[] | null): void {
    this._confirmed = masks ? [...masks] : null;
    this.events.emit('confirmed', this.confirmed);
  }

  private emitBusy(): void {
    const b = this.busy;
    if (b !== this.lastBusy) {
      this.lastBusy = b;
      this.events.emit('busy', b);
    }
  }
}
