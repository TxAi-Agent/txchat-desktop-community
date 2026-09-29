import type { RecognitionProvider, RecognitionStream } from './recognition-provider';
import type { NativeHost } from '../main/native-host';
import type { RecognitionPort, SessionEvents } from '../domain/dictation';
import type { AudioProgress } from '../shared/native-audio';
import type { ProviderSelection } from '../shared/custom-ai';
import { NativeAudioCapture } from './native-audio';
import { buildWav, transcribe, optimize, type ProviderTransport } from './custom-ai';
export interface AudioService {
  start(partial: (text: string) => void, failure: (error: Error) => void, signal: AbortSignal): Promise<void>;
  write(pcm: Buffer): Promise<void>; finish(organizing: () => void): Promise<string>; dispose(): void;
}
export function microphoneRecognition(host: NativeHost, service: AudioService, progress: (progress: AudioProgress) => void, report: (error: Error) => void): RecognitionPort {
  let disposed = false; let events: SessionEvents | undefined;
  const failed = (error: Error) => { if (!disposed) { if (error.message !== 'NO_SPEECH') report(error); events?.failed(error); capture.cancel(); service.dispose(); } };
  const capture = new NativeAudioCapture(host, progress, (pcm) => service.write(pcm), (error) => { if (error) failed(error); else if (!disposed) events?.ended(); });
  return {
    async start(partial, signal, callbacks) { events = callbacks; try { await capture.prepare(signal); await service.start(partial, failed, signal); if (disposed || signal.aborted) throw new Error('CANCELLED'); await capture.start(signal); } catch (error) { failed(error instanceof Error ? error : new Error('AUDIO_INTERRUPTED')); throw error; } },
    async finish(organizing, signal) {
      try { await capture.stop(); if (disposed || signal.aborted) throw new Error('CANCELLED'); return await service.finish(organizing); }
      catch (error) { if (!disposed && !signal.aborted && !(error instanceof Error && error.message === 'NO_SPEECH')) report(error instanceof Error ? error : new Error('UPSTREAM_UNAVAILABLE')); throw error; }
    },
    dispose() { if (disposed) return; disposed = true; capture.cancel(); service.dispose(); },
  };
}
export class CustomAudioService implements AudioService {
  private chunks: Buffer[] = []; private bytes = 0; private disposed = false; private started = false;
  private abort = new AbortController(); private removeAbort = () => undefined as void;
  constructor(private readonly asr: ProviderSelection, private readonly optimization: ProviderSelection | null,
    private readonly transport: ProviderTransport, private readonly fallback: (error: unknown) => void) {}
  async start(_partial: (text: string) => void, _failure: (error: Error) => void, signal: AbortSignal) {
    if (this.started || this.disposed || signal.aborted) throw new Error('CANCELLED'); this.started = true;
    const cancel = () => this.dispose(); signal.addEventListener('abort', cancel, { once: true }); this.removeAbort = () => signal.removeEventListener('abort', cancel);
  }
  async write(pcm: Buffer) {
    if (!this.started || this.disposed || pcm.length % 2 || this.bytes + pcm.length > 9_600_000) throw new Error('AUDIO_LIMIT_EXCEEDED');
    this.bytes += pcm.length; this.chunks.push(Buffer.from(pcm));
  }
  async finish(organizing: () => void): Promise<string> {
    if (this.disposed || !this.started) throw new Error('CANCELLED');
    const pcm = Buffer.concat(this.chunks, this.bytes); this.clear(); let wav: Buffer | null = null;
    try {
      wav = buildWav(pcm); pcm.fill(0);
      const raw = await transcribe(wav, this.asr, this.transport, this.abort.signal);
      wav.fill(0); wav = null; if (this.disposed) throw new Error('CANCELLED');
      if (!this.optimization) return raw; organizing();
      try { return await optimize(raw, this.optimization, this.transport, this.abort.signal); }
      catch (error) { if (this.disposed || this.abort.signal.aborted || (error as Error).message === 'CANCELLED') throw error; this.fallback(error); return raw; }
    } finally { pcm.fill(0); wav?.fill(0); }
  }
  private clear() { this.chunks.forEach((chunk) => chunk.fill(0)); this.chunks = []; this.bytes = 0; }
  dispose() { if (this.disposed) return; this.disposed = true; this.abort.abort(); this.removeAbort(); this.clear(); }
}

/** Adapts an explicitly installed recognizer without assuming a remote protocol. */
export class ProviderAudioService implements AudioService {
  private stream: RecognitionStream | null = null;
  private disposed = false;
  constructor(private readonly provider: RecognitionProvider, private readonly mode: 'smart' | 'verbatim' = 'verbatim') {}
  async start(partial: (text: string) => void, _failure: (error: Error) => void, signal: AbortSignal) {
    if (this.disposed || this.stream || signal.aborted) throw new Error('CANCELLED');
    this.stream = this.provider.createStream({ signal, onPartial: partial, mode: this.mode });
  }
  async write(pcm: Buffer) {
    if (this.disposed || !this.stream) throw new Error('CANCELLED');
    await this.stream.write(pcm);
  }
  async finish(_organizing: () => void) {
    if (this.disposed || !this.stream) throw new Error('CANCELLED');
    const text = await this.stream.finish();
    if (this.disposed) throw new Error('CANCELLED');
    if (!text.trim()) throw new Error('NO_SPEECH');
    return text;
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.stream?.dispose(); this.stream = null; }
}
