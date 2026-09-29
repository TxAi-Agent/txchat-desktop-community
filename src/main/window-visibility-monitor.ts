export class WindowVisibilityMonitor {
  private active: boolean;
  constructor(private readonly readActive: () => boolean, private readonly deactivate: () => void) {
    this.active = readActive();
  }
  poll() {
    const next = this.readActive();
    if (this.active && !next) this.deactivate();
    this.active = next;
  }
  markActive() { this.active = true; }
  markInactive() {
    if (this.active) this.deactivate();
    this.active = false;
  }
}
