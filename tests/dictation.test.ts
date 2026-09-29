import assert from 'node:assert/strict';
import test from 'node:test';
import { DictationController, type InsertionOutcome, type SessionEvents, type SessionPort } from '../src/domain/dictation';
import type { Phase, Scenario } from '../src/shared/contracts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function session(overrides: Partial<SessionPort> = {}) {
  const state = { starts: 0, finishes: 0, disposals: 0, writes: [] as { text: string; id: string }[],
    partial: (_text: string) => {}, events: undefined as SessionEvents | undefined, signal: undefined as AbortSignal | undefined };
  const port: SessionPort = {
    async start(partial, signal, events) { state.starts++; state.partial = partial; state.events = events; state.signal = signal; await overrides.start?.(partial, signal, events); },
    async finish(organizing, signal) { state.finishes++; if (overrides.finish) return overrides.finish(organizing, signal); organizing(); return 'Example result'; },
    async insert(text, id, signal) { state.writes.push({ text, id }); return overrides.insert ? overrides.insert(text, id, signal) : 'inserted'; },
    dispose() { state.disposals++; overrides.dispose?.(); },
  };
  return { state, port };
}

test('normal session publishes ordered phases and inserts once', async () => {
  const { port, state } = session();
  const controller = new DictationController(() => port);
  const phases: Phase[] = [];
  controller.subscribe(snapshot => phases.push(snapshot.phase));
  await controller.start(); state.partial('Example');
  assert.equal(controller.snapshot.canStop, true);
  await Promise.all([controller.stop(), controller.stop()]);
  assert.deepEqual(phases, ['starting', 'listening', 'listening', 'finalizing', 'organizing', 'inserting', 'completed']);
  assert.deepEqual(state.writes, [{ text: 'Example result', id: 'session-1-write-1' }]);
  assert.equal(state.finishes, 1);
  assert.equal(state.disposals, 1);
  assert.equal(state.signal?.aborted, true);
  assert.equal(controller.snapshot.resultText, 'Example result');
  assert.equal(controller.snapshot.canStart, true);
});

test('duplicate start cannot create a concurrent session', async () => {
  const gate = deferred<void>();
  const { port, state } = session({ start: () => gate.promise });
  const controller = new DictationController(() => port);
  const start = controller.start(); await controller.start();
  assert.equal(state.starts, 1);
  assert.equal(controller.snapshot.phase, 'starting');
  gate.resolve(); await start; controller.cancel();
});

test('cancel during start invalidates late partials and completion', async () => {
  const gate = deferred<void>();
  const { port, state } = session({ start: () => gate.promise });
  const controller = new DictationController(() => port);
  const start = controller.start(); controller.cancel();
  state.partial('late partial'); gate.resolve(); await start;
  assert.equal(controller.snapshot.phase, 'idle');
  assert.equal(controller.snapshot.cancelled, true);
  assert.equal(controller.snapshot.partialText, '');
  assert.equal(state.signal?.aborted, true);
  assert.equal(state.disposals, 1);
  assert.equal(state.writes.length, 0);
});

test('cancel during finalization drops a delayed result without insertion', async () => {
  const gate = deferred<string>();
  const { port, state } = session({ finish: () => gate.promise });
  const controller = new DictationController(() => port);
  await controller.start(); const stop = controller.stop(); controller.cancel();
  gate.resolve('late result'); await stop;
  assert.equal(controller.snapshot.phase, 'idle');
  assert.equal(controller.snapshot.resultText, '');
  assert.equal(state.writes.length, 0);
  assert.equal(state.disposals, 1);
});

test('events from an old session cannot disturb a new session', async () => {
  const first = session(), second = session();
  let count = 0;
  const controller = new DictationController(() => count++ === 0 ? first.port : second.port);
  await controller.start(); controller.cancel(); await controller.start();
  first.state.partial('stale'); first.state.events?.failed(new Error('late failure')); first.state.events?.ended();
  assert.equal(controller.snapshot.phase, 'listening');
  assert.equal(controller.snapshot.partialText, '');
  assert.equal(second.state.finishes, 0);
  controller.cancel();
});

test('insertion rejection and uncertain delivery retain text and require dismissal', async () => {
  for (const outcome of ['notInserted', 'partialOrUnknown'] as const) {
    const { port, state } = session({ insert: async () => outcome });
    const controller = new DictationController(() => port);
    await controller.start(); await controller.stop();
    assert.equal(controller.snapshot.phase, 'resultFallback');
    assert.equal(controller.snapshot.resultText, 'Example result');
    assert.equal(controller.snapshot.canStart, false);
    await controller.start(); await controller.stop(); controller.cancel();
    assert.equal(state.writes.length, 1);
    assert.equal(state.starts, 1);
    controller.dismiss();
    assert.equal(controller.snapshot.phase, 'idle');
    assert.equal(controller.snapshot.resultText, '');
  }
});

test('an insertion exception never triggers automatic replay or exposes its detail', async () => {
  const detail = 'deliberately-sensitive-diagnostic';
  const { port, state } = session({ insert: async () => { throw new Error(detail); } });
  const controller = new DictationController(() => port);
  await controller.start(); await controller.stop(); await controller.start();
  assert.equal(controller.snapshot.phase, 'resultFallback');
  assert.equal(controller.snapshot.failure, null);
  assert.equal(state.writes.length, 1);
  assert.equal(JSON.stringify(controller.snapshot).includes(detail), false);
});

