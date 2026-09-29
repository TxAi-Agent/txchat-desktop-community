import { randomUUID } from 'node:crypto';
import { DIAGNOSTIC_RETENTION_MS, parseDiagnosticEnvironment, parseDiagnosticEnvelope, parseDiagnosticEvent, parseDiagnosticIncident, parseDiagnosticReceipt, type DiagnosticCode, type DiagnosticEnvelope, type DiagnosticEnvironment, type DiagnosticIncident, type DiagnosticState } from '../shared/diagnostics';
import { DiagnosticStoreError, type DiagnosticStore } from './diagnostic-store';

export interface DiagnosticRuntimeOptions {
  store: DiagnosticStore;
  snapshot: () => DiagnosticEnvironment | Promise<DiagnosticEnvironment>;
  service: { submit(envelope: DiagnosticEnvelope, signal: AbortSignal): Promise<unknown> };
  now?: () => number;
  reportId?: () => string;
}
interface PendingIncident { incident: DiagnosticIncident; occurredAt: string }
const clone = <T>(value: T): T => structuredClone(value);
/** Owns consent and its immutable snapshot; exposes only a small presentation state. */
export class DiagnosticRuntime {
  private current: PendingIncident | null = null;
  private queued: PendingIncident | null = null;
  private phase: DiagnosticState['phase'] = 'idle';
  private number: string | null = null;
  private envelope: DiagnosticEnvelope | null = null;
  private listeners = new Set<(state: DiagnosticState) => void>();
  private initialization: Promise<void> | null = null;
  private termination: Promise<void> | null = null;
  private active: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private abort: AbortController | null = null;
  private discarding = false;
  private terminating = false;
  private windowsSessionEnded = false;
  private disposed = false;
  private launchReady = false;
  private readonly now: () => number;
  constructor(private readonly options: DiagnosticRuntimeOptions) { this.now = options.now ?? Date.now; }
  get snapshot(): DiagnosticState {
    return { phase: this.phase, isAbnormalExit: this.current?.incident.code === 'ABNORMAL_EXIT', reportId: this.envelope?.reportId ?? null, diagnosticNumber: this.number };
  }
  subscribe(listener: (state: DiagnosticState) => void): () => void {
    this.listeners.add(listener); listener(this.snapshot); return () => this.listeners.delete(listener);
  }
  private emit() { if (!this.disposed) for (const listener of this.listeners) { try { listener(this.snapshot); } catch { /* A presentation failure must not change consent or persistence. */ } } }
  initialize(): Promise<void> {
    if (this.disposed || this.terminating) return Promise.resolve();
    if (!this.initialization) this.initialization = this.prepare();
    return this.initialization;
  }
  private async prepare() {
    try { await this.options.store.purgeOnLaunch(); this.launchReady = true; }
    catch { this.localFailure('LOCAL_STATE_DELETE_FAILED'); }
    if (this.terminating || this.disposed) return;
    try { if (await this.options.store.beginRun()) await this.record({ category: 'application', stage: 'lifecycle', code: 'ABNORMAL_EXIT' }); }
    catch (error) { this.storeFailure(error, 'LOCAL_STATE_READ_FAILED'); }
  }
  private localFailure(code: DiagnosticCode) {
    // A failed event write must not recursively write another event.
    if (!this.terminating && !this.disposed) this.enqueue({ incident: { category: 'application', stage: 'lifecycle', code }, occurredAt: new Date(this.now()).toISOString() });
  }
  private storeFailure(error: unknown, fallback: DiagnosticCode) {
    this.localFailure(error instanceof DiagnosticStoreError ? ({ read: 'LOCAL_STATE_READ_FAILED', write: 'LOCAL_STATE_WRITE_FAILED', delete: 'LOCAL_STATE_DELETE_FAILED' } as const)[error.operation] : fallback);
  }
  private enqueue(value: PendingIncident) {
    if (!this.current) { this.current = value; this.phase = 'prompt'; this.emit(); }
    else if (!this.queued) this.queued = value;
  }
  record(incident: DiagnosticIncident, metadata: { occurredAt?: number; durationMs?: number; httpStatus?: number } = {}): Promise<void> {
    if (this.terminating || this.disposed) return Promise.resolve();
    // Explicitly reject extra keys, including accidental Error/provider-response spreading.
    const validated = parseDiagnosticIncident(incident);
    const event = parseDiagnosticEvent({ ...validated, occurredAt: new Date(metadata.occurredAt ?? this.now()).toISOString(), ...(metadata.durationMs === undefined ? {} : { durationMs: metadata.durationMs }), ...(metadata.httpStatus === undefined ? {} : { httpStatus: metadata.httpStatus }) });
    this.enqueue({ incident: validated, occurredAt: event.occurredAt });
    this.writes = this.writes.then(() => this.options.store.append(event)).catch((error: unknown) => this.storeFailure(error, 'LOCAL_STATE_WRITE_FAILED'));
    return this.writes;
  }
  send(): Promise<void> {
    if (this.phase !== 'prompt' || !this.current || this.discarding || this.active || this.terminating || this.disposed) return Promise.resolve();
    const current = clone(this.current), confirmedAt = this.now();
    if (Date.parse(current.occurredAt) < confirmedAt - DIAGNOSTIC_RETENTION_MS) { this.finish(); return Promise.resolve(); }
    this.phase = 'sending'; this.abort = new AbortController(); this.emit();
    return this.run(async (signal) => {
      if (!this.launchReady) throw new Error('DIAGNOSTIC_LAUNCH_PURGE_FAILED');
      // Freeze consent time and environment before awaiting the event queue.
      const environment = parseDiagnosticEnvironment(await this.options.snapshot());
      if (signal.aborted) return;
      await this.writes;
      if (signal.aborted) return;
      const events = await this.options.store.recent(confirmedAt);
      if (signal.aborted) return;
      this.envelope = parseDiagnosticEnvelope({ ...environment, schemaVersion: 1, reportId: (this.options.reportId ?? randomUUID)(), consent: { promptVersion: 1, confirmedAt: new Date(confirmedAt).toISOString() }, occurredAt: current.occurredAt, incident: current.incident, events }, this.now());
      // Retain this frozen envelope even when persistence fails. Retry never rebuilds it.
      await this.options.store.saveIfAbsent(clone(this.envelope));
      if (!signal.aborted) await this.submit(signal);
    });
  }
  retry(): Promise<void> {
    if (this.phase !== 'failed' || this.discarding || this.active || this.terminating || this.disposed) return Promise.resolve();
    this.phase = 'sending'; this.abort = new AbortController(); this.emit();
    return this.run(async (signal) => {
      // Never reload a different incident's report, or restore an earlier launch's consent.
      if (!this.envelope || !this.current || !this.launchReady) throw new Error('DIAGNOSTIC_NO_CONSENT');
      if (Date.parse(this.envelope.occurredAt) < this.now() - DIAGNOSTIC_RETENTION_MS) {
        await this.options.store.delete(); if (!signal.aborted) this.finish(); return;
      }
      parseDiagnosticEnvelope(this.envelope, this.now());
      await this.options.store.saveIfAbsent(clone(this.envelope));
      if (!signal.aborted) await this.submit(signal);
    });
  }
  private run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = this.abort!.signal;
    // File writes are drained before a clean termination; only network waits are abandoned.
    this.active = action(signal).catch(() => { this.phase = 'failed'; this.emit(); }).finally(() => {
      if (signal.aborted && this.phase === 'sending') this.phase = 'failed';
      this.abort = null; this.active = null;
    });
    return this.active;
  }
  private async submit(signal: AbortSignal) {
    const report = this.envelope!;
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error('DIAGNOSTIC_CANCELLED'));
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    let response: unknown;
    try { response = await Promise.race([this.options.service.submit(clone(report), signal), cancelled]); }
    finally { signal.removeEventListener('abort', cancel); }
    const receipt = parseDiagnosticReceipt(response, report.reportId);
    if (signal.aborted || this.disposed || this.terminating) return;
    await this.options.store.delete();
    if (signal.aborted || this.disposed || this.terminating) return;
    this.number = receipt.diagnosticNumber; this.phase = 'sent'; this.emit();
  }
  async discard(): Promise<boolean> {
    if (!['prompt', 'failed'].includes(this.phase) || this.discarding || this.active || this.terminating || this.disposed) return false;
    this.discarding = true;
    try {
      await this.options.store.delete();
      if (this.terminating || this.disposed) return false;
      this.finish(); return true;
    } catch { return false; } finally { this.discarding = false; }
  }
  done(): void { if (this.phase === 'sent' && !this.terminating && !this.disposed) this.finish(); }
  private finish() {
    this.current = this.queued; this.queued = null; this.envelope = null; this.number = null;
    this.phase = this.current ? 'prompt' : 'idle'; this.emit();
  }
  terminate(): Promise<void> {
    if (this.termination) return this.termination;
    this.terminating = true; this.abort?.abort();
    this.termination = (async () => {
      await this.initialization; await this.active; await this.writes;
      // Always try: beginRun may have written its marker before a cleanup failure.
      await this.options.store.endRun();
    })();
    return this.termination;
  }
  /** Windows session-end may kill the process as soon as its callback returns.
   * DiskDiagnosticStore.endRun performs its disk mutations synchronously before
   * returning a Promise. Do not queue this behind initialization, uploads or writes.
   * Only call after confirmed session-end, never the cancellable shutdown query.
   */
  terminateForWindowsSession(): Promise<void> {
    this.windowsSessionEnded = true;
    this.terminating = true;
    this.abort?.abort();
    this.termination = this.options.store.endRun();
    return this.termination;
  }
  /** Update install did not quit: establish a new marker without purging current consent. */
  async resume(): Promise<void> {
    if (this.disposed || !this.terminating || this.windowsSessionEnded) return;
    try { await this.termination; } catch { /* Still restore the running marker. */ }
    if (this.windowsSessionEnded) return;
    this.termination = null; this.terminating = false;
    try { await this.options.store.beginRun(); }
    catch (error) { this.storeFailure(error, 'LOCAL_STATE_WRITE_FAILED'); }
    this.emit();
  }
  /** Does not mark a clean exit; the application must await terminate() first. */
  dispose(): void { this.disposed = true; this.abort?.abort(); this.listeners.clear(); }
}
