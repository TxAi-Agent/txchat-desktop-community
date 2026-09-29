import assert from 'node:assert/strict';
import test from 'node:test';
import { deferred } from '../src/adapters/async-control';
import { createMicrophoneSession } from '../src/adapters/microphone-session';
import type { RecognitionProvider, RecognitionStream } from '../src/adapters/recognition-provider';
import { DictationController } from '../src/domain/dictation';
import type { NativeHost } from '../src/main/native-host';
import type { AudioFrame, AudioRead, FixtureScenario } from '../src/shared/native-audio';

type Batch = AudioRead & { frames: AudioFrame[] };
const emptyBatch = (): Batch => ({ streamId: 1, state: 'ended', reason: null,
  frameCount: 0, totalSamples: 0, frames: [] });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

/** Every host call is an in-memory mock; no native process or audio device is opened. */
function harness(scenario: FixtureScenario = 'success', overrides: Partial<RecognitionStream> = {}) {
  const read = deferred<Batch>();
  const endCalls: boolean[] = [];
  const phases: string[] = [];
  let writes = 0, finishes = 0, disposals = 0, insertions = 0;
  const stream: RecognitionStream = {
    async write(pcm) { writes++; await overrides.write?.(pcm); },
    async finish() { finishes++; return overrides.finish ? overrides.finish() : 'Synthetic result'; },
    dispose() { disposals++; overrides.dispose?.(); },
  };
  const provider: RecognitionProvider = { createStream: () => stream };
  const host = {
    nextAudioStream: () => 1,
    preflightAudio: async () => {},
    startAudio: async () => {},
    readAudio: () => read.promise,
    async endAudio(_streamId: number, cancel: boolean) {
      endCalls.push(cancel);
      if (!cancel) read.resolve(emptyBatch());
    },
  } as unknown as NativeHost;
  const controller = new DictationController(() => ({
    ...createMicrophoneSession(host, scenario, () => {}, () => {}, provider),
    async insert() { insertions++; return 'inserted'; },
  }));
  controller.subscribe(snapshot => phases.push(snapshot.phase));
  return { controller, read, endCalls, phases,
    counts: () => ({ writes, finishes, disposals, insertions }),
    dispose() { controller.dispose(); read.resolve(emptyBatch()); },
  };
}

test('empty-final completes as no speech while finalizing, without organizing or insertion', async t => {
  const h = harness('empty-final'); t.after(() => h.dispose());
  await h.controller.start();
  assert.equal(h.controller.snapshot.phase, 'listening');
  await h.controller.stop();
  assert.equal(h.controller.snapshot.phase, 'completed');
  assert.equal(h.controller.snapshot.completion, 'no-speech');
  assert.equal(h.controller.snapshot.failure, null);
  assert.equal(h.controller.snapshot.resultText, '');
  assert.ok(h.phases.includes('finalizing'));
  assert.equal(h.phases.includes('organizing'), false);
  assert.equal(h.phases.includes('inserting'), false);
  assert.equal(h.counts().finishes, 0);
  assert.equal(h.counts().insertions, 0);
  assert.ok(h.counts().disposals > 0);
});

test('cancel discards and zeroes PCM arriving after cancellation', async t => {
  const h = harness(); t.after(() => h.dispose());
  await h.controller.start();
  h.controller.cancel();
  const pcm = Buffer.from([0x7f, 0x01]);
  h.read.resolve({ streamId: 1, state: 'ended', reason: null, frameCount: 1, totalSamples: 1,
    frames: [{ streamId: 1, sequence: 1, samples: 1, pcm }] });
  await turn();
  assert.equal(h.controller.snapshot.phase, 'idle');
  assert.equal(h.controller.snapshot.cancelled, true);
  assert.equal(h.controller.snapshot.resultText, '');
  assert.equal(h.counts().writes, 0);
  assert.equal(h.counts().insertions, 0);
  assert.deepEqual(pcm, Buffer.alloc(2));
  assert.ok(h.endCalls.includes(true));
  assert.ok(h.counts().disposals > 0);
});

test('cancel during provider finalization blocks a late successful result from insertion', async t => {
  const final = deferred<string>();
  const entered = deferred<void>();
  const h = harness('success', { finish: async () => { entered.resolve(); return final.promise; } });
  t.after(() => { final.resolve('Late synthetic result'); h.dispose(); });
  await h.controller.start();
  const stopping = h.controller.stop();
  await entered.promise;
  assert.equal(h.controller.snapshot.phase, 'organizing');
  h.controller.cancel();
  final.resolve('Late synthetic result');
  await stopping;
  assert.equal(h.controller.snapshot.phase, 'idle');
  assert.equal(h.controller.snapshot.cancelled, true);
  assert.equal(h.controller.snapshot.resultText, '');
  assert.equal(h.counts().insertions, 0);
  assert.ok(h.counts().disposals > 0);
});

test('provider write failure cancels capture, clears its PCM and prevents insertion', async t => {
  const h = harness('success', { write: async () => { throw Error('RECOGNITION_FAILED'); } });
  t.after(() => h.dispose());
  await h.controller.start();
  const pcm = Buffer.from([0x01, 0x02]);
  h.read.resolve({ streamId: 1, state: 'ended', reason: null, frameCount: 1, totalSamples: 1,
    frames: [{ streamId: 1, sequence: 1, samples: 1, pcm }] });
  await turn();
  assert.equal(h.controller.snapshot.phase, 'failed');
  assert.equal(h.controller.snapshot.resultText, '');
  assert.equal(h.counts().writes, 1);
  assert.equal(h.counts().insertions, 0);
  assert.deepEqual(pcm, Buffer.alloc(2));
  assert.ok(h.endCalls.includes(true));
  assert.ok(h.counts().disposals > 0);
});

test('provider finish failure disposes the stream and preserves the no-insertion boundary', async t => {
  const h = harness('success', { finish: async () => { throw Error('RECOGNITION_FAILED'); } });
  t.after(() => h.dispose());
  await h.controller.start();
  await h.controller.stop();
  assert.equal(h.controller.snapshot.phase, 'failed');
  assert.equal(h.controller.snapshot.resultText, '');
  assert.equal(h.counts().finishes, 1);
  assert.equal(h.counts().insertions, 0);
  assert.ok(h.counts().disposals > 0);
});
