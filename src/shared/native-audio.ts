import { exactObject, isAudioPayload } from './native-protocol';

export const AUDIO = { sampleRate: 16_000, channels: 1, frameSamples: 1600, maxSamples: 4_800_000,
  maxBatch: 4, queueFrames: 20, encoding: 'pcm_s16le' } as const;
export const AUDIO_REASONS = ['AUDIO_PERMISSION_REQUIRED', 'AUDIO_DEVICE_UNAVAILABLE', 'AUDIO_FORMAT_UNSUPPORTED',
  'AUDIO_BUSY', 'AUDIO_INVALID_STATE', 'AUDIO_OVERFLOW', 'AUDIO_INTERRUPTED', 'AUDIO_LIMIT_REACHED',
  'AUDIO_CANCELLED', 'AUDIO_CONVERSION_FAILED', 'INPUT_DEVICE_CHANGED'] as const;
export type AudioReason = typeof AUDIO_REASONS[number];
export type AudioSource = 'synthetic' | 'microphone-local';
export const FIXTURE_SCENARIOS = ['success', 'upstream-failure', 'empty-final', 'disconnect'] as const;
export type FixtureScenario = typeof FIXTURE_SCENARIOS[number];
export interface AudioStatus { permission: 'granted' | 'denied' | 'restricted' | 'notDetermined' | 'systemManaged'; active: boolean; reason: AudioReason | null }
export interface AudioRead { streamId: number; state: 'recording' | 'draining' | 'ended' | 'failed'; reason: AudioReason | null; frameCount: number; totalSamples: number }
export interface AudioFrame { streamId: number; sequence: number; samples: number; pcm: Buffer }
export interface AudioProgress { active: boolean; frames: number; samples: number; level: number }
export interface AudioSnapshot { source: AudioSource; scenario: FixtureScenario; status: AudioStatus | null; progress: AudioProgress; busy: boolean; notice: string | null }
export const validStream = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 2_147_483_647;
const reason = (value: unknown) => value === null || AUDIO_REASONS.includes(value as AudioReason);
export function parseAudioStatus(value: unknown): AudioStatus {
  if (!exactObject(value, ['permission', 'active', 'reason']) || !['granted', 'denied', 'restricted', 'notDetermined', 'systemManaged'].includes(value.permission as string) ||
      typeof value.active !== 'boolean' || !reason(value.reason)) throw new Error('INVALID_AUDIO_STATUS');
  return value as unknown as AudioStatus;
}
export function parseAudioRead(value: unknown): AudioRead {
  if (!exactObject(value, ['streamId', 'state', 'reason', 'frameCount', 'totalSamples']) || !validStream(value.streamId) ||
      !['recording', 'draining', 'ended', 'failed'].includes(value.state as string) || !reason(value.reason) ||
      !Number.isInteger(value.frameCount) || (value.frameCount as number) < 0 || (value.frameCount as number) > AUDIO.maxBatch ||
      !Number.isInteger(value.totalSamples) || (value.totalSamples as number) < 0 || (value.totalSamples as number) > AUDIO.maxSamples ||
      (value.state === 'failed' && (value.reason === null || value.frameCount !== 0)) ||
      (value.state !== 'failed' && value.reason !== null && value.reason !== 'AUDIO_LIMIT_REACHED')) throw new Error('INVALID_AUDIO_READ');
  return value as unknown as AudioRead;
}
export function parseAudioFrame(body: Buffer): AudioFrame {
  if (body.length < 18 || body.length > 3216 || !isAudioPayload(body)) throw new Error('INVALID_AUDIO_FRAME');
  const streamId = body.readUInt32BE(4), sequence = body.readUInt32BE(8), samples = body.readUInt32BE(12);
  if (!validStream(streamId) || !validStream(sequence) || samples < 1 || samples > AUDIO.frameSamples || body.length !== 16 + samples * 2) throw new Error('INVALID_AUDIO_FRAME');
  return { streamId, sequence, samples, pcm: body.subarray(16) };
}
