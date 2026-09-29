import { parseNativeDisplay } from '../shared/native-display';
import { parseShortcutCaptureEvent, type NativeShortcutCaptureEvent } from '../shared/shortcut-editor';
import { printableKeyLabel, shortcutNeedsLayoutLabel } from '../shared/shortcut-bindings';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import type { HelperSnapshot } from '../shared/contracts';
import { encodeFrame, exactObject, FrameDecoder, parseHello, parseResponse } from '../shared/native-protocol';

import { parseConfigureInput, parseHotkeyEvent, parseInputStatus, parseInsertion, parseTarget, type NativeHotkeyEvent, type ConfigureInput, type InsertText } from '../shared/native-input';
import { AUDIO, parseAudioFrame, parseAudioRead, parseAudioStatus, type AudioFrame } from '../shared/native-audio';

interface LaunchOptions {
  executable: string; args?: string[]; platform: string; arch: string;
  timeoutMs?: number; heartbeatMs?: number;
}
interface Pending { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Main-owned, single-flight supervisor. No renderer-controlled paths or auto replay. */
export class NativeHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private terminating: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pending = new Map<string, Pending>();
  private sequence = 0;
  private streamSequence = 0;
  private audioRead: { streamId: number; frames: AudioFrame[]; sealed: boolean } | null = null;
  private instanceId: string | null = null;
  private lastEvent = 0;
  private eventWindow = 0;
  private eventCount = 0;
  private captureListeners = new Set<(event: NativeShortcutCaptureEvent) => void>();
  private inputListeners = new Set<(event: NativeHotkeyEvent) => void>();
  private listeners = new Set<(snapshot: HelperSnapshot) => void>();
  private state: HelperSnapshot = { status: 'stopped', platform: null, arch: null, version: null, reason: null };

