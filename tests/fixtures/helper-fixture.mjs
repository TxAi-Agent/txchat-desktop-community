import { randomUUID } from 'node:crypto';
const instanceId = randomUUID();
// Process boundary fault fixture, used only by supervisor tests.
import { writeFileSync } from 'node:fs';
const mode = process.argv[2];
let buffer = Buffer.alloc(0);
const encoded = (value) => {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
};
const send = (value) => process.stdout.write(encoded(value));
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE()) {
    const size = buffer.readUInt32BE(); const req = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
    if (mode === 'silent' || mode === 'ignore-term') continue;
    if (mode === 'exit') { process.exit(3); }
    if (mode === 'bad-frame') { process.stdout.write(Buffer.from([255,255,255,255])); continue; }
    if (req.method === 'hello') send({ v: 1, id: mode === 'wrong-id' ? 'foreign' : req.id, ok: true,
      result: { protocolVersion: 1, helperVersion: '0.1.0', instanceId: instanceId,
        platform: process.platform, arch: process.arch, capabilities: { handshake: true, hotkey: true, audio: true, insertion: true } } });
    if (req.method === 'ping') {
      send({ v: 1, id: req.id, ok: true, result: { alive: true } });
      if (mode === 'events' || mode === 'bad-event') {
        const event = { v: 1, event: 'hotkey', instanceId: mode === 'bad-event' ? randomUUID() : instanceId,
          generation: 1, sequence: 1, phase: 'pressed', targetId: null, reason: null };
        send(event);
        const activation = { ...event, sequence: 2, phase: 'activated', targetId: instanceId };
        send(activation); send(activation); send(event);
        send({ ...event, sequence: 3, phase: 'released' });
      }
    }
    if (req.method === 'status' || req.method === 'configure') {
      const result = { accessibility: 'granted', inputMonitoring: 'granted', enabled: false,
        binding: 'ctrl-alt-space', generation: 0, reason: null };
      if (mode === 'bad-status') result.rawKeys = [];
      // bad-config deliberately acknowledges a different generation/binding.
      if (req.method === 'configure' && mode !== 'bad-config') Object.assign(result, {
        enabled: req.params.enabled, binding: req.params.binding, generation: req.params.generation,
      });
      send({ v: 1, id: req.id, ok: true, result });
    }
    if (req.method === 'readAudio') {
      const binary = Buffer.alloc(22); binary.writeUInt32BE(18); binary.write('TXA1', 4);
      binary.writeUInt32BE(mode === 'audio-foreign' ? 2 : req.params.streamId, 8);
      binary.writeUInt32BE(1, 12); binary.writeUInt32BE(1, 16); binary.writeInt16LE(1234, 20);
      const count = mode === 'audio-extra' ? 5 : 1;
      const json = encoded({ v: 1, id: req.id, ok: true, result: { streamId: req.params.streamId, state: 'ended',
        reason: null, frameCount: mode === 'audio-count' ? 0 : count, totalSamples: count } });
      // One write deliberately exercises coalesced JSON-before-binary rejection.
      process.stdout.write(mode === 'audio-after-json' ? Buffer.concat([json, binary]) : Buffer.concat([...Array(count).fill(binary), json]));
    }
    if (req.method === 'shutdown') { send({ v: 1, id: req.id, ok: true, result: { stopping: true } }); process.exit(0); }
  }
});
process.stdin.on('end', () => { if (mode !== 'ignore-term') process.exit(0); });
if (process.argv[2] === 'ignore-term') {
  writeFileSync(process.argv[3], String(process.pid));
  process.on('SIGTERM', () => undefined);
  process.stdin.resume();
  setInterval(() => undefined, 1000);
}
