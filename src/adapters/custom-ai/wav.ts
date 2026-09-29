import { CustomAIError } from './errors';
import { MAX_PCM_BYTES, MAX_WAV_BYTES } from './types';

export function buildWav(pcm: Buffer): Buffer {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 !== 0 || pcm.length > MAX_PCM_BYTES) {
    throw new CustomAIError('CUSTOM_AI_INVALID_AUDIO');
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return wav;
}

/** Validates bounded mono PCM WAV files, including optional RIFF chunks. */
export function validateWav(wav: Buffer): void {
  const fail = (): never => { throw new CustomAIError('CUSTOM_AI_INVALID_AUDIO'); };
  if (!Buffer.isBuffer(wav) || wav.length < 46 || wav.length > MAX_WAV_BYTES
    || wav.toString('utf8', 0, 4) !== 'RIFF' || wav.toString('utf8', 8, 12) !== 'WAVE'
    || wav.readUInt32LE(4) !== wav.length - 8) return fail();
  let offset = 12, hasFormat = false, hasData = false;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('utf8', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (size > wav.length - start) return fail();
    if (id === 'fmt ') {
      if (hasFormat || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt32LE(start + 4) !== 16_000 || wav.readUInt32LE(start + 8) !== 32_000
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) return fail();
      hasFormat = true;
    } else if (id === 'data') {
      if (hasData || !hasFormat || !size || size % 2 !== 0 || size > MAX_PCM_BYTES) return fail();
      hasData = true;
    }
    offset = start + size + (size % 2);
  }
  if (offset !== wav.length || !hasFormat || !hasData) return fail();
}
