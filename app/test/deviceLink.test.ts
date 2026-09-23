import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceLink, type CommandResult } from '../src/device/DeviceLink';
import { MockDevice, type MockDeviceOptions } from '../src/device/MockDevice';

const MOTION = /^(show|cell|clear|text|anim|refresh|sleep|min|max|all|\d)/;

/** Lines without the " #<seq>" request tag the link appends to every command. */
const untag = (lines: string[]) => lines.map((l) => l.replace(/ #\d+$/, ''));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Attaches to a mock that is already booted (no DTR reset) and waits for ready. */
async function connected(opts: MockDeviceOptions = {}) {
  const mock = new MockDevice({ resetOnOpen: false, ...opts });
  const link = new DeviceLink();
  link.attach(mock);
  await vi.advanceTimersByTimeAsync(50);
  expect(link.state).toBe('ready');
  return { mock, link };
}

describe('DeviceLink: hello gate', () => {
  it('retries hello through the reset, opens on OK hello and only then moves dots', async () => {
    const mock = new MockDevice({ resetOnOpen: true, bootMs: 1200 });
    const link = new DeviceLink();
    const states: string[] = [];
    link.on('state', (s) => states.push(s));

    link.attach(mock);
    const shown = link.show([5, 21, 30]); // "kot", requested before the handshake

    await vi.advanceTimersByTimeAsync(1100);
    // Hello at 0, 500 and 1000 ms, all lost while the ESP32 is still booting.
    expect(untag(mock.received)).toEqual(['hello', 'hello', 'hello']);
    expect(link.state).toBe('connecting');

    await vi.advanceTimersByTimeAsync(3000);
    expect(link.state).toBe('ready');
    expect(link.hello).toMatchObject({ proto: 1, cells: 5 });
    // EVT boot at 1200 ms triggered an immediate hello; then anim + state sync, then the show.
    expect(untag(mock.received)).toEqual(['hello', 'hello', 'hello', 'hello', 'anim', 'get', 'show,5,21,30']);

    const r = await shown;
    expect(r).toMatchObject({ status: 'ok', motion: { moved: 9 } }); // k2 + o3 + t4
    expect(mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(link.confirmed).toEqual([5, 21, 30, 0, 0]);
    expect(states).toEqual(['connecting', 'ready']);
  });

  it('never sends motion to old firmware: gives up after 3 s with a clear message', async () => {
    const mock = new MockDevice({ legacy: true, resetOnOpen: false });
    const link = new DeviceLink();
    let message = '';
    link.on('state', (_s, m) => (message = m));
    link.attach(mock);
    const shown = link.show([1]);

    await vi.advanceTimersByTimeAsync(3500);
    expect(link.state).toBe('no-response');
    expect(message).toMatch(/stary firmware/);
    expect(await shown).toEqual({ status: 'cancelled', reason: 'no-response' });
    expect(mock.received.every((l) => l === 'hello')).toBe(true);
    expect(mock.received.length).toBe(6); // 0, 500, ... 2500 ms
    expect(mock.cells).toEqual([0, 0, 0, 0, 0]);
  });

  it('rejects an unsupported protocol version', async () => {
    const mock = new MockDevice({ proto: 2, resetOnOpen: false });
    const link = new DeviceLink();
    link.attach(mock);
    const shown = link.show([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(link.state).toBe('incompatible');
    expect((await shown).status).toBe('cancelled');
    expect(mock.received.some((l) => MOTION.test(l))).toBe(false);
  });

  it('a device that boots late (after the window) is picked up by EVT boot', async () => {
    const mock = new MockDevice({ resetOnOpen: true, bootMs: 4000 });
    const link = new DeviceLink();
    link.attach(mock);
    await vi.advanceTimersByTimeAsync(3500);
    expect(link.state).toBe('no-response');
    await vi.advanceTimersByTimeAsync(600);
    expect(link.state).toBe('ready');
  });

  it('does not send commands when nothing is attached', async () => {
    const link = new DeviceLink();
    expect(await link.show([1])).toEqual({ status: 'cancelled', reason: 'not-connected' });
  });
});

describe('DeviceLink: stop-and-wait and coalescing', () => {
  it('keeps one command in flight and replaces a queued show with a newer one', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    const results: Record<string, CommandResult> = {};
    const track = (name: string, p: Promise<CommandResult>) => p.then((r) => (results[name] = r));

    track('a', link.show([1]));
    track('b', link.show([3]));
    track('c', link.show([9]));
    await vi.advanceTimersByTimeAsync(0);
    expect(untag(mock.received)).toEqual(['show,1']); // only one in flight
    expect(results['b']).toEqual({ status: 'superseded' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(untag(mock.received)).toEqual(['show,1', 'show,9']);
    expect(results['a']).toMatchObject({ status: 'ok' });
    expect(results['c']).toMatchObject({ status: 'ok' });
    expect(link.confirmed).toEqual([9, 0, 0, 0, 0]);
  });

  it('does not re-send a show identical to the current or in-flight state', async () => {
    const { mock, link } = await connected();
    const p = link.show([5, 21, 30]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).status).toBe('ok');
    mock.received.length = 0;

    expect(await link.show([5, 21, 30, 0, 0])).toEqual({ status: 'skipped' });
    expect(untag(mock.received)).toEqual([]);

    const first = link.show([47, 1, 3, 1]);
    const second = link.show([47, 1, 3, 1]); // same as the one in flight
    expect(await second).toEqual({ status: 'skipped' });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).status).toBe('ok');
    expect(untag(mock.received)).toEqual(['show,47,1,3,1']);
  });

  it('keeps a single pending show even with other commands queued in between', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    void link.show([1]); // in flight
    const b = link.show([3]); // pending
    void link.anim(0);
    const c = link.show([9]); // replaces B, stays after anim
    expect(await b).toEqual({ status: 'superseded' });
    await vi.advanceTimersByTimeAsync(2000);
    expect((await c).status).toBe('ok');
    expect(untag(mock.received)).toEqual(['show,1', 'anim,0', 'show,9']);
  });

  it('A in flight, B queued, then A again: B is dropped and nothing new is sent', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    const a = link.show([1]);
    const b = link.show([3]);
    const a2 = link.show([1]);
    expect(await b).toEqual({ status: 'superseded' });
    expect(await a2).toEqual({ status: 'skipped' });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await a).status).toBe('ok');
    expect(untag(mock.received)).toEqual(['show,1']);
    expect(mock.cells).toEqual([1, 0, 0, 0, 0]);
  });

  it('reports moved= from the diff (only changed dots move)', async () => {
    const { link } = await connected();
    const p1 = link.show([5, 21, 30]); // k o t: 2 + 3 + 4 dots
    await vi.advanceTimersByTimeAsync(1000);
    // Firmware apply_masks(): delay(step) only between real moves, then SETTLE_MS.
    expect(await p1).toMatchObject({ motion: { moved: 9, ms: (9 - 1) * 20 + 120 } });
    const p2 = link.show([5, 21, 31]); // t -> q adds dot 1 only
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p2).toMatchObject({ motion: { moved: 1 } });
  });

  it('propagates ERR replies (e.g. a missing PCA9685)', async () => {
    const { link } = await connected({ pwm2Ok: false });
    const p = link.show([1]);
    await vi.advanceTimersByTimeAsync(100);
    expect(await p).toMatchObject({ status: 'error', code: 'hw', detail: 'pwm2' });
    expect(link.confirmed).toEqual([0, 0, 0, 0, 0]);
  });

  it('asks for the step delay after hello (the port open may not reset the ESP32)', async () => {
    const mock = new MockDevice({ resetOnOpen: false });
    mock.stepMs = 500; // set earlier, e.g. from the console before a page reload
    const link = new DeviceLink();
    link.attach(mock);
    await vi.advanceTimersByTimeAsync(50);
    expect(link.state).toBe('ready');
    expect(link.animMs).toBe(500);
    expect(link.timeoutMs).toBe(1500 + 30 * 505);

    mock.reset('sw', 300); // EVT boot: the firmware is back at CASCADE_DELAY_MS
    await vi.advanceTimersByTimeAsync(301);
    expect(link.animMs).toBe(20);
    await vi.advanceTimersByTimeAsync(100);
    expect(link.state).toBe('ready');
    expect(link.animMs).toBe(20);
  });

  it('tracks anim and scales the timeout', async () => {
    const { link } = await connected();
    expect(link.timeoutMs).toBe(2250);
    const p = link.anim(300);
    await vi.advanceTimersByTimeAsync(10);
    expect(await p).toMatchObject({ status: 'ok' });
    expect(link.animMs).toBe(300);
    expect(link.timeoutMs).toBe(1500 + 30 * 305);
  });
});

