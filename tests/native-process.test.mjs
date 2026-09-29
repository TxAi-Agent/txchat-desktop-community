import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = process.env.TXCHAT_COMMUNITY_NATIVE_HELPER ?? path.join(root, '.build', 'native',
  `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'TxChat.NativeHost.exe' : 'txchat-native-host');
const expectedPlatform = process.env.TXCHAT_COMMUNITY_NATIVE_EXPECT_PLATFORM ?? process.platform;
const expectedArch = process.env.TXCHAT_COMMUNITY_NATIVE_EXPECT_ARCH ?? process.arch;
const request = (id = 'test_1', method = 'hello', v = 1) => ({ v, id, method });

function frame(value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}

function decode(data) {
  const messages = [];
  while (data.length) {
    assert.ok(data.length >= 4, 'response must contain a full header');
    const size = data.readUInt32BE(0);
    assert.ok(size > 0 && size <= 65_536, 'response must stay within the frame bound');
    assert.ok(data.length >= size + 4, 'response must contain a full payload');
    messages.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(4, size + 4))));
    data = data.subarray(size + 4);
  }
  return messages;
}

async function run(chunks = [], { fragment = false } = {}) {
  assert.ok(existsSync(helper), `Native helper must be built before integration tests: ${helper}`);
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native helper failed to finish within 8 seconds'));
    }, 8_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    // Rejections intentionally close stdin before the test can finish its writes.
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.stdout.on('data', (data) => stdout.push(data));
    child.stderr.on('data', (data) => stderr.push(data));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    void (async () => {
      for (const chunk of chunks) {
        if (child.stdin.destroyed) break;
        child.stdin.write(chunk);
        if (fragment) await new Promise((done) => setTimeout(done, 2));
      }
      child.stdin.end();
    })().catch(reject);
  });
}

function assertClean(result) {
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return decode(result.stdout);
}

function assertHello(message, id) {
  assert.deepEqual(Object.keys(message).sort(), ['id', 'ok', 'result', 'v']);
  assert.equal(message.v, 1);
  assert.equal(message.id, id);
  assert.equal(message.ok, true);
  const { instanceId, ...properties } = message.result;
  assert.match(instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.deepEqual(properties, {
    protocolVersion: 1, helperVersion: '0.1.0', platform: expectedPlatform, arch: expectedArch,
    capabilities: { handshake: true, hotkey: true, audio: true, insertion: true },
  });
}

test('hello reports exact capability boundary and actual process architecture', async () => {
  const messages = assertClean(await run([frame(request())]));
  assert.equal(messages.length, 1);
  assertHello(messages[0], 'test_1');
});

test('audio status is inert and cancellation of an unknown stream is rejected', async () => {
  const messages = assertClean(await run([frame(request('status', 'audioStatus')),
    frame({ ...request('cancel', 'cancelAudio'), params: { streamId: 1 } })]));
  assert.equal(messages.length, 2); assert.equal(messages[0].ok, true);
  assert.deepEqual(Object.keys(messages[0].result).sort(), ['active', 'permission', 'reason']);
  const { active, permission, reason } = messages[0].result;
  assert.equal(active, false);
  assert.ok(['granted', 'denied', 'restricted', 'notDetermined', 'systemManaged'].includes(permission));
  // Windows reports an existing OS access denial without opening the microphone.
  const accessDenied = process.platform === 'win32' && ['denied', 'restricted'].includes(permission);
  assert.equal(reason, accessDenied ? 'AUDIO_PERMISSION_REQUIRED' : null);
  assert.deepEqual(messages[1], { v: 1, id: 'cancel', ok: false, error: 'AUDIO_INVALID_STATE' });
});

test('fragmented header and body are reassembled', async () => {
  const data = frame(request('fragmented'));
  const messages = assertClean(await run([...data].map((byte) => Buffer.from([byte])), { fragment: true }));
  assertHello(messages[0], 'fragmented');
});

test('concatenated requests retain instance identity and ordered responses', async () => {
  const messages = assertClean(await run([Buffer.concat([
    frame(request('first')), frame(request('health', 'ping')), frame(request('second')),
  ])]));
  assert.equal(messages.length, 3);
  assertHello(messages[0], 'first');
  assert.deepEqual(messages[1], { v: 1, id: 'health', ok: true, result: { alive: true } });
  assertHello(messages[2], 'second');
  assert.equal(messages[0].result.instanceId, messages[2].result.instanceId);
});

test('new helper instance gets a new identity', async () => {
  const first = assertClean(await run([frame(request())]))[0];
  const second = assertClean(await run([frame(request())]))[0];
  assert.notEqual(first.result.instanceId, second.result.instanceId);
});

test('shutdown acknowledges once then exits even with trailing requests', async () => {
  const messages = assertClean(await run([Buffer.concat([frame(request('bye', 'shutdown')), frame(request())])]));
  assert.deepEqual(messages, [{ v: 1, id: 'bye', ok: true, result: { stopping: true } }]);
});

test('EOF at a frame boundary exits cleanly without unsolicited output', async () => {
  assert.deepEqual(assertClean(await run()), []);
});

test('well-shaped version and method errors do not terminate the pipe', async () => {
  const messages = assertClean(await run([Buffer.concat([
    frame(request('version', 'hello', 2)), frame(request('method', 'missing')),
    frame(request('still_alive', 'ping')),
  ])]));
  assert.deepEqual(messages, [
    { v: 1, id: 'version', ok: false, error: 'PROTOCOL_MISMATCH' },
    { v: 1, id: 'method', ok: false, error: 'UNSUPPORTED_METHOD' },
    { v: 1, id: 'still_alive', ok: true, result: { alive: true } },
  ]);
});

test('accepts maximum frame size and maximum safe ID length', async () => {
  const json = JSON.stringify(request('x'.repeat(64), 'ping'));
  const messages = assertClean(await run([frame(json.padEnd(65_536, ' '))]));
  assert.deepEqual(messages, [{ v: 1, id: 'x'.repeat(64), ok: true, result: { alive: true } }]);
});

const invalidCases = [
  ['partial header EOF', Buffer.from([0, 0, 0])],
  ['partial payload EOF', frame(request()).subarray(0, 10)],
  ['zero length', Buffer.alloc(4)],
  ['oversized length before body allocation', Buffer.from([0, 1, 0, 1])],
  ['maximum uint32 length', Buffer.from([255, 255, 255, 255])],
  ['invalid UTF8', frame(Buffer.from([0xff, 0xfe]))],
  ['overlong UTF8', frame(Buffer.from([0xc0, 0xaf]))],
  ['malformed JSON', frame('{"v":1,')],
  ['trailing comma JSON', frame('{"v":1,"id":"test","method":"hello",}')],
  ['rounded fractional version', frame('{"v":1.0000000000000001,"id":"test","method":"hello"}')],
  ['decimal version spelling', frame('{"v":1.0,"id":"test","method":"hello"}')],
  ['exponent version spelling', frame('{"v":1e0,"id":"test","method":"hello"}')],
  ['trailing non-whitespace JSON', frame(JSON.stringify(request()) + '{}')],
  ['non-object JSON', frame('[]')],
  ['null JSON', frame('null')],
  ['extra field', frame({ ...request(), secret: 'DO_NOT_ECHO_TEST_SECRET' })],
  ['duplicate field', frame('{"v":1,"id":"a","id":"b","method":"hello"}')],
  ['escaped duplicate field', frame('{"v":1,"id":"a","\\u0069d":"b","method":"hello"}')],
  ['missing field', frame({ v: 1, id: 'missing' })],
  ['empty ID', frame(request(''))],
  ['oversized ID', frame(request('a'.repeat(65)))],
  ['unsafe ID', frame(request('DO_NOT_ECHO_TEST_SECRET\n'))],
  ['non-ASCII ID', frame(request('中文'))],
  ['non-string ID', frame(request(1))],
  ['boolean version', frame(request('bool', 'hello', true))],
  ['string version', frame(request('string', 'hello', '1'))],
  ['fractional version', frame(request('fractional', 'hello', 1.5))],
  ['null method', frame(request('null_method', null))],
  ['object method', frame(request('object_method', {}))],
];

for (const [name, input] of invalidCases) {
  test(`rejects ${name} without echoing payloads`, async () => {
    const result = await run([input]);
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr, /^[A-Z_]+\r?\n$/);
    assert.ok(!result.stderr.includes('DO_NOT_ECHO_TEST_SECRET'));
  });
}

test('audio preflight accepts the parameterized envelope and rejects an invalid stream', async () => {
  const messages = assertClean(await run([frame({ ...request('preflight', 'preflightAudio'), params: { streamId: 0 } })]));
  assert.deepEqual(messages, [{ v: 1, id: 'preflight', ok: false, error: 'INVALID_ARGUMENTS' }]);
});
