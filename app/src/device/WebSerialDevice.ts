// USB serial transport via the Web Serial API (Chrome/Edge on desktop, secure
// context only). 115200 8N1, UTF-8 text, one command per "\n"-terminated line.

import { LineSplitter } from './protocol';
import { Emitter, type LineTransport, type Unsubscribe } from './transport';

export const BAUD_RATE = 115200;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && typeof window !== 'undefined' && window.isSecureContext;
}

function describePort(port: SerialPort): string {
  const info = port.getInfo();
  if (info.usbVendorId === undefined) return 'port szeregowy';
  const hex = (n: number) => n.toString(16).padStart(4, '0');
  const known: Record<number, string> = { 0x10c4: 'CP210x', 0x1a86: 'CH340', 0x0403: 'FTDI', 0x303a: 'Espressif' };
  const chip = known[info.usbVendorId];
  return `USB ${chip ?? hex(info.usbVendorId)}${info.usbProductId !== undefined ? ':' + hex(info.usbProductId) : ''}`;
}

export class WebSerialDevice implements LineTransport {
  readonly kind = 'serial' as const;
  readonly label: string;

  private readonly events = new Emitter<{ line: [string]; close: [string | undefined] }>();
  private readonly splitter = new LineSplitter();
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private readableClosed: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly encoder = new TextEncoder();
  private closing = false;
  private closed = false;
  private readonly onDisconnect = (e: Event) => {
    if ((e as Event & { target: SerialPort }).target === this.port) void this.shutdown('Urządzenie odłączone.');
  };

  private constructor(readonly port: SerialPort) {
    this.label = describePort(port);
  }

  /** Asks the user to pick a port. Must be called from a user gesture (click). */
  static requestPort(): Promise<SerialPort> {
    return navigator.serial.requestPort();
  }

  /** Ports this origin was already granted (for auto-reconnect without a prompt). */
  static async grantedPorts(): Promise<SerialPort[]> {
    if (!isWebSerialSupported()) return [];
    return navigator.serial.getPorts();
  }

  static async open(port: SerialPort): Promise<WebSerialDevice> {
    const dev = new WebSerialDevice(port);
    await port.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 1024 });
    navigator.serial.addEventListener('disconnect', dev.onDisconnect);
    dev.startReading();
    return dev;
  }

  async writeLine(line: string): Promise<void> {
    const data = this.encoder.encode(line + '\n');
    // Serialise writes: only one writer lock may exist at a time.
    const next = this.writeChain.then(async () => {
      if (this.closed || !this.port.writable) throw new Error('Port zamknięty');
      const writer = this.port.writable.getWriter();
      try {
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  onLine(handler: (line: string) => void): Unsubscribe {
    return this.events.on('line', handler);
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    return this.events.on('close', handler);
  }

  async close(): Promise<void> {
    await this.shutdown();
  }

  private startReading(): void {
    const readable = this.port.readable;
    if (!readable) throw new Error('Port nie ma strumienia do odczytu');
    const decoder = new TextDecoderStream();
    this.readableClosed = readable
      .pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>)
      .catch(() => undefined);
    this.reader = decoder.readable.getReader();
    void this.readLoop(this.reader);
  }

  private async readLoop(reader: ReadableStreamDefaultReader<string>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) for (const line of this.splitter.push(value)) this.events.emit('line', line);
      }
    } catch {
      // Read errors (device unplugged, framing/break errors) end the session.
    } finally {
      reader.releaseLock();
    }
    if (!this.closing) void this.shutdown('Połączenie przerwane.');
  }

  private async shutdown(reason?: string): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    navigator.serial.removeEventListener('disconnect', this.onDisconnect);
    // Order matters: cancel the reader and let the pipe finish, release the
    // writer (via the write chain), then close the port, or close() hangs.
    try {
      await this.reader?.cancel();
    } catch {
      /* already released */
    }
    await this.readableClosed;
    await this.writeChain;
    this.closed = true;
    try {
      await this.port.close();
    } catch {
      /* port already gone */
    }
    this.events.emit('close', reason);
    this.events.clear();
  }
}
