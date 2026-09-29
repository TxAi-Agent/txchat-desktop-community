import type { NativeHost } from '../main/native-host';
import { AUDIO, type AudioProgress } from '../shared/native-audio';
import { deferred, delay } from './async-control';

/** One bounded pull batch is retained while the downstream sink applies backpressure. */
export class NativeAudioCapture {
  private readonly streamId: number;
  private readonly abort = new AbortController();
  private readonly done = deferred<void>();
  private task: Promise<void> | null = null;
  private disposed = false;
  private stopping = false;
  private started = false;
  private preparation: Promise<void> | null = null;
  private previousProduced = 0;
  private sequence = 0;
  private samples = 0;
  private stopTask: Promise<void> | null = null;
  private startedAt = 0;
  private lastProducedAt = 0;
  constructor(private readonly host: Pick<NativeHost, 'nextAudioStream' | 'preflightAudio' | 'startAudio' | 'readAudio' | 'endAudio'>, private readonly publish: (progress: AudioProgress) => void,
    private readonly consume: (pcm: Buffer) => Promise<void>, private readonly ended: (error?: Error) => void) {
    this.streamId = host.nextAudioStream();
  }
  async prepare(signal: AbortSignal) {
    if (this.started || this.disposed || signal.aborted) throw new Error('CANCELLED');
    // Freeze the native device before connecting to any recognition service.
    this.preparation ??= this.host.preflightAudio(this.streamId);
    await this.preparation;
    if (this.disposed || signal.aborted) { this.cancel(); throw new Error('CANCELLED'); }
  }
  async start(signal: AbortSignal) {
    if (this.started || this.disposed || signal.aborted) throw new Error('AUDIO_INVALID_STATE');
    await this.prepare(signal);
    if (this.disposed || signal.aborted) { this.cancel(); throw new Error('CANCELLED'); }
    if (this.started) throw new Error('AUDIO_INVALID_STATE');
    this.started = true;
    await this.host.startAudio(this.streamId);
    if (this.disposed || signal.aborted) { this.cancel(); throw new Error('CANCELLED'); }
    this.startedAt = this.lastProducedAt = Date.now();
    this.task = this.pump();
    void this.task.catch(() => undefined);
  }
  private async pump() {
    try {
      while (!this.disposed) {
        const batch = await this.host.readAudio(this.streamId);
        try {
          if (this.disposed) return;
          if (batch.totalSamples < this.previousProduced) throw new Error('AUDIO_INVALID_STATE');
          if (batch.totalSamples > this.previousProduced) this.lastProducedAt = Date.now();
          this.previousProduced = batch.totalSamples;
          if (batch.state === 'failed') throw new Error(batch.reason ?? 'AUDIO_INTERRUPTED');
          if (batch.state === 'recording' && Date.now() - this.lastProducedAt > 3000) throw new Error('AUDIO_INTERRUPTED');
          for (const frame of batch.frames) {
            if (this.disposed) return;
            if (frame.sequence !== this.sequence + 1 || this.samples + frame.samples > AUDIO.maxSamples ||
                this.samples + frame.samples > batch.totalSamples) throw new Error('AUDIO_INVALID_STATE');
            this.sequence = frame.sequence; this.samples += frame.samples;
            let sum = 0; for (let i = 0; i < frame.pcm.length; i += 2) { const value = frame.pcm.readInt16LE(i) / 32768; sum += value * value; }
            await this.consume(frame.pcm);
            if (this.disposed) return;
            this.publish({ active: true, frames: this.sequence, samples: this.samples, level: Math.sqrt(sum / frame.samples) });
          }
          if (batch.state === 'ended') {
            if (this.samples !== batch.totalSamples) throw new Error('AUDIO_INVALID_STATE');
            this.publish({ active: false, frames: this.sequence, samples: this.samples, level: 0 });
            this.done.resolve(); if (!this.stopping) this.ended(); return;
          }
        } finally { for (const frame of batch.frames) frame.pcm.fill(0); }
        if (!this.stopping && Date.now() - this.startedAt >= 300_000) {
          // A native device that stalls still cannot keep recording indefinitely.
          await this.host.endAudio(this.streamId, false);
        }
        await delay(50, this.abort.signal);
      }
    } catch (error) {
      if (!this.disposed) {
        const failure = error instanceof Error ? error : new Error('AUDIO_INTERRUPTED');
        this.done.reject(failure); this.ended(failure); this.cancel();
      }
    }
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    this.stopTask = (async () => {
      if (this.disposed) throw new Error('CANCELLED');
      await this.host.endAudio(this.streamId, false);
      const timer = setTimeout(() => { this.done.reject(new Error('AUDIO_INTERRUPTED')); this.cancel(); }, 5000);
      try { await this.done.promise; } finally { clearTimeout(timer); }
    })();
    return this.stopTask;
  }
  cancel() {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort(); this.done.reject(new Error('CANCELLED'));
    this.publish({ active: false, frames: this.sequence, samples: this.samples, level: 0 });
    if (this.started || this.preparation) void this.host.endAudio(this.streamId, true).catch(() => undefined);
  }
}