test('cancel is disabled once insertion begins', async () => {
  const gate = deferred<InsertionOutcome>();
  const { port, state } = session({ insert: () => gate.promise });
  const controller = new DictationController(() => port);
  await controller.start(); const stop = controller.stop();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controller.snapshot.phase, 'inserting');
  assert.equal(controller.snapshot.canCancel, false);
  controller.cancel(); assert.equal(controller.snapshot.phase, 'inserting');
  gate.resolve('submitted'); await stop;
  assert.equal(controller.snapshot.phase, 'completed');
  assert.equal(state.writes.length, 1);
});

test('helper loss during insertion ignores a late success and retains uncertain result', async () => {
  const gate = deferred<InsertionOutcome>();
  const { port, state } = session({ insert: () => gate.promise });
  const controller = new DictationController(() => port);
  await controller.start(); const stop = controller.stop();
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.setAvailable(false); gate.resolve('inserted'); await stop;
  assert.equal(controller.snapshot.phase, 'resultFallback');
  assert.equal(controller.snapshot.resultText, 'Example result');
  controller.setAvailable(true); await controller.start();
  assert.equal(state.writes.length, 1);
  assert.equal(state.starts, 1);
});

test('no-speech completes quietly only when no text has already been received', async () => {
  const empty = session({ finish: async () => { throw new Error('NO_SPEECH'); } });
  const controller = new DictationController(() => empty.port);
  await controller.start(); await controller.stop();
  assert.equal(controller.snapshot.phase, 'completed');
  assert.equal(controller.snapshot.completion, 'no-speech');
  assert.equal(empty.state.writes.length, 0);
  const partial = session({ finish: async () => { throw new Error('NO_SPEECH'); } });
  const second = new DictationController(() => partial.port);
  await second.start(); partial.state.partial('already heard'); await second.stop();
  assert.equal(second.snapshot.phase, 'failed');
  assert.notEqual(second.snapshot.completion, 'no-speech');
});

test('empty and oversized final results fail before insertion', async () => {
  for (const text of ['  ', 'x'.repeat(32769)]) {
    const { port, state } = session({ finish: async () => text });
    const controller = new DictationController(() => port);
    await controller.start(); await controller.stop();
    assert.equal(controller.snapshot.phase, 'failed');
    assert.equal(state.writes.length, 0);
    assert.equal(state.disposals, 1);
  }
});

test('capture failure cleans up even when diagnostic reporting throws', async () => {
  const { port, state } = session({ start: async () => { throw new Error('capture detail'); } });
  const controller = new DictationController(() => port, () => { throw new Error('diagnostic detail'); });
  await controller.start();
  assert.equal(controller.snapshot.phase, 'failed');
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(state.disposals, 1);
  assert.equal(JSON.stringify(controller.snapshot).includes('detail'), false);
});

test('availability blocks new starts and interrupts active recognition', async () => {
  const { port, state } = session();
  const controller = new DictationController(() => port);
  controller.setAvailable(false); await controller.start();
  assert.equal(controller.snapshot.phase, 'unavailable');
  assert.equal(state.starts, 0);
  controller.setAvailable(true); await controller.start(); controller.setAvailable(false);
  assert.equal(controller.snapshot.phase, 'failed');
  assert.equal(state.signal?.aborted, true);
  assert.equal(state.writes.length, 0);
});

test('scenario changes are frozen during sessions and uncertain delivery', async () => {
  const scenarios: Scenario[] = [];
  const { port } = session({ insert: async () => 'partialOrUnknown' });
  const controller = new DictationController(scenario => { scenarios.push(scenario); return port; });
  controller.selectScenario('insertion-unknown'); await controller.start(); controller.selectScenario('success');
  await controller.stop(); controller.selectScenario('service-failure');
  assert.deepEqual(scenarios, ['insertion-unknown']);
  assert.equal(controller.snapshot.scenario, 'insertion-unknown');
  controller.dismiss(); controller.selectScenario('success');
  assert.equal(controller.snapshot.scenario, 'success');
});

test('dispose is idempotent and rejects all future late callbacks and starts', async () => {
  const { port, state } = session();
  const controller = new DictationController(() => port);
  await controller.start(); controller.dispose(); controller.dispose();
  state.partial('late'); state.events?.failed(new Error('late')); await controller.start();
  assert.equal(controller.snapshot.phase, 'unavailable');
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.partialText, '');
  assert.equal(state.starts, 1);
  assert.equal(state.disposals, 1);
});

test('an ended event during startup finalizes after startup completes', async () => {
  const gate = deferred<void>();
  const { port, state } = session({ start: () => gate.promise });
  const controller = new DictationController(() => port);
  const start = controller.start(); state.events?.ended();
  assert.equal(state.finishes, 0);
  gate.resolve(); await start;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(controller.snapshot.phase, 'completed');
  assert.equal(state.finishes, 1);
  assert.equal(state.writes.length, 1);
});

test('partial text limits preserve the last valid text and permit a maximum-size final', async () => {
  const maximum = 'x'.repeat(32768);
  const { port, state } = session({ finish: async () => maximum });
  const controller = new DictationController(() => port);
  await controller.start(); state.partial(maximum); state.partial(maximum + 'x');
  assert.equal(controller.snapshot.partialText, maximum);
  await controller.stop();
  assert.equal(controller.snapshot.phase, 'completed');
  assert.equal(state.writes[0]?.text, maximum);
});

test('a failure event during finalization invalidates a delayed successful result', async () => {
  const gate = deferred<string>();
  const { port, state } = session({ finish: () => gate.promise });
  const controller = new DictationController(() => port);
  await controller.start(); const stop = controller.stop();
  state.events?.failed(new Error('stream interrupted')); gate.resolve('late success'); await stop;
  assert.equal(controller.snapshot.phase, 'failed');
  assert.equal(state.writes.length, 0);
  assert.equal(state.disposals, 1);
});
