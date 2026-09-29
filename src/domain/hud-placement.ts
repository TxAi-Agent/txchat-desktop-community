import type { AppSnapshot } from '../shared/contracts';
import { shortcutDisplayName } from '../shared/shortcut-bindings';

export interface HUDRectangle { x: number; y: number; width: number; height: number }
export interface HUDPosition { x: number; y: number }
export function hudPosition(area: HUDRectangle): HUDPosition {
  return { x: Math.round(area.x + (area.width - 360) / 2), y: Math.round(area.y + area.height - 80 - 52) };
}

/** Placement never changes visibility or the terminal feedback deadline. Only one
 * async platform lookup is in flight; updates during it coalesce into one rerun. */
export class HUDPlacement {
  private visible = false;
  private disposed = false;
  private generation: number | null = null;
  private semanticKey: string | null = null;
  private epoch = 0;
  private inFlight = false;
  private dirty = false;
  constructor(private readonly resolve: () => HUDRectangle | null | Promise<HUDRectangle | null>,
    private readonly move: (position: HUDPosition) => void) {}

  observe(generation: number, semanticKey: string) {
    if (this.disposed) return;
    const changed = this.generation !== generation || this.semanticKey !== semanticKey;
    if (this.generation !== generation) { this.generation = generation; this.epoch++; }
    this.semanticKey = semanticKey;
    if (changed) this.refresh();
  }
  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible; this.epoch++;
    if (visible) this.refresh();
    else this.dirty = false;
  }
  refresh(invalidatePending = false) {
    if (this.disposed || !this.visible) return;
    if (invalidatePending) this.epoch++;
    if (this.inFlight) { this.dirty = true; return; }
    this.inFlight = true; this.dirty = false;
    const epoch = this.epoch;
    try {
      const result = this.resolve();
      if (result instanceof Promise) {
        void result.then((area) => this.apply(epoch, area)).catch(() => undefined).finally(() => this.finish());
      } else { this.apply(epoch, result); this.finish(); }
    } catch { this.finish(); }
  }
  private apply(epoch: number, area: HUDRectangle | null) {
    if (this.disposed || !this.visible || epoch !== this.epoch || !area) return;
    if (![area.x, area.y, area.width, area.height].every(Number.isFinite) || area.width <= 0 || area.height <= 0) return;
    this.move(hudPosition(area));
  }
  private finish() {
    this.inFlight = false;
    if (this.dirty) { this.dirty = false; this.refresh(); }
  }
  dispose() { this.disposed = true; this.visible = false; this.dirty = false; this.epoch++; }
}

/** Match the layout HUDSnapshot inputs, not unrelated product broadcasts. */
export function hudPlacementKey(snapshot: AppSnapshot): string {
  const state = snapshot.dictation, preferences = snapshot.product.preferences;
  return JSON.stringify([state.phase, state.partialText, state.resultText, state.cancelled, state.failure ?? null, state.canCancel,
    preferences.shortcut, shortcutDisplayName(preferences.shortcut, snapshot.platform, preferences.shortcutLabel),
    snapshot.audio.progress.level, state.usedVerbatimFallback, preferences.language]);
}
