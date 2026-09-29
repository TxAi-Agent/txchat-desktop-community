import type { DictationController, SessionPort, RecognitionPort } from '../domain/dictation';
import { createSimulatedSession } from '../adapters/simulated-session';
import { createNativeSession } from '../adapters/native-session';
import type { Scenario } from '../shared/contracts';
import type { HotkeyBinding, InputSnapshot, NativeHotkeyEvent, NativeInputStatus, InputReason } from '../shared/native-input';
import { INPUT_REASONS } from '../shared/native-input';
import type { NativeHost } from './native-host';

export const INPUT_MESSAGES: Partial<Record<InputReason, string>> = {
  PERMISSION_REQUIRED: '尚未获得系统权限，请明确授权后刷新状态。', HOTKEY_CONFLICT: '快捷键已被占用，原绑定保持不变。',
  HOTKEY_UNAVAILABLE: '快捷键已停止，请检查权限后重新启用。', UNSUPPORTED_BINDING: '当前系统不支持此快捷键。',
  OWN_APPLICATION: '当前目标属于 TxChat，请切换到其他应用的编辑框。', PROTECTED_TARGET: '不能向密码框或受保护窗口写入。',
  TARGET_UNAVAILABLE: '无法确认可编辑目标，本次未开始。', TARGET_CHANGED: '输入目标或选区已变化，结果已保留。',
  SELECTION_CHANGED: '选区已变化，结果已保留。', MODIFIERS_HELD: '修饰键尚未松开，本次没有写入。',
  CLIPBOARD_CHANGED: '剪贴板发生变化，本次没有写入。', TEXT_TOO_LONG: '文字超过本阶段的安全写入长度。',
  INPUT_BUSY: '系统输入暂不可用，请稍后重试。', CAPACITY_EXCEEDED: '辅助程序本次运行容量已满，请空闲时重新连接。',
  DELIVERY_UNCONFIRMED: '系统未提供可靠写入确认，请核对目标内容，不会自动重试。',
  PASTEBOARD_RESTORE_FAILED: '原剪贴板恢复未完成，请检查剪贴板内容。',
};
const inactive = (controller: DictationController) => ['idle', 'completed', 'failed', 'unavailable'].includes(controller.snapshot.phase);
export type InputConfigurationResult = { ok: true; status: NativeInputStatus | null } | { ok: false; reason: InputReason };

