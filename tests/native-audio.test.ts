import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameDecoder, parseResponse } from '../src/shared/native-protocol';
import { parseAudioFrame, parseAudioRead, type AudioRead } from '../src/shared/native-audio';

const body = () => {
  const data = Buffer.alloc(22); data.write('TXA1'); data.writeUInt32BE(1, 4);
  data.writeUInt32BE(1, 8); data.writeUInt32BE(3, 12); data.writeInt16LE(1234, 16); return data;
};
test('binary audio survives every pipe split and rejects malformed frame boundaries', () => {
  const audio = body(), header = Buffer.alloc(4); header.writeUInt32BE(audio.length);
  const wire = Buffer.concat([header, audio]);
  for (let split = 1; split < wire.length; split++) {
    const decoder = new FrameDecoder(true);
    assert.deepEqual(decoder.push(wire.subarray(0, split)), []);
    const result = decoder.push(wire.subarray(split));
    assert.deepEqual(parseAudioFrame(result[0] as Buffer).pcm, audio.subarray(16)); decoder.end();
  }
  assert.throws(() => new FrameDecoder().push(wire));
  for (const offset of [4, 8, 12]) { const bad = body(); bad.writeUInt32BE(0, offset); assert.throws(() => parseAudioFrame(bad)); }
  assert.throws(() => parseAudioFrame(audio.subarray(0, -1)));
  const huge = body(); huge.writeUInt32BE(1601, 12); assert.throws(() => parseAudioFrame(huge));
  const badMagic = body(); badMagic[0] |= 0x80; assert.throws(() => parseAudioFrame(badMagic));
});
test('audio metadata forbids failed data, arbitrary reasons and unbounded totals', () => {
  const good: AudioRead = { streamId: 1, state: 'ended', reason: null, frameCount: 1, totalSamples: 3 };
  assert.deepEqual(parseAudioRead(good), good);
  for (const bad of [{ ...good, frameCount: 5 }, { ...good, totalSamples: 4_800_001 },
    { ...good, state: 'failed', reason: 'AUDIO_OVERFLOW' }, { ...good, reason: 'raw device error' },
    { ...good, sampleRate: 16000 }, { ...good, streamId: 1.1 }]) assert.throws(() => parseAudioRead(bad));
});
test('input device change is a bounded failure, never a successful audio tail', () => {
  assert.deepEqual(parseResponse({ v: 1, id: 'start', ok: false, error: 'INPUT_DEVICE_CHANGED' }),
    { v: 1, id: 'start', ok: false, error: 'INPUT_DEVICE_CHANGED' });
  const failure = { streamId: 1, state: 'failed', reason: 'INPUT_DEVICE_CHANGED', frameCount: 0, totalSamples: 1600 };
  assert.equal(parseAudioRead(failure).reason, 'INPUT_DEVICE_CHANGED');
  assert.throws(() => parseAudioRead({ ...failure, frameCount: 1 }));
  assert.throws(() => parseAudioRead({ ...failure, state: 'ended' }));
});
