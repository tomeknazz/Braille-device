// Connection panel: USB (Web Serial) or simulator, status line, auto-reconnect
// to an already-granted port.

import type { DeviceLink, LinkState } from '../device/DeviceLink';
import { MockDevice } from '../device/MockDevice';
import { WebSerialDevice, isWebSerialSupported } from '../device/WebSerialDevice';

interface Elements {
  usb: HTMLButtonElement;
  mock: HTMLButtonElement;
  disconnect: HTMLButtonElement;
  status: HTMLElement;
  unsupported: HTMLElement;
}

function explainOpenError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotFoundError') return 'Nie wybrano portu.';
  if (name === 'InvalidStateError' || name === 'NetworkError') {
    return 'Nie udało się otworzyć portu. Zamknij inne programy, które go używają (monitor PlatformIO, Arduino IDE), i spróbuj ponownie.';
  }
  if (name === 'SecurityError') return 'Przeglądarka zablokowała dostęp do portu szeregowego.';
  return `Nie udało się połączyć: ${err instanceof Error ? err.message : String(err)}`;
}

export class ConnectionPanel {
  private busyConnecting = false;
  /** Set when the user pressed "Rozłącz": no auto-reconnect until they connect again. */
  private userDisconnected = false;

  constructor(
    private readonly link: DeviceLink,
    private readonly el: Elements,
  ) {
    const supported = isWebSerialSupported();
    el.unsupported.hidden = supported;
    el.usb.disabled = !supported;
    if (!supported) el.usb.setAttribute('aria-disabled', 'true');

    el.usb.addEventListener('click', () => void this.connectUsb());
    el.mock.addEventListener('click', () => this.connectMock());
    el.disconnect.addEventListener('click', () => void this.disconnect());
    link.on('state', (state, msg) => this.onState(state, msg));

    if (supported) {
      navigator.serial.addEventListener('connect', (e) => {
        const port = e.target as SerialPort;
        if (!this.userDisconnected && this.link.state === 'disconnected') void this.openPort(port, true);
      });
      void this.autoReconnect();
    }
  }

  private setStatus(text: string): void {
    this.el.status.textContent = text;
  }

  private onState(state: LinkState, message: string): void {
    this.setStatus(message);
    const attached = state !== 'disconnected';
    this.el.disconnect.hidden = !attached;
    this.el.usb.textContent = attached && this.link.transportKind === 'serial'
      ? 'Połącz ponownie (USB)'
      : 'Połącz z urządzeniem (USB)';
  }

  private async autoReconnect(): Promise<void> {
    try {
      const ports = await WebSerialDevice.grantedPorts();
      const first = ports[0];
      if (first && this.link.state === 'disconnected') await this.openPort(first, true);
    } catch {
      /* no granted ports or not allowed: user connects manually */
    }
  }

  private async connectUsb(): Promise<void> {
    if (this.busyConnecting) return;
    this.userDisconnected = false;
    this.busyConnecting = true;
    try {
      // requestPort() must run directly in the click handler (user gesture).
      const port = await WebSerialDevice.requestPort();
      await this.link.close(); // frees the port if the same one is already open
      this.setStatus('Otwieranie portu…');
      this.link.attach(await WebSerialDevice.open(port));
    } catch (err) {
      this.setStatus(explainOpenError(err));
    } finally {
      this.busyConnecting = false;
    }
  }

  private async openPort(port: SerialPort, auto: boolean): Promise<void> {
    if (this.busyConnecting) return;
    this.busyConnecting = true;
    try {
      if (auto) this.setStatus('Znaleziono wcześniej używane urządzenie — łączenie…');
      const dev = await WebSerialDevice.open(port);
      this.link.attach(dev);
    } catch (err) {
      this.setStatus(explainOpenError(err));
    } finally {
      this.busyConnecting = false;
    }
  }

  private connectMock(): void {
    this.userDisconnected = false;
    void this.link.close().then(() => this.link.attach(new MockDevice()));
  }

  private async disconnect(): Promise<void> {
    this.userDisconnected = true;
    await this.link.close();
    this.el.usb.focus();
  }
}
