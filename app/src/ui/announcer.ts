// Polite live-region announcer. Re-announces identical messages by clearing
// the region first (screen readers ignore unchanged text).

export class Announcer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly region: HTMLElement) {}

  announce(message: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.region.textContent = '';
    this.timer = setTimeout(() => {
      this.region.textContent = message;
      this.timer = null;
    }, 60);
  }
}
