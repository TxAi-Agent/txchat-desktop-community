import { randomUUID } from 'node:crypto';
import type { InputReason } from '../shared/native-input';
import type { NativeInputCoordinator } from './native-input';
import type { NativeHost } from './native-host';
import { parseShortcutBinding, shortcutNeedsLayoutLabel, type HotkeyBinding, type ShortcutDisplayLabel, type ShortcutPlatform } from '../shared/shortcut-bindings';
import { shortcutFromKey, type ShortcutEditorSnapshot, type ShortcutKeyInput, type NativeShortcutCaptureEvent, type ShortcutCandidate } from '../shared/shortcut-editor';

/** Owns editor lifetime and the native-register -> durable-save transaction. */
export class ShortcutEditorCoordinator {
  private state: ShortcutEditorSnapshot | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;
  private closeTask: Promise<void> | null = null;
  private restoreEnabled = false;
  private restorationAllowed = true;
  private captureTimer: ReturnType<typeof setTimeout> | undefined;
  private pressed = new Set<string>();
  private readonly unsubscribe: () => void;
  constructor(private readonly input: NativeInputCoordinator, private readonly native: NativeHost,
    private readonly platform: ShortcutPlatform, private readonly current: () => HotkeyBinding,
    private readonly persist: (binding: HotkeyBinding, label?: ShortcutDisplayLabel) => Promise<void>, private readonly publish: () => void,
    private readonly mayRestore: () => boolean, private readonly saved: () => void,
    private readonly restorationFailed: (reason: InputReason) => void,
    private readonly currentLabel: () => ShortcutDisplayLabel | undefined = () => undefined) {
    this.unsubscribe = native.subscribeShortcutCapture((event) => this.nativeCapture(event));
  }
  get active() { return this.state !== null || this.closing; }
  get snapshot(): ShortcutEditorSnapshot | null { return this.state ? { ...this.state } : null; }
  private serial(work: () => Promise<void>) {
    const task = this.queue.then(work); this.queue = task.catch(() => undefined); return task;
  }
  private change(change: Partial<ShortcutEditorSnapshot>) { if (this.state) { Object.assign(this.state, change); this.publish(); } }
  private isCurrent(id: string) { return this.state?.sessionId === id; }
  async open() {
    if (this.active) return;
    const id = randomUUID(); this.restorationAllowed = true; this.restoreEnabled = this.input.snapshot.status?.enabled === true;
    this.state = { sessionId: id, phase: 'current', current: this.current(), currentLabel: this.currentLabel(), candidate: null, display: null, error: null, busy: true, captureId: null };
    this.input.pauseForEditor(true); this.publish();
    await this.serial(async () => {
      const result = await this.input.configure(false);
      if (!this.isCurrent(id)) return;
      this.change({ busy: false, ...(result.ok ? {} : { phase: 'unavailable', error: result.reason }) });
    });
  }
  private async endCapture(id: string | null) {
    if (this.captureTimer) clearTimeout(this.captureTimer); this.captureTimer = undefined;
    this.pressed.clear();
    if (id && this.platform === 'darwin') await this.native.shortcutCapture(id, false).catch(() => undefined);
  }
  async capture(sessionId: string) {
    if (!this.isCurrent(sessionId) || this.state!.busy || this.state!.phase === 'waiting') return;
    const captureId = randomUUID();
    this.change({ busy: true, candidate: null, candidateLabel: undefined, display: null, error: null });
    await this.serial(async () => {
      // A failed save may have restored the old registration. Disable it again before capture.
      const result = await this.input.configure(false);
      if (!this.isCurrent(sessionId)) return;
      if (!result.ok) { this.change({ busy: false, phase: 'unavailable', error: result.reason }); return; }
      this.pressed.clear(); this.change({ phase: 'waiting', busy: false, captureId });
      this.captureTimer = setTimeout(() => {
        if (this.state?.captureId !== captureId) return;
        this.accept({ phase: 'unavailable', candidate: null, display: null, error: 'CAPTURE_EXPIRED' });
      }, 30_000);
      if (this.platform === 'darwin') {
        try { await this.native.shortcutCapture(captureId, true); }
        catch {
          // Ordinary physical keys remain recordable without Accessibility;
          // explicitly disclose that the native Fn path is unavailable.
          if (this.state?.captureId === captureId) this.change({ error: 'FN_CAPTURE_UNAVAILABLE' });
        }
        // Cancellation may arrive while native begin is in flight.
        if (this.state?.captureId !== captureId) await this.endCapture(captureId);
      }
    });
  }
  /** Called only by trusted main-window before-input-event while it is focused. */
  key(input: ShortcutKeyInput): boolean {
    if (!this.state) return false;
    if (input.isAutoRepeat) return true;
    if (input.type === 'keyDown' && input.code === 'Escape') { void this.close(); return true; }
    if (this.state.phase !== 'waiting') return false;
    if (this.state.busy) return true;
    if (input.type === 'keyUp') { this.pressed.delete(input.code); return true; }
    if (input.type === 'keyDown') this.pressed.add(input.code);
    const candidate = shortcutFromKey(input, this.platform, this.pressed.size);
    if (candidate && this.platform === 'darwin' && shortcutNeedsLayoutLabel(input.code)) {
      const captureId = this.state.captureId;
      const captured = { ...input, modifiers: input.modifiers ? [...input.modifiers] : undefined };
      const count = this.pressed.size;
      this.change({ busy: true });
      void this.serial(async () => {
        if (this.state?.captureId !== captureId || this.state.phase !== 'waiting') return;
        try {
          const label = await this.native.shortcutKeyLabel(captured.code, captured.shift);
          if (this.state?.captureId !== captureId || this.state.phase !== 'waiting') return;
          const resolved = shortcutFromKey({ ...captured, key: label }, this.platform, count);
          if (resolved) this.accept(resolved);
        } catch {
          if (this.state?.captureId === captureId && this.state.phase === 'waiting') {
            this.accept({ phase: 'unavailable', candidate: null, display: null, error: 'HOTKEY_UNAVAILABLE' });
          }
        }
      });
    } else if (candidate) this.accept(candidate);
    // Suppress menu accelerators and renderer text/navigation only during explicit capture.
    return true;
  }
  private accept(candidate: Omit<ShortcutCandidate, 'display'> & { display: string | null }) {
    if (!this.state || this.state.phase !== 'waiting') return;
    const id = this.state.captureId;
    this.change({ ...candidate, busy: false, captureId: null });
    void this.serial(() => this.endCapture(id));
  }
  private nativeCapture(event: NativeShortcutCaptureEvent) {
    if (this.state?.captureId !== event.captureId || this.state.phase !== 'waiting' || this.state.busy) return;
    this.accept(event.key === 'fn' ? { phase: 'captured', candidate: 'fn', display: 'Fn', error: null }
      : event.key === 'right-option' ? { phase: 'unsupported', candidate: null, display: 'Right Opt', error: 'UNSUPPORTED_BINDING' }
      : { phase: 'unavailable', candidate: null, display: event.key === 'fn-combination' ? 'Fn' : null,
        error: event.key === 'fn-combination' ? 'FN_COMBINATION' : 'HOTKEY_UNAVAILABLE' });
  }
  async save(sessionId: string) {
    const state = this.state;
    if (!state || state.sessionId !== sessionId || state.busy || !['captured', 'saveFailed'].includes(state.phase) || !state.candidate) return;
    const binding = state.candidate;
    if (!parseShortcutBinding(binding, this.platform)) { this.change({ phase: 'unsupported', error: 'UNSUPPORTED_BINDING' }); return; }
    this.change({ busy: true });
    await this.serial(async () => {
      if (!this.isCurrent(sessionId)) return;
      await this.endCapture(state.captureId);
      const registered = await this.input.configure(true, binding);
      if (!this.isCurrent(sessionId)) return; // queued close restores/disables after this attempt
      if (!registered.ok) {
        this.change({ busy: false, phase: registered.reason === 'HOTKEY_CONFLICT' ? 'conflict' : registered.reason === 'UNSUPPORTED_BINDING' ? 'unsupported' : 'unavailable', error: registered.reason }); return;
      }
      try { await this.persist(binding, state.candidateLabel); }
      catch {
        const rollback = await this.input.configure(this.restoreEnabled && this.mayRestore(), state.current);
        if (!rollback.ok) this.input.disable();
        if (this.isCurrent(sessionId)) this.change({ busy: false, phase: 'saveFailed', error: rollback.ok ? 'STORAGE_WRITE_FAILED' : 'SHORTCUT_ROLLBACK_FAILED' });
        return;
      }
      // Once the atomic settings write commits, cancellation must not restore stale settings.
      this.restoreEnabled = true; this.saved();
      if (!this.isCurrent(sessionId)) return;
      this.state = null; this.input.pauseForEditor(false); this.publish();
    });
  }
  close(restore = true) {
    if (!this.active) return Promise.resolve();
    if (!restore) this.restorationAllowed = false;
    if (this.closing) return this.closeTask ?? Promise.resolve();
    const captureId = this.state?.captureId ?? null;
    this.state = null; this.closing = true; this.publish();
    this.closeTask = this.serial(async () => {
      await this.endCapture(captureId);
      // Current durable preference may have changed in a save already in flight.
      const restored = await this.input.configure(this.restorationAllowed && this.restoreEnabled && this.mayRestore(), this.current());
      if (!restored.ok) { this.input.disable(); this.restorationFailed(restored.reason); }
      this.closing = false; this.closeTask = null; this.input.pauseForEditor(false); this.publish();
    });
    return this.closeTask;
  }
  dispose() { this.unsubscribe(); void this.close(false); }
}
