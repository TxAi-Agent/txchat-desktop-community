import type { DictationSnapshot, Phase } from '../shared/contracts';

export const HUD_TRANSIENT_MS = 1500;
const active: Phase[] = ['starting', 'listening', 'finalizing', 'organizing', 'inserting'];
export type HUDState = Phase | 'cancelled' | 'no-speech';
export function hudState(state: DictationSnapshot): HUDState { return state.cancelled ? 'cancelled' : state.phase === 'completed' && state.completion === 'no-speech' ? 'no-speech' : state.phase; }
export function hudPresentation(state: DictationSnapshot, language: 'zh' | 'en', shortcut?: string) {
  let visual = hudState(state);
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const text: Record<HUDState, [string, string]> = {
    idle: [t('已就绪', 'Ready'), ''], unavailable: [t('需要设置', 'Setup Required'), t('请先完成必要设置', 'Complete setup first')],
    starting: [t('正在连接', 'Connecting'), t('正在连接 TxChat 云服务', 'Connecting to TxChat cloud service')],
    listening: [t('正在聆听', 'Listening'), shortcut ? t(`再按 ${shortcut} 结束聆听`, `Press ${shortcut} again to stop`) : t('再按快捷键结束聆听', 'Press shortcut again to stop')],
    finalizing: [t('正在整理', 'Formatting'), t('正在优化断句与表达', 'Refining punctuation and phrasing')],
    organizing: [t('正在整理', 'Formatting'), t('正在优化断句与表达', 'Refining punctuation and phrasing')],
    inserting: [t('正在写入', 'Writing'), t('正在写入原输入位置', 'Writing to the original input position')],
    resultFallback: [t('需要处理', 'Action Required'), t('文字已保留，请查看兜底窗口', 'Text kept — open the text window')],
    completed: [t('已完成', 'Done'), state.usedVerbatimFallback ? t('已使用逐字结果', 'Verbatim result used') : t('已写入 · 1.5 秒后收起', 'Written · Dismissing in 1.5s')],
    'no-speech': [t('未检测到语音', 'No Speech Detected'), t('未写入内容，可重新开始', 'Nothing was written. Try again')],
    cancelled: [t('已取消', 'Canceled'), t('未写入任何内容', 'Nothing was written')],
    failed: [t('暂时不可用', 'Temporarily Unavailable'), t('听写失败，请稍后重试', 'Dictation failed — please try again')],
  };
  if (visual === 'failed') {
    if (state.failure === 'BILLING_QUOTA_EXHAUSTED') text.failed = [t('默认服务时长已用完', 'Default Service Time Used Up'), t('请查看用量或使用自定义 AI', 'Check usage or use custom AI')];
    else if (state.failure === 'TARGET_UNAVAILABLE') {
      visual = 'unavailable'; text.unavailable = [t('暂时不可用', 'Temporarily Unavailable'), t('请先点击可输入文字的位置', 'Click on a text input field first')];
    } else if (state.failure === 'INPUT_DEVICE_CHANGED') {
      visual = 'unavailable'; text.unavailable = [t('输入设备已变化', 'Input Device Changed'), t('请打开 TxChat 检查麦克风', 'Open TxChat to check your mic')];
    }
  }
  const color = visual === 'no-speech' ? '#808080' : visual === 'completed' ? '#65b979' : ['listening', 'failed', 'unavailable'].includes(visual) ? '#e1736e'
    : ['inserting', 'resultFallback'].includes(visual) ? '#c99579' : '#d69450';
  return { visual, title: text[visual][0], detail: text[visual][1], color,
    canCancel: state.canCancel && ['starting', 'listening', 'finalizing', 'organizing'].includes(visual),
    cancelLabel: t('取消本次听写', 'Cancel this dictation') };
}

export function hudWaveform(visual: HUDState, level: number, reducedMotion: boolean, compact: boolean) {
  let heights: number[];
  if (visual === 'starting') heights = [4, 8, 6, 10, 7, 9, 5, 8, 4];
  else if (visual === 'finalizing' || visual === 'organizing') heights = [6, 10, 8, 14, 10, 12, 8, 10, 6];
  else if (visual === 'listening') {
    const weights = [.2558, .7673, .4476, 1.2148, .7673, 1.5345, .6394, 1.023, .3836];
    const gain = reducedMotion || !Number.isFinite(level) ? 0 : Math.min(1, Math.max(0, level));
    heights = [4, 6, 5, 7, 5, 6, 4, 6, 4].map((base, i) => Math.min(30, Math.max(4, base + gain * 23 * weights[i])));
  } else heights = [4, 7, 5, 9, 6, 8, 5, 7, 4];
  return { heights: compact ? [0, 2, 3, 5, 6, 8].map((i) => heights[i]) : heights,
    opacity: visual === 'starting' ? .58 : visual === 'finalizing' || visual === 'organizing' ? .68 : visual === 'listening' ? 1 : .55 };
}

/** A terminal snapshot may be republished by audio, language or permission updates.
 * Keep its original deadline, and never resurrect an already dismissed generation. */
export class HUDLifetime {
  private key: string | null = null;
  private timer: (() => void) | null = null;
  private visible = false;
  private disposed = false;
  constructor(private readonly display: (visible: boolean) => void,
    private readonly schedule: (callback: () => void, delay: number) => () => void = (callback, delay) => {
      const timer = setTimeout(callback, delay); return () => clearTimeout(timer);
    }) {}
  update(state: DictationSnapshot) {
    if (this.disposed) return;
    const visual = hudState(state), key = `${state.generation}:${visual}`;
    if (key === this.key) return;
    this.key = key; this.timer?.(); this.timer = null;
    const transient = ['completed', 'failed', 'cancelled', 'no-speech'].includes(visual);
    this.setVisible(active.includes(visual as Phase) || transient);
    if (transient) this.timer = this.schedule(() => {
      if (this.disposed || this.key !== key) return;
      this.timer = null; this.setVisible(false);
    }, HUD_TRANSIENT_MS);
  }
  private setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible; this.display(visible);
  }
  dispose() { this.disposed = true; this.timer?.(); this.timer = null; this.setVisible(false); }
}
