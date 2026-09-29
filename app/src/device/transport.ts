// Line-oriented transport between the app and the device. One call to
// writeLine() = one command; every received line is delivered without its
// terminator. USB serial now, WebSocket/BLE later: DeviceLink only sees this.

export type Unsubscribe = () => void;

export interface LineTransport {
  readonly kind: 'serial' | 'mock';
  /** Short human-readable name for status messages. */
  readonly label: string;
  /** Sends one line; the transport appends the "\n" terminator. */
  writeLine(line: string): Promise<void>;
  onLine(handler: (line: string) => void): Unsubscribe;
  /** Fires once when the link goes away (cable unplugged, port closed). */
  onClose(handler: (reason?: string) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Tiny typed event emitter shared by transports and DeviceLink. */
export class Emitter<Events extends Record<string, unknown[]>> {
  private handlers: { [K in keyof Events]?: Set<(...args: Events[K]) => void> } = {};

  on<K extends keyof Events>(event: K, handler: (...args: Events[K]) => void): Unsubscribe {
    const set = (this.handlers[event] ??= new Set());
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const h of [...(this.handlers[event] ?? [])]) {
      try {
        h(...args);
      } catch (err) {
        console.error(`Handler for "${String(event)}" failed`, err);
      }
    }
  }

  clear(): void {
    this.handlers = {};
  }
}