/** Binds opaque native targets to a single app-owned session; renderers never receive target tokens. */
export class NativeInputCoordinator {
  private state: InputSnapshot = { status: null, busy: false, notice: null };
  private currentMode: 'simulation' | 'native' = 'simulation';
  private generation = 0;
  private epoch = 0;
  private operation = 0;
  private disposed = false;
  private pendingDisable = false;
  private editorPaused = false;
  private reserved: { token: string | null; epoch: number } | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribe: () => void;
  constructor(private readonly host: NativeHost, private readonly controller: DictationController,
    private readonly ownPids: () => number[], private readonly publish: () => void,
    private readonly recognition?: () => RecognitionPort, private readonly interceptHotkey?: () => Promise<boolean>,
    private readonly insertionFailure?: (reason: InputReason) => void) {
    this.unsubscribe = host.subscribeInput((event) => { void this.onHotkey(event); });
  }
  get mode() { return this.currentMode; }
  pauseForEditor(paused: boolean) {
    this.editorPaused = paused; this.epoch++;
    if (this.reserved?.token) this.release(this.reserved.token);
    this.reserved = null;
  }
  get snapshot(): InputSnapshot { return { ...this.state, status: this.state.status ? { ...this.state.status } : null }; }
  private update(change: Partial<InputSnapshot>) {
    if (!this.disposed) { this.state = { ...this.state, ...change }; this.publish();
      if (!this.state.busy && this.pendingDisable) queueMicrotask(() => { if (this.pendingDisable && !this.state.busy && !this.disposed) { this.pendingDisable = false; void this.configure(false); } });
    }
  }
  disable() {
    if (this.disposed) return;
    this.pendingDisable = true; this.epoch++; this.currentMode = 'simulation';
    if (this.reserved?.token) this.release(this.reserved.token); this.reserved = null;
    this.update({ notice: null });
  }
  private release(token: string) { void this.host.releaseTarget(token).catch(() => undefined); }
  helperChanged(ready: boolean) {
    if (this.poll) clearInterval(this.poll); this.poll = undefined;
    if (!ready) {
      this.epoch++; this.operation++; this.reserved = null;
      this.update({ status: null, busy: false, notice: this.currentMode === 'native' ? '辅助程序已中断，重新连接后需手动启用快捷键。' : null });
    } else {
      void this.refresh();
      this.poll = setInterval(() => { if (this.currentMode === 'native') void this.refresh(true); }, 5000);
    }
  }
  createSession(scenario: Scenario): SessionPort {
    if (this.currentMode === 'simulation') return createSimulatedSession(scenario);
    const target = this.reserved; this.reserved = null;
    if (!target || target.epoch !== this.epoch || !this.state.status?.enabled) throw new Error('NATIVE_TARGET_REQUIRED');
    try { return createNativeSession(this.host, target.token,
      () => !this.disposed && this.epoch === target.epoch && this.currentMode === 'native' && this.state.status?.enabled === true,
      (result) => {
        if (result.reason) { try { this.insertionFailure?.(result.reason); } catch { /* Reporting cannot change insertion. */ } }
        if (result.warning) { try { this.insertionFailure?.(result.warning); } catch { /* Cleanup reporting cannot change delivery. */ } }
        this.update({ notice: result.reason ? INPUT_MESSAGES[result.reason] ?? '本次写入未完成，结果已保留。'
          : result.warning ? INPUT_MESSAGES[result.warning] : '系统输入调用已完成。' });
      }, this.recognition?.()); }
    catch (error) { if (target.token) this.release(target.token); throw error; }
  }
  private acceptStatus(status: NativeInputStatus) {
    this.generation = Math.max(this.generation, status.generation);
    if (this.currentMode === 'native' && this.state.status?.enabled && !status.enabled) {
      this.epoch++;
      this.controller.setAvailable(false); // Invalidates active tasks, preserving uncertain insertion.
      this.controller.setAvailable(this.host.snapshot.status === 'ready');
    }
    this.update({ status, error: status.reason, notice: status.reason ? INPUT_MESSAGES[status.reason] ?? '原生输入不可用。' : this.state.notice });
  }
  async refresh(quiet = false): Promise<boolean> {
    if (this.disposed || this.state.busy || this.host.snapshot.status !== 'ready') return false;
    const epoch = this.epoch; const operation = quiet ? this.operation : ++this.operation;
    if (!quiet) this.update({ busy: true });
    try {
      const status = await this.host.inputStatus();
      if (epoch !== this.epoch || this.disposed) return false;
      this.acceptStatus(status); return true;
    } catch { if (!quiet && epoch === this.epoch) this.update({ notice: '无法读取系统输入状态。' }); return false; }
    finally { if (!quiet && operation === this.operation) this.update({ busy: false }); }
  }
  async permissions() {
    if (this.disposed || this.state.busy || !inactive(this.controller) || this.host.snapshot.status !== 'ready') return;
    const epoch = this.epoch; const operation = ++this.operation; this.update({ busy: true });
    try { const status = await this.host.requestPermissions(); if (epoch === this.epoch) this.acceptStatus(status); }
    catch { if (epoch === this.epoch) this.update({ notice: '权限申请未完成，请从系统设置核对开发版权限。' }); }
    finally { if (operation === this.operation) this.update({ busy: false }); }
  }
  async configure(enabled: boolean, binding?: HotkeyBinding): Promise<InputConfigurationResult> {
    if (enabled && this.pendingDisable) return { ok: false, reason: 'CANCELLED' };
    if (this.disposed || this.state.busy || !inactive(this.controller)) return { ok: false, reason: 'INPUT_BUSY' };
    if (!enabled && this.host.snapshot.status !== 'ready') {
      this.currentMode = 'simulation'; this.epoch++; this.update({ status: null, notice: null }); return { ok: true, status: null };
    }
    if (this.host.snapshot.status !== 'ready') return { ok: false, reason: 'HOTKEY_UNAVAILABLE' };
    const epoch = this.epoch; const operation = ++this.operation;
    this.update({ busy: true, notice: null, error: null });
    const next = ++this.generation;
    try {
      const status = await this.host.configureInput({ enabled, binding: binding ?? this.state.status?.binding ?? 'ctrl-alt-space',
        generation: next, excludedPids: [...new Set(this.ownPids())].filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, 64) });
      if (epoch !== this.epoch) return { ok: false, reason: 'CANCELLED' };
      this.epoch++; this.reserved = null; this.currentMode = enabled ? 'native' : 'simulation';
      this.acceptStatus(status);
      this.update({ notice: enabled ? '已启用快捷键。切换到其他应用，按下组合键（Fn 单独松开）开始或结束听写。' : '已关闭快捷键。' });
      return { ok: true, status };
    } catch (error) {
      const code = INPUT_REASONS.includes((error as Error).message as InputReason) ? (error as Error).message as InputReason : 'HOTKEY_UNAVAILABLE';
      if (epoch === this.epoch) this.update({ error: code, notice: INPUT_MESSAGES[code] ?? '原生输入配置失败，原绑定保持不变。' });
      return { ok: false, reason: code };
    } finally { if (operation === this.operation) this.update({ busy: false }); }
  }
  private async onHotkey(event: NativeHotkeyEvent) {
    const discard = () => { if (event.targetId) this.release(event.targetId); };
    // The native hook can recover its reservation after a keyboard-layout or
    // NumLock change without changing the configured generation. A prior poll
    // may still describe the temporary disabled state. Re-read only this known
    // generation; never revive a manually disabled or replaced configuration.
    if (!this.disposed && !this.state.busy && this.currentMode === 'native' &&
        this.state.status?.enabled === false && event.generation === this.state.status.generation && event.phase === 'activated') {
      const epoch = this.epoch; await this.refresh(true);
      if (this.disposed || epoch !== this.epoch) { discard(); return; }
    }
    if (this.disposed || this.editorPaused || this.state.busy || this.currentMode !== 'native' || !this.state.status?.enabled ||
        event.generation !== this.state.status.generation) { discard(); return; }
    if (event.phase !== 'activated') { discard(); return; }
    const epoch = this.epoch;
    if (await this.interceptHotkey?.()) { discard(); return; }
    if (this.disposed || this.editorPaused || epoch !== this.epoch || this.state.busy || !this.state.status?.enabled || event.generation !== this.state.status.generation) { discard(); return; }
    if (this.controller.snapshot.phase === 'listening') { discard(); await this.controller.stop(); return; }
    if (!this.controller.snapshot.canStart) { discard(); return; }
    // An ordinary unavailable target still permits recognition with a retained result.
    // Protected/secure/changed targets never receive this fallback.
    if (!event.targetId && !['TARGET_UNAVAILABLE', 'OWN_APPLICATION'].includes(event.reason ?? '')) {
      this.update({ notice: INPUT_MESSAGES[event.reason ?? 'TARGET_UNAVAILABLE'] ?? '无法获取安全输入目标。' }); return;
    }
    const target = { token: event.targetId, epoch: this.epoch };
    this.reserved = target; this.update({ notice: null });
    await this.controller.start();
    if (this.reserved === target) { this.reserved = null; if (target.token) this.release(target.token); }
  }
  dispose() {
    this.disposed = true; this.unsubscribe(); if (this.poll) clearInterval(this.poll);
    if (this.reserved?.token) this.release(this.reserved.token); this.reserved = null;
  }
}
