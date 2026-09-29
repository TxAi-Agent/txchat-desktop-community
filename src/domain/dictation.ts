import { dictationFailureCode } from '../shared/dictation-failure';
import type { DictationSnapshot, Phase, Scenario } from '../shared/contracts';

export type InsertionOutcome = 'inserted' | 'submitted' | 'notInserted' | 'partialOrUnknown';
export interface SessionEvents { failed(error?: unknown): void; ended(): void }
export type RecognitionPort = Pick<SessionPort, 'start' | 'finish' | 'dispose'>;
export interface SessionPort {
  start(onPartial: (text: string) => void, signal: AbortSignal, events?: SessionEvents): Promise<void>;
  finish(onOrganizing: () => void, signal: AbortSignal): Promise<string>;
  insert(text: string, operationId: string, signal: AbortSignal): Promise<InsertionOutcome>;
  dispose(): void;
}
interface ActiveSession { generation: number; id: string; port: SessionPort; abort: AbortController }
const STARTABLE: Phase[] = ['idle', 'completed', 'failed', 'unavailable'];
const CANCELLABLE: Phase[] = ['starting', 'listening', 'finalizing', 'organizing'];
const MAX_TEXT = 32_768;
/** Owns task lifetime independently of any window or UI subscription. */
export class DictationController {
  private state: DictationSnapshot = {
    revision: 0, phase: 'idle', generation: 0, sessionId: null, partialText: '', resultText: '',
    notice: null, scenario: 'success', canStart: true, canStop: false, canCancel: false,
    cancelled: false, usedVerbatimFallback: false,
  };
  private active: ActiveSession | null = null;
  private available = true;
  private disposed = false;
  private listeners = new Set<(snapshot: DictationSnapshot) => void>();

  constructor(private readonly createSession: (scenario: Scenario) => SessionPort,
    private readonly onFailure?: (stage: 'capture_start' | 'audio_pump' | 'stream_finish' | 'event_delivery', error: unknown) => void) {}
  private reportFailure(stage: 'capture_start' | 'audio_pump' | 'stream_finish' | 'event_delivery', error: unknown) {
    // Diagnostics cannot change task cleanup or expose raw errors in the public snapshot.
    try { this.onFailure?.(stage, error); } catch { /* Diagnostic failure is separate from dictation. */ }
  }

