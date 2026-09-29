import { randomUUID } from 'node:crypto';
const instanceId = randomUUID();
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrameDecoder, encodeFrame, parseHello, parseResponse } from '../src/shared/native-protocol';

const hello = { protocolVersion: 1, helperVersion: '0.1.0', instanceId: instanceId, platform: 'darwin', arch: 'arm64',
  capabilities: { handshake: true, hotkey: true, audio: true, insertion: true } };
test('frames survive every split position and concatenation', () => {
  const encoded = encodeFrame({ text: '合成测试' });
  for (let i = 1; i < encoded.length; i++) {
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push(encoded.subarray(0, i)), []);
    assert.deepEqual(decoder.push(encoded.subarray(i)), [{ text: '合成测试' }]);
    decoder.end();
  }
  assert.equal(new FrameDecoder().push(Buffer.concat([encoded, encoded])).length, 2);
});
test('length is bounded before body allocation; truncated and malformed frames fail closed', () => {
  for (const size of [0, 65537, 0xffffffff]) {
    const header = Buffer.alloc(4); header.writeUInt32BE(size);
    assert.throws(() => new FrameDecoder().push(header));
  }
  const decoder = new FrameDecoder(); decoder.push(Buffer.from([0, 0])); assert.throws(() => decoder.end());
  const bad = Buffer.from([0, 0, 0, 1, 0xff]); assert.throws(() => new FrameDecoder().push(bad));
  assert.throws(() => encodeFrame('x'.repeat(65536)));
});
test('response envelopes and native capabilities are exact, versioned and truthful', () => {
  assert.equal(parseHello(hello, 'darwin', 'arm64').helperVersion, '0.1.0');
  for (const bad of [{ ...hello, platform: 'win32' }, { ...hello, arch: 'x64' },
    { ...hello, helperVersion: '0.2.0' }, { ...hello, capabilities: { ...hello.capabilities, audio: false } },
    { ...hello, capabilities: { ...hello.capabilities, insertion: false } }, { ...hello, extra: 'x' }]) {
    assert.throws(() => parseHello(bad, 'darwin', 'arm64'));
  }
  assert.equal(parseResponse({ v: 1, id: 'r1', ok: true, result: { alive: true } }).id, 'r1');
  for (const bad of [{ v: 2, id: 'r1', ok: true, result: {} }, { v: 1, id: 'r1', ok: true, result: {}, extra: 1 },
    { v: 1, id: 'r1', ok: false, error: 'secret arbitrary string' }]) assert.throws(() => parseResponse(bad));
});