describe('DeviceLink: timeouts and resync', () => {
  it('after a timeout sends get and adopts the real state', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    const confirmed: (number[] | null)[] = [];
    link.on('confirmed', (m) => confirmed.push(m));

    mock.dropNextReplies(1);
    const p = link.show([1, 3]);
    await vi.advanceTimersByTimeAsync(2249);
    expect(untag(mock.received)).toEqual(['show,1,3']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ status: 'timeout' });
    await vi.advanceTimersByTimeAsync(50);

    expect(untag(mock.received)).toEqual(['show,1,3', 'get']);
    expect(confirmed).toEqual([null, [1, 3, 0, 0, 0]]);
    expect(link.confirmed).toEqual([1, 3, 0, 0, 0]);
    // Desired already matches the device, so nothing is re-sent.
    await vi.advanceTimersByTimeAsync(1000);
    expect(untag(mock.received)).toEqual(['show,1,3', 'get']);
  });

  it('a late reply after the timeout is not mistaken for the get reply', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    mock.sent.length = 0;
    const confirmed: (number[] | null)[] = [];
    link.on('confirmed', (m) => confirmed.push(m));
    mock.latencyMs = 2400; // only the show reply is late
    const p = link.show([1]);
    await vi.advanceTimersByTimeAsync(0);
    mock.latencyMs = 2;
    await vi.advanceTimersByTimeAsync(2250);
    expect(await p).toEqual({ status: 'timeout' });
    expect(untag(mock.received)).toEqual(['show,1', 'get']);
    // The late "OK show" arrives while get is in flight; it must be ignored and
    // only the "OK get" reply may confirm the state.
    await vi.advanceTimersByTimeAsync(2500);
    expect(untag(mock.sent.filter((l) => l.startsWith('OK ')))).toEqual(['OK show moved=1 ms=120', 'OK get 1,0,0,0,0']);
    expect(confirmed).toEqual([null, [1, 0, 0, 0, 0]]);
    expect(link.state).toBe('ready');
    expect(untag(mock.received)).toEqual(['show,1', 'get']);
  });

  it('a late ERR from a timed-out command does not complete the resync get', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    mock.latencyMs = 2400; // only the ERR reply is late
    const p = link.command('show,64');
    await vi.advanceTimersByTimeAsync(0);
    mock.latencyMs = 2;
    await vi.advanceTimersByTimeAsync(2250);
    expect(await p).toEqual({ status: 'timeout' });
    const confirmed: (number[] | null)[] = [];
    link.on('confirmed', (m) => confirmed.push(m));
    await vi.advanceTimersByTimeAsync(2500);
    expect(mock.sent.some((l) => /^ERR range cell 0 0-63 #\d+$/.test(l))).toBe(true);
    expect(untag(mock.received)).toEqual(['show,64', 'get']);
    expect(confirmed).toEqual([[0, 0, 0, 0, 0]]);
    expect(link.confirmed).toEqual([0, 0, 0, 0, 0]);
    expect(link.state).toBe('ready');
  });

  it('if the resync get also times out, the handshake starts again', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    mock.dropNextReplies(2);
    void link.show([1]);
    await vi.advanceTimersByTimeAsync(2250); // show times out
    await vi.advanceTimersByTimeAsync(2250); // get times out
    expect(link.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(100);
    expect(link.state).toBe('ready');
    expect(untag(mock.received).slice(0, 5)).toEqual(['show,1', 'get', 'hello', 'anim', 'get']);
  });
});

