import type { DictationController, RecognitionPort } from '../domain/dictation';
import type { NativeHost } from './native-host';
import type { AudioSnapshot, AudioSource, FixtureScenario, AudioProgress } from '../shared/native-audio';
import { createMicrophoneSession } from '../adapters/microphone-session';
import { createSimulatedSession } from '../adapters/simulated-session';

const MESSAGES: Record<string, string> = {
  AUDIO_PERMISSION_REQUIRED: '麦克风权限未获得，请显式申请后刷新状态。', AUDIO_DEVICE_UNAVAILABLE: '无法使用当前麦克风。',
  AUDIO_OVERFLOW: '音频消费过慢，本次录音已停止，缓冲数据已丢弃。', AUDIO_INTERRUPTED: '录音设备或音频通道已中断。',
  INPUT_DEVICE_CHANGED: '输入设备已变化，请打开 TxChat 检查麦克风。',
  AUDIO_FORMAT_UNSUPPORTED: '当前麦克风格式暂不支持。', UPSTREAM_UNAVAILABLE: '本地替身连接失败或已断开。',
  PROTOCOL_ERROR: '本地替身返回了无效数据，本次结果不会写入。', FINAL_TIMEOUT: '等待本地替身结果超时。',
};
export class AudioInputCoordinator {
  private state: AudioSnapshot = { source: 'synthetic', scenario: 'success', status: null, busy: false, notice: null,
    progress: { active: false, frames: 0, samples: 0, level: 0 } };
  private epoch = 0;
  private disposed = false;
  constructor(private readonly host: NativeHost, private readonly controller: DictationController,
    private readonly nativeMode: () => boolean, private readonly publish: () => void) {}
  get snapshot(): AudioSnapshot { return { ...this.state, status: this.state.status ? { ...this.state.status } : null, progress: { ...this.state.progress } }; }
  productFailure(reason: string) {
    if (reason !== 'AUDIO_PERMISSION_REQUIRED') return;
    // Invalidate an in-flight status read taken before the actual denial.
    this.epoch++; this.stopPermissionPoll();
    this.update({ busy: false, status: { permission: 'denied', active: false, reason: 'AUDIO_PERMISSION_REQUIRED' }, notice: MESSAGES[reason] });
  }
  productProgress(progress: AudioProgress) { this.update({ progress }); }
  private idle() { return !this.disposed && ['idle', 'completed', 'failed', 'unavailable'].includes(this.controller.snapshot.phase); }
  private update(change: Partial<AudioSnapshot>) { if (!this.disposed) { this.state = { ...this.state, ...change }; this.publish(); } }
  private permissionPoll: ReturnType<typeof setInterval> | undefined;
  private stopPermissionPoll() { if (this.permissionPoll) clearInterval(this.permissionPoll); this.permissionPoll = undefined; }
  private watchPermission() {
    this.stopPermissionPoll();
    this.permissionPoll = setInterval(() => { void this.refresh(false); }, 1000);
  }
  helperChanged(ready: boolean) {
    this.stopPermissionPoll();
    this.epoch++;
    if (!ready) this.update({ source: 'synthetic', status: null, busy: false, progress: { ...this.state.progress, active: false, level: 0 } });
    else void this.refresh(false);
  }
  select(source: AudioSource) {
    if (!this.idle() || this.state.busy || (source === 'microphone-local' && !this.nativeMode())) return;
    this.update({ source, notice: source === 'microphone-local' ? '将采集真实麦克风，仅在当前进程内处理；返回固定文字，不是识别结果。' : null });
  }
  scenario(scenario: FixtureScenario) { if (this.idle() && !this.state.busy) this.update({ scenario }); }
  async refresh(request: boolean): Promise<boolean> {
    if (this.disposed || this.state.busy || (request && !this.idle()) || this.host.snapshot.status !== 'ready') return false;
    const epoch = this.epoch; this.update({ busy: true });
    try {
      const status = request ? await this.host.requestAudioPermission() : await this.host.getAudioStatus();
      if (epoch === this.epoch) {
        if (request && status.permission === 'notDetermined') this.watchPermission();
        else if (status.permission !== 'notDetermined') this.stopPermissionPoll();
        const restored = status.permission === 'granted' && status.reason !== 'AUDIO_PERMISSION_REQUIRED';
        this.update({ status, notice: restored && this.state.notice === MESSAGES.AUDIO_PERMISSION_REQUIRED ? null : status.permission === 'systemManaged' ? 'Windows 麦克风由系统隐私设置控制，设备启动时会检查可用性。' : this.state.notice });
        return true;
      }
      return false;
    } catch { if (epoch === this.epoch) this.update({ notice: '无法读取麦克风权限状态。' }); return false; }
    finally { if (epoch === this.epoch) this.update({ busy: false }); }
  }
  createRecognition(): RecognitionPort {
    if (this.state.source === 'synthetic') return createSimulatedSession('success');
    if (!this.nativeMode() || this.state.busy) throw new Error('AUDIO_INVALID_STATE');
    const epoch = this.epoch;
    this.update({ notice: null, progress: { active: false, frames: 0, samples: 0, level: 0 } });
    return createMicrophoneSession(this.host, this.state.scenario,
      (progress) => { if (epoch === this.epoch) this.update({ progress }); },
      (error) => { if (epoch === this.epoch) this.update({ notice: MESSAGES[error.message] ?? '音频或模拟识别失败，已停止当前任务。' }); });
  }
  dispose() { this.stopPermissionPoll(); this.disposed = true; this.epoch++; }
}
