import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CloudClient, CloudError } from '../src/adapters/cloud/client';
import { createServiceAdapter, type ServiceAdapter, type SessionBundle } from '../src/adapters/services/integration';
import { AuthCoordinator } from '../src/main/auth-coordinator';
import type { ProductStore } from '../src/main/product-store';

// Generated opaque values exercise domain contracts; no account or service is contacted.
const signal = () => new AbortController().signal;
const unavailable = async (): Promise<never> => { throw new CloudError('SERVICE_UNAVAILABLE'); };
function adapter(overrides: Partial<ServiceAdapter> = {}): ServiceAdapter {
  return { scope: 'unit-adapter', requestSMS: unavailable, verifySMS: unavailable, refresh: unavailable,
    account: unavailable, accountContext: unavailable, logout: unavailable, offer: unavailable, status: unavailable,
    currentOrder: unavailable, createOrder: unavailable, order: unavailable, recoverOrder: unavailable,
    reportDiagnostics: unavailable, ...overrides };
}
function bundle(): SessionBundle {
  return { access: { accessToken: randomUUID(), accessExpiresInSeconds: 43, deviceId: randomUUID(), sessionId: randomUUID() },
    refresh: { refreshToken: randomUUID(), refreshSlidingExpiresInSeconds: 7123 } };
}
const isCode = (code: string) => (error: unknown) => error instanceof CloudError && error.code === code;

test('every unconfigured service method fails explicitly without a synthetic account', async () => {
  assert.equal(createServiceAdapter(), null);
  const client = new CloudClient(createServiceAdapter());
  assert.equal(client.origin, null);
  for (const operation of [() => client.requestSMS('', signal()), () => client.verifySMS('', '', signal()),
    () => client.refresh('', '', signal()), () => client.account('', signal()), () => client.accountContext('', signal()),
    () => client.logout('', signal()), () => client.offer('', signal()), () => client.status('', signal()),
    () => client.currentOrder('', signal()), () => client.createOrder('', '', signal()), () => client.order('', '', signal()),
    () => client.recoverOrder('', '', '', signal()), () => client.diagnostic({}, signal()), () => client.reportDiagnostics({}, signal())]) {
    await assert.rejects(operation, isCode('CLOUD_NOT_CONFIGURED'));
  }
});

test('refresh accepts adapter-selected lifetimes and projects only client domain fields', async () => {
  const expected = bundle();
  const client = new CloudClient(adapter({ refresh: async () => ({ ...expected, transportDetails: 'not exposed' }) }));
  assert.deepEqual(await client.refresh(randomUUID(), randomUUID(), signal()), expected);
  const invalid = new CloudClient(adapter({ refresh: async () => ({ ...expected,
    access: { ...expected.access, accessExpiresInSeconds: Number.NaN } }) }));
  await assert.rejects(() => invalid.refresh('', '', signal()), isCode('PROTOCOL_ERROR'));
});

test('access recovery retries one time with the recovered token and never retries logout', async () => {
  const access = randomUUID(), replacement = randomUUID();
  const seen: string[] = []; let recovery = 0, logouts = 0;
  const client = new CloudClient(adapter({ accountContext: async value => {
    seen.push(value); if (seen.length === 1) throw new CloudError('SESSION_EXPIRED'); return randomUUID();
  }, logout: async () => { logouts++; throw new CloudError('SESSION_EXPIRED'); } }));
  client.setAccessRecovery(async rejected => { assert.equal(rejected, access); recovery++; return replacement; });
  await client.accountContext(access, signal());
  assert.deepEqual(seen, [access, replacement]); assert.equal(recovery, 1);
  await assert.rejects(() => client.logout(access, signal()), isCode('SESSION_EXPIRED'));
  assert.equal(logouts, 1); assert.equal(recovery, 1);
  let calls = 0;
  const rejected = new CloudClient(adapter({ accountContext: async () => { calls++; throw new CloudError('AUTH_REQUIRED'); } }));
  rejected.setAccessRecovery(async () => replacement);
  await assert.rejects(() => rejected.accountContext(access, signal()), isCode('AUTH_REQUIRED'));
  assert.equal(calls, 2);
});

test('cancellation discards results returned by an adapter that ignored abort', async () => {
  const controller = new AbortController();
  let finish!: (value: string) => void;
  const client = new CloudClient(adapter({ accountContext: () => new Promise(resolve => { finish = resolve; }) }));
  const request = client.accountContext(randomUUID(), controller.signal);
  controller.abort(); finish(randomUUID());
  await assert.rejects(request, isCode('CANCELLED'));
});

test('unknown adapter failures and error reasons never expose arbitrary messages', async () => {
  const client = new CloudClient(adapter({ currentOrder: async () => { throw Error('adapter implementation detail'); } }));
  await assert.rejects(() => client.currentOrder(randomUUID(), signal()), isCode('SERVICE_UNAVAILABLE'));
  assert.deepEqual(new CloudError('adapter implementation detail', Infinity, 'unrecognized reason', -1).publicError,
    { code: 'OPERATION_FAILED' });
  assert.equal(new CloudError('TOO_MANY_REQUESTS', Infinity).retryAfterSeconds, 0);
});

test('billing uses an adapter-provided product identifier and validates money', async () => {
  const value = { productId: randomUUID(), displayName: 'Configurable plan', amountFen: 1, currency: 'CNY' as const,
    includedDurationMs: 1, purchasable: true };
  const client = new CloudClient(adapter({ offer: async () => value }));
  assert.deepEqual(await client.offer(randomUUID(), signal()), value);
  const invalid = new CloudClient(adapter({ offer: async () => ({ ...value, amountFen: -1 }) }));
  await assert.rejects(() => invalid.offer(randomUUID(), signal()), isCode('PROTOCOL_ERROR'));
});

test('diagnostic receipts are opaque domain values with no deployment-specific ID format', async () => {
  const receipt = { diagnosticNumber: randomUUID(), reportId: randomUUID(), receivedAt: new Date().toISOString() };
  const client = new CloudClient(adapter({ reportDiagnostics: async () => receipt }));
  assert.deepEqual(await client.reportDiagnostics({}, signal()), receipt);
  assert.deepEqual(await client.diagnostic({}, signal()), receipt);
});

test('service scope cannot be an endpoint or contain account-key delimiters', () => {
  assert.throws(() => new CloudClient(adapter({ scope: 'invalid/scope' })), isCode('CLOUD_CONFIGURATION_INVALID'));
  assert.throws(() => new CloudClient(adapter({ scope: 'invalid|scope' })), isCode('CLOUD_CONFIGURATION_INVALID'));
});

test('local development mode has no signed-in account, masked identity or service token', async t => {
  let cleared = 0;
  const store = { clearSession: async () => { cleared++; }, secrets: { session: null } } as unknown as ProductStore;
  const auth = new AuthCoordinator(new CloudClient(null), store, () => {}, () => {});
  t.after(() => auth.dispose());
  await auth.enterDemo();
  assert.equal(auth.snapshot.demo, true);
  assert.equal(auth.snapshot.signedIn, false);
  assert.equal(auth.snapshot.maskedPhone, null);
  assert.equal(auth.accountKey, 'local-development');
  await assert.rejects(() => auth.access(), isCode('AUTH_REQUIRED'));
  await auth.enterDemo();
  assert.equal(cleared, 1);
  await auth.logout();
  assert.equal(auth.snapshot.demo, false);
  assert.equal(auth.snapshot.signedIn, false);
  assert.equal(auth.accountKey, null);
});