  get snapshot(): DictationSnapshot {
    return { ...this.state, canStart: !this.disposed && this.available && !this.active && STARTABLE.includes(this.state.phase),
      canStop: this.state.phase === 'listening', canCancel: CANCELLABLE.includes(this.state.phase) };
  }
  subscribe(listener: (snapshot: DictationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private update(change: Partial<DictationSnapshot>) {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private current(session: ActiveSession) { return !this.disposed && this.active === session && !session.abort.signal.aborted; }
  private release() {
    const old = this.active;
    this.active = null;
    if (old) { old.abort.abort(); old.port.dispose(); }
  }
  async start(): Promise<void> {
    if (!this.snapshot.canStart) return;
    const generation = this.state.generation + 1;
    this.update({ phase: 'starting', generation, sessionId: `session-${generation}`, partialText: '', resultText: '', notice: null,
      cancelled: false, usedVerbatimFallback: false, failure: null, completion: null });
    try {
      const session: ActiveSession = { generation, id: `session-${generation}`, port: this.createSession(this.state.scenario), abort: new AbortController() };
      this.active = session;
      let endedDuringStart = false;
      await session.port.start((partialText) => {
        if (this.current(session) && ['starting', 'listening'].includes(this.state.phase) && partialText.length <= MAX_TEXT) this.update({ partialText });
      }, session.abort.signal, {
        failed: (error) => {
          if (!this.current(session) || !['starting', 'listening', 'finalizing', 'organizing'].includes(this.state.phase)) return;
          if (this.completeNoSpeech(error)) return;
          this.reportFailure(this.state.phase === 'starting' ? 'capture_start' : 'audio_pump', error);
          this.release(); this.update({ phase: 'failed', partialText: '', failure: dictationFailureCode(error), notice: '采集或服务中断，本次任务已结束，没有继续写入。' });
        },
        ended: () => {
          if (!this.current(session)) return;
          if (this.state.phase === 'starting') endedDuringStart = true;
          else if (this.state.phase === 'listening') void this.stop();
        },
      });
      if (this.current(session)) { this.update({ phase: 'listening' }); if (endedDuringStart) void this.stop(); }
    } catch (error) {
      if (!this.disposed && this.state.generation === generation && this.state.phase === 'starting') {
        this.reportFailure('capture_start', error);
        this.release(); this.update({ phase: 'failed', failure: dictationFailureCode(error), notice: '任务启动失败，请重试。' });
      }
    }
  }
  async stop(): Promise<void> {
    const session = this.active;
    if (!session || this.state.phase !== 'listening') return;
    this.update({ phase: 'finalizing' });
    try {
      const text = await session.port.finish(() => {
        if (this.current(session) && this.state.phase === 'finalizing') this.update({ phase: 'organizing' });
      }, session.abort.signal);
      if (!this.current(session)) return;
      if (!text.trim() || text.length > MAX_TEXT) throw new Error('INVALID_FINAL');
      this.update({ phase: 'inserting', resultText: text, partialText: '' });
      const outcome = await session.port.insert(text, `${session.id}-write-1`, session.abort.signal);
      if (!this.current(session)) return;
      this.release();
      this.update(outcome === 'inserted' || outcome === 'submitted' ? { phase: 'completed', notice: outcome === 'submitted' ? '已向原输入目标发送粘贴。' : '流程已完成。' } :
        { phase: 'resultFallback', notice: outcome === 'notInserted' ? '目标已变化或不可写入。结果已保留。' : '可能已写入部分内容，请先核对。不会自动重试。' });
    } catch (error) {
      if (!this.current(session)) return;
      if (this.completeNoSpeech(error)) return;
      const uncertain = this.snapshot.phase === 'inserting';
      this.reportFailure(uncertain ? 'event_delivery' : 'stream_finish', error);
      this.release();
      this.update({ phase: uncertain ? 'resultFallback' : 'failed', failure: uncertain ? null : dictationFailureCode(error),
        notice: uncertain ? '写入结果未知，可能已产生部分内容。不会自动重试。' : '处理失败，任务已结束。可重新开始。' });
    }
  }
  private completeNoSpeech(error: unknown): boolean {
    if (!(error instanceof Error) || error.message !== 'NO_SPEECH' || this.state.phase !== 'finalizing' ||
        this.state.partialText || this.state.resultText) return false;
    this.release();
    this.update({ phase: 'completed', partialText: '', resultText: '', notice: 'NO_SPEECH',
      completion: 'no-speech', failure: null, cancelled: false, usedVerbatimFallback: false });
    return true;
  }
  cancel() {
    if (!this.snapshot.canCancel) return;
    this.release();
    this.update({ phase: this.available ? 'idle' : 'unavailable', generation: this.state.generation + 1,
      sessionId: null, partialText: '', resultText: '', notice: '已取消，迟到结果不会写入。', cancelled: true, usedVerbatimFallback: false, failure: null, completion: null });
  }
  markVerbatimFallback() {
    if (this.active && ['finalizing', 'organizing'].includes(this.state.phase)) this.update({ usedVerbatimFallback: true });
  }
  dismiss() {
    if (this.active || this.disposed || !this.state.cancelled && !['completed', 'resultFallback', 'failed'].includes(this.state.phase)) return;
    this.update({ phase: this.available ? 'idle' : 'unavailable', sessionId: null, partialText: '', resultText: '', notice: null,
      cancelled: false, usedVerbatimFallback: false, failure: null, completion: null });
  }
  selectScenario(scenario: Scenario) {
    if (!this.active && !this.disposed && this.state.phase !== 'resultFallback') this.update({ scenario });
  }
  setAvailable(available: boolean) {
    if (this.disposed || this.available === available) return;
    this.available = available;
    if (!available && this.active) {
      const uncertain = this.state.phase === 'inserting';
      this.release();
      this.update({ generation: this.state.generation + 1, phase: uncertain ? 'resultFallback' : 'failed', partialText: '', failure: null, completion: null,
        notice: uncertain ? '辅助程序中断，可能已写入部分内容。不会自动重试。' : '辅助程序不可用，当前任务已停止。' });
    } else this.update({ phase: !available && this.state.phase === 'idle' ? 'unavailable' :
      available && this.state.phase === 'unavailable' ? 'idle' : this.state.phase });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.release(); this.listeners.clear();
    this.state = { ...this.state, phase: 'unavailable', partialText: '', resultText: '', sessionId: null };
  }
}