describe('DeviceLink: events and keepalive', () => {
  it('sends ping every 60 s while idle', async () => {
    const { mock } = await connected();
    mock.received.length = 0;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(untag(mock.received)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(untag(mock.received)).toEqual(['ping']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(untag(mock.received)).toEqual(['ping', 'ping']);
  });

  it('re-handshakes after EVT boot and restores the desired display', async () => {
    const { mock, link } = await connected();
    void link.show([5, 21, 30]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.cells).toEqual([5, 21, 30, 0, 0]);

    mock.reset('brownout', 900); // display cleared, EVT boot after 900 ms
    await vi.advanceTimersByTimeAsync(950);
    expect(link.state).toBe('ready');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.cells).toEqual([5, 21, 30, 0, 0]);
    expect(link.confirmed).toEqual([5, 21, 30, 0, 0]);
  });

  it('EVT sleep marks the display as cleared', async () => {
    const { mock, link } = await connected();
    void link.show([1]);
    await vi.advanceTimersByTimeAsync(500);
    mock.autoSleep();
    expect(link.asleep).toBe(true);
    expect(link.confirmed).toEqual([0, 0, 0, 0, 0]);
    // The same text again must be sent (it is no longer on the device).
    void link.show([1]);
    await vi.advanceTimersByTimeAsync(500);
    expect(mock.cells).toEqual([1, 0, 0, 0, 0]);
    expect(link.asleep).toBe(false);
  });

  it('raw commands with unpredictable motion are followed by get', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    const p = link.command('a'); // legacy: letter A on all cells
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toMatchObject({ status: 'ok', reply: { verb: 'letter' } });
    expect(untag(mock.received)).toEqual(['a', 'get']);
    expect(link.confirmed).toEqual([1, 1, 1, 1, 1]);
    expect(link.desired).toEqual([1, 1, 1, 1, 1]);
  });

  it('a show typed in the console is resynced, so a later clear is not skipped', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    const p = link.command('show,1,2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ status: 'ok', reply: { verb: 'show' } });
    expect(untag(mock.received)).toEqual(['show,1,2', 'get']);
    expect(link.confirmed).toEqual([1, 2, 0, 0, 0]);

    const c = link.show([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await c).status).toBe('ok');
    expect(mock.cells).toEqual([0, 0, 0, 0, 0]);
  });

  it('a show typed in the console makes the projected state unknown until it completes', async () => {
    const { mock, link } = await connected();
    void link.command('show,x0102');
    const c = link.show([]); // must not be skipped against the stale blank state
    await vi.advanceTimersByTimeAsync(2000);
    expect((await c).status).toBe('ok');
    expect(mock.cells).toEqual([0, 0, 0, 0, 0]);
  });

  it('keeps a tag typed by the user and matches the reply by it', async () => {
    const { mock, link } = await connected();
    mock.received.length = 0;
    const p = link.command('ping #abc');
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toMatchObject({ status: 'ok', reply: { verb: 'ping', tag: 'abc' } });
    expect(mock.received).toEqual(['ping #abc']);
  });

  it('detach cancels pending work and clears the confirmed state', async () => {
    const { link } = await connected();
    const p = link.show([1]);
    link.detach();
    expect(await p).toEqual({ status: 'cancelled', reason: 'disconnected' });
    expect(link.state).toBe('disconnected');
    expect(link.confirmed).toBeNull();
  });
});
