import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NativeHost } from '../src/main/native-host';
const fixture = path.resolve('tests/fixtures/helper-fixture.mjs');
const host = (mode: string) => new NativeHost({ executable: process.execPath, args: [fixture, mode],
  platform: process.platform, arch: process.arch, timeoutMs: 500, heartbeatMs: 0 });

test('audio frames are collected before matching metadata and remain owned by caller', async () => {
  const h = host('audio-valid');
  try {
    await h.start(); const batch = await h.readAudio(h.nextAudioStream());
    assert.equal(batch.state, 'ended'); assert.equal(batch.totalSamples, 1);
    assert.equal(batch.frames[0].pcm.readInt16LE(), 1234); batch.frames[0].pcm.fill(0);
  } finally { await h.stop(); }
});
for (const mode of ['audio-after-json', 'audio-foreign', 'audio-count', 'audio-extra']) {
  test(`audio supervisor rejects ${mode}`, async () => {
    const h = host(mode);
    try {
      await h.start(); await assert.rejects(h.readAudio(h.nextAudioStream()));
      assert.equal(h.snapshot.status, 'unavailable');
    } finally { await h.stop(); }
  });
}

test('supervisor handshakes once, pings and shuts down the real child process', async () => {
  const h = host('healthy');
  const statuses: string[] = []; const unsubscribe = h.subscribe((s) => statuses.push(s.status));
  try {
    await Promise.all([h.start(), h.start()]); assert.equal(h.snapshot.status, 'ready');
    await h.ping(); assert.equal(statuses.filter((s) => s === 'ready').length, 1);
  } finally { await h.stop(); unsubscribe(); }
  assert.equal(h.snapshot.status, 'stopped');
});

for (const mode of ['silent', 'exit', 'bad-frame', 'wrong-id']) {
  test(`supervisor rejects ${mode} child and releases pending requests`, async () => {
    const h = host(mode);
    try { await assert.rejects(h.start()); assert.equal(h.snapshot.status, 'unavailable'); }
    finally { await h.stop(); }
  });
}

test('stopping during handshake cannot later mark an old child ready', async () => {
  const h = host('silent');
  const start = h.start(); const rejection = assert.rejects(start);
  await h.stop(); await rejection;
  assert.equal(h.snapshot.status, 'stopped');
});

test('helper events discard duplicate and older sequences from the current instance', { timeout: 3000 }, async () => {
  const h = host('events'); const phases: string[] = [];
  const received = new Promise<void>((resolve) => h.subscribeInput((event) => {
    phases.push(event.phase); if (phases.length === 3) resolve();
  }));
  try {
    await h.start(); await h.ping(); await received;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(phases, ['pressed', 'activated', 'released']);
  } finally { await h.stop(); }
});

test('an event from another helper instance fails closed', { timeout: 3000 }, async () => {
  const h = host('bad-event'); const events: unknown[] = [];
  h.subscribeInput((event) => events.push(event));
  const fault = new Promise<void>((resolve) => h.subscribe((state) => { if (state.status === 'unavailable') resolve(); }));
  try {
    await h.start(); await h.ping().catch(() => undefined); await fault;
    assert.deepEqual(events, []); assert.equal(h.snapshot.status, 'unavailable');
  } finally { await h.stop(); }
});

test('invalid native result schemas and mismatching configure replies stop the helper', async () => {
  for (const mode of ['bad-status', 'bad-config']) {
    const h = host(mode);
    try {
      await h.start();
      await assert.rejects(mode === 'bad-status' ? h.inputStatus() : h.configureInput({
        enabled: true, binding: 'ctrl-shift-space', generation: 1, excludedPids: [123],
      }));
      assert.equal(h.snapshot.status, 'unavailable');
    } finally { await h.stop(); }
  }
});

test('timeout followed by stop reaps a child that ignores SIGTERM', async () => {
  mkdirSync('.runtime', { recursive: true });
  const pidPath = path.resolve('.runtime', `supervisor-${randomUUID()}.pid`);
  const h = new NativeHost({ executable: process.execPath, args: [fixture, 'ignore-term', pidPath],
    platform: process.platform, arch: process.arch, timeoutMs: 300, heartbeatMs: 0 });
  let pid: number | undefined;
  try {
    await assert.rejects(h.start());
    pid = Number(readFileSync(pidPath, 'utf8'));
    await h.stop();
    assert.equal(h.snapshot.status, 'stopped');
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
    await h.stop(); rmSync(pidPath, { force: true });
  }
});
