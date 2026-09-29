export const MAX_FRAME_BYTES = 65_536;
export const isAudioPayload = (body: Buffer) => body.length >= 4 && body[0] === 0x54 && body[1] === 0x58 && body[2] === 0x41 && body[3] === 0x31;
export function encodeFrame(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES) throw new Error('INVALID_FRAME_LENGTH');
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

/** Header is validated before allocating a bounded body. No unbounded concatenation. */
export class FrameDecoder {
  constructor(private readonly binaryAudio = false) {}
  private header = Buffer.alloc(4);
  private headerOffset = 0;
  private body: Buffer | null = null;
  private offset = 0;
  push(chunk: Buffer): unknown[] {
    const messages: unknown[] = [];
    let index = 0;
    while (index < chunk.length) {
      if (!this.body) {
        const amount = Math.min(4 - this.headerOffset, chunk.length - index);
        chunk.copy(this.header, this.headerOffset, index, index + amount);
        this.headerOffset += amount; index += amount;
        if (this.headerOffset < 4) continue;
        const length = this.header.readUInt32BE();
        if (!length || length > MAX_FRAME_BYTES) throw new Error('INVALID_FRAME_LENGTH');
        this.body = Buffer.alloc(length); this.offset = 0;
      }
      const amount = Math.min(this.body.length - this.offset, chunk.length - index);
      chunk.copy(this.body, this.offset, index, index + amount);
      this.offset += amount; index += amount;
      if (this.offset === this.body.length) {
        try {
          if (this.binaryAudio && isAudioPayload(this.body)) messages.push(this.body);
          else messages.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body)));
        }
        catch { throw new Error('INVALID_FRAME'); }
        this.body = null; this.headerOffset = 0;
      }
    }
    return messages;
  }
  end() { if (this.headerOffset || this.body) throw new Error('TRUNCATED_FRAME'); }
}

export function exactObject(input: unknown, keys: string[]): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).sort().join(',') === [...keys].sort().join(',');
}
export type NativeResponse = { v: 1; id: string; ok: true; result: unknown } | { v: 1; id: string; ok: false; error: string };
export function parseResponse(input: unknown): NativeResponse {
  if (!input || typeof input !== 'object') throw new Error('INVALID_RESPONSE');
  const record = input as Record<string, unknown>;
  if (record.v !== 1 || typeof record.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(record.id)) throw new Error('INVALID_RESPONSE');
  if (record.ok === true && exactObject(record, ['v', 'id', 'ok', 'result'])) return record as NativeResponse;
  if (record.ok === false && exactObject(record, ['v', 'id', 'ok', 'error']) &&
      ['PROTOCOL_MISMATCH', 'UNSUPPORTED_METHOD', 'INVALID_ARGUMENTS', 'PERMISSION_REQUIRED', 'HOTKEY_CONFLICT',
        'HOTKEY_UNAVAILABLE', 'UNSUPPORTED_BINDING', 'TARGET_UNAVAILABLE', 'TARGET_CHANGED', 'PROTECTED_TARGET',
        'OWN_APPLICATION', 'CAPACITY_EXCEEDED', 'INPUT_BUSY', 'AUDIO_PERMISSION_REQUIRED', 'AUDIO_DEVICE_UNAVAILABLE',
        'AUDIO_FORMAT_UNSUPPORTED', 'AUDIO_BUSY', 'AUDIO_INVALID_STATE', 'AUDIO_OVERFLOW', 'AUDIO_INTERRUPTED',
        'AUDIO_LIMIT_REACHED', 'AUDIO_CANCELLED', 'AUDIO_CONVERSION_FAILED', 'INPUT_DEVICE_CHANGED'].includes(record.error as string)) return record as NativeResponse;
  throw new Error('INVALID_RESPONSE');
}
export interface NativeHello {
  protocolVersion: 1; helperVersion: string; instanceId: string; platform: string; arch: string;
  capabilities: { handshake: true; hotkey: true; audio: true; insertion: true };
}
export function parseHello(input: unknown, platform: string, arch: string): NativeHello {
  if (!exactObject(input, ['protocolVersion', 'helperVersion', 'instanceId', 'platform', 'arch', 'capabilities']) ||
      input.protocolVersion !== 1 || input.helperVersion !== '0.1.0' || input.platform !== platform || input.arch !== arch ||
      typeof input.instanceId !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.instanceId) ||
      !exactObject(input.capabilities, ['handshake', 'hotkey', 'audio', 'insertion']) ||
      input.capabilities.handshake !== true || input.capabilities.hotkey !== true || input.capabilities.audio !== true || input.capabilities.insertion !== true) {
    throw new Error('INCOMPATIBLE_HELPER');
  }
  return input as unknown as NativeHello;
}