  constructor(private readonly options: LaunchOptions) {
    if (!path.isAbsolute(options.executable)) throw new Error('ABSOLUTE_HELPER_PATH_REQUIRED');
  }
  get snapshot(): HelperSnapshot { return { ...this.state }; }
  subscribe(listener: (snapshot: HelperSnapshot) => void) {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  subscribeInput(listener: (event: NativeHotkeyEvent) => void) {
    this.inputListeners.add(listener); return () => { this.inputListeners.delete(listener); };
  }
  subscribeShortcutCapture(listener: (event: NativeShortcutCaptureEvent) => void) {
    this.captureListeners.add(listener); return () => { this.captureListeners.delete(listener); };
  }
  private update(change: Partial<HelperSnapshot>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.terminating) return this.terminating.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.state.status === 'ready') return Promise.resolve();
    const work = this.launch();
    this.starting = work;
    void work.finally(() => { if (this.starting === work) this.starting = null; }).catch(() => undefined);
    return work;
  }
  private async launch() {
    this.instanceId = null; this.lastEvent = 0; this.eventWindow = 0; this.eventCount = 0;
    this.update({ status: 'starting', reason: null, platform: null, arch: null, version: null });
    const child = spawn(this.options.executable, this.options.args ?? [], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {},
    });
    this.child = child;
    const decoder = new FrameDecoder(true);
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return;
      try {
        for (const input of decoder.push(chunk)) {
          if (Buffer.isBuffer(input)) {
            const frame = parseAudioFrame(input);
            if (this.state.status !== 'ready' || !this.audioRead || this.audioRead.sealed || this.audioRead.streamId !== frame.streamId || this.audioRead.frames.length >= AUDIO.maxBatch) throw new Error('UNEXPECTED_AUDIO_FRAME');
            this.audioRead.frames.push(frame); continue;
          }
          if (input && typeof input === 'object' && 'event' in input) {
            const event = input.event === 'shortcutCapture' ? parseShortcutCaptureEvent(input) : parseHotkeyEvent(input);
            if (this.state.status !== 'ready' || event.instanceId !== this.instanceId) throw new Error('UNEXPECTED_EVENT');
            const now = Date.now();
            if (now - this.eventWindow >= 1000) { this.eventWindow = now; this.eventCount = 0; }
            if (++this.eventCount > 50) throw new Error('EVENT_FLOOD');
            if (event.sequence <= this.lastEvent) continue;
            this.lastEvent = event.sequence;
            if (event.event === 'hotkey') { for (const listener of this.inputListeners) listener(event); }
            else { for (const listener of this.captureListeners) listener(event); }
            continue;
          }
          const response = parseResponse(input);
          const pending = this.pending.get(response.id);
          if (!pending) throw new Error('UNEXPECTED_RESPONSE');
          if (pending.method === 'readAudio' && this.audioRead) this.audioRead.sealed = true;
          this.pending.delete(response.id); clearTimeout(pending.timer);
          if (response.ok) pending.resolve(response.result);
          else pending.reject(new Error(response.error));
        }
      } catch { this.fail(child, 'INVALID_HELPER_RESPONSE'); }
    });
    // Drain without retaining/forwarding untrusted payloads into application logs.
    child.stderr.on('data', () => undefined);
    child.on('error', () => this.fail(child, 'HELPER_LAUNCH_FAILED'));
    child.stdin.on('error', () => this.fail(child, 'HELPER_PIPE_FAILED'));
    child.on('close', () => {
      if (this.child !== child) return;
      try { decoder.end(); } catch { this.fail(child, 'HELPER_TRUNCATED_RESPONSE'); return; }
      this.fail(child, 'HELPER_EXITED');
    });
    try {
      const hello = parseHello(await this.request('hello'), this.options.platform, this.options.arch);
      if (this.child !== child) throw new Error('HELPER_STOPPED');
      this.instanceId = hello.instanceId;
      this.update({ status: 'ready', platform: hello.platform, arch: hello.arch, version: hello.helperVersion });
      const period = this.options.heartbeatMs ?? 5000;
      if (period > 0) this.heartbeat = setInterval(() => { void this.ping().catch(() => undefined); }, period);
    } catch (error) {
      if (this.child === child) this.fail(child, 'HELPER_HANDSHAKE_FAILED');
      throw error;
    }
  }
  private request(method: 'hello' | 'ping' | 'hudDisplay' | 'status' | 'requestPermissions' | 'requestAccessibility' | 'configure' | 'captureTarget' | 'releaseTarget' | 'insertText' |
    'beginShortcutCapture' | 'endShortcutCapture' | 'shortcutKeyLabel' | 'audioStatus' | 'requestAudioPermission' | 'preflightAudio' | 'startAudio' | 'stopAudio' | 'cancelAudio' | 'readAudio', params?: unknown): Promise<unknown> {
    const child = this.child;
    if (!child || this.pending.size >= 8) return Promise.reject(new Error('HELPER_UNAVAILABLE'));
    const id = `r${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, 'HELPER_TIMEOUT'), this.options.timeoutMs ?? 3000);
      this.pending.set(id, { method, resolve, reject, timer });
      child.stdin.write(encodeFrame(params === undefined ? { v: 1, id, method } : { v: 1, id, method, params }), (error) => { if (error) this.fail(child, 'HELPER_PIPE_FAILED'); });
    });
  }
  async ping() {
    const child = this.child;
    try {
      const result = await this.request('ping');
      if (!exactObject(result, ['alive']) || result.alive !== true) throw new Error('INVALID_PING');
    } catch (error) { if (child) this.fail(child, 'HELPER_PING_FAILED'); throw error; }
  }
  private async checked<T>(method: Parameters<NativeHost['request']>[0], parse: (value: unknown) => T, params?: unknown): Promise<T> {
    const child = this.child;
    const result = await this.request(method, params);
    if (this.child !== child) throw new Error('HELPER_STOPPED');
    try { return parse(result); }
    catch (error) { if (child) this.fail(child, 'INVALID_HELPER_RESPONSE'); throw error; }
  }
  async inputStatus() { return this.checked('status', parseInputStatus); }
  async hudDisplay() { return this.checked('hudDisplay', parseNativeDisplay); }
  async requestPermissions() { return this.checked('requestAccessibility', parseInputStatus); }
  async configureInput(params: ConfigureInput) {
    parseConfigureInput(params);
    return this.checked('configure', (value) => {
      const status = parseInputStatus(value);
      if (status.enabled !== params.enabled || status.binding !== params.binding || status.generation !== params.generation) throw new Error('INVALID_CONFIGURE_RESULT');
      return status;
    }, params);
  }
  async shortcutCapture(captureId: string, enabled: boolean) {
    return this.checked(enabled ? 'beginShortcutCapture' : 'endShortcutCapture', (result) => {
      if (!exactObject(result, ['active']) || result.active !== enabled) throw new Error('INVALID_CAPTURE_RESULT');
    }, { captureId });
  }
  async captureTarget() { return this.checked('captureTarget', parseTarget); }
  async shortcutKeyLabel(code: string, shift: boolean): Promise<string> {
    if (!shortcutNeedsLayoutLabel(code) || typeof shift !== 'boolean') throw new Error('INVALID_ARGUMENTS');
    return this.checked('shortcutKeyLabel', (result) => {
      const label = exactObject(result, ['key']) ? printableKeyLabel(result.key) : null;
      if (!label) throw new Error('INVALID_KEY_LABEL');
      return label;
    }, { code, shift });
  }
  async releaseTarget(targetId: string) {
    return this.checked('releaseTarget', (result) => {
      if (!exactObject(result, ['released']) || result.released !== true) throw new Error('INVALID_RELEASE_RESULT');
    }, { targetId });
  }
  async insertText(params: InsertText) { return this.checked('insertText', parseInsertion, params); }
  nextAudioStream() { if (this.streamSequence >= 2_147_483_647) throw new Error('AUDIO_INVALID_STATE'); return ++this.streamSequence; }
  async getAudioStatus() { return this.checked('audioStatus', parseAudioStatus); }
  async requestAudioPermission() { return this.checked('requestAudioPermission', parseAudioStatus); }
  async preflightAudio(streamId: number) {
    return this.checked('preflightAudio', (result) => {
      if (!exactObject(result, ['streamId', 'prepared']) || result.streamId !== streamId || result.prepared !== true) throw new Error('INVALID_AUDIO_PREFLIGHT');
    }, { streamId });
  }
  async startAudio(streamId: number) {
    return this.checked('startAudio', (result) => {
      if (!exactObject(result, ['streamId', 'sampleRate', 'channels', 'encoding']) || result.streamId !== streamId ||
          result.sampleRate !== AUDIO.sampleRate || result.channels !== AUDIO.channels || result.encoding !== AUDIO.encoding) throw new Error('INVALID_AUDIO_START');
    }, { streamId });
  }
  async endAudio(streamId: number, cancel: boolean) {
    return this.checked(cancel ? 'cancelAudio' : 'stopAudio', (result) => {
      if (!exactObject(result, ['streamId', 'stopped']) || result.streamId !== streamId || result.stopped !== true) throw new Error('INVALID_AUDIO_STOP');
    }, { streamId });
  }
  async readAudio(streamId: number) {
    if (this.audioRead) throw new Error('AUDIO_BUSY');
    const batch = { streamId, frames: [] as AudioFrame[], sealed: false }; this.audioRead = batch;
    try {
      const result = await this.checked('readAudio', (value) => {
        const read = parseAudioRead(value);
        if (read.streamId !== streamId || read.frameCount !== batch.frames.length) throw new Error('INVALID_AUDIO_BATCH');
        return read;
      }, { streamId });
      return { ...result, frames: batch.frames };
    } catch (error) { for (const frame of batch.frames) frame.pcm.fill(0); throw error; }
    finally { if (this.audioRead === batch) this.audioRead = null; }
  }
  private rejectPending(reason: string) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    this.pending.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  private fail(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return;
    this.child = null; this.rejectPending(reason);
    this.terminate(child, false);
    this.update({ status: 'unavailable', reason, platform: null, arch: null, version: null });
  }
  private terminate(child: ChildProcessWithoutNullStreams, graceful: boolean): Promise<void> {
    // Retain the cleanup promise until close; start/stop must join it, including fault paths.
    const work = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 500);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      if (graceful) child.stdin.end(encodeFrame({ v: 1, id: `r${++this.sequence}`, method: 'shutdown' }));
      // EOF gives the run loop a bounded chance to unregister hooks/restore its clipboard lease.
      // The 500 ms hard deadline still handles blocked native APIs; abrupt death cannot guarantee restoration.
      else child.stdin.destroy();
    });
    this.terminating = work;
    void work.then(() => { if (this.terminating === work) this.terminating = null; });
    return work;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const work = this.shutdown(); this.stopping = work;
    void work.finally(() => { if (this.stopping === work) this.stopping = null; }).catch(() => undefined);
    return work;
  }
  private async shutdown() {
    const child = this.child; this.child = null;
    this.rejectPending('HELPER_STOPPED');
    if (child) await this.terminate(child, true);
    else if (this.terminating) await this.terminating;
    this.update({ status: 'stopped', reason: null, platform: null, arch: null, version: null });
  }
}
