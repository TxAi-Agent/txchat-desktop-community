import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ASR_PROVIDERS, OPTIMIZATION_PROVIDERS, validateProviderSelection } from '../src/shared/custom-ai';
import { buildASRRequest, buildOptimizationRequest, loadTestWav, transcribe } from '../src/adapters/custom-ai';
import { DemoRecognitionProvider, createRecognitionProvider } from '../src/adapters/recognition-provider';
import { ProviderAudioService } from '../src/adapters/product-recognition';
import { productStage } from '../src/domain/product-stage';

const selection = (kind: 'asr' | 'optimization') => {
  const provider = (kind === 'asr' ? ASR_PROVIDERS : OPTIMIZATION_PROVIDERS)[0];
  return { providerId: provider.id, modelId: provider.models[0].id,
    values: { endpoint: 'https://provider.invalid/configured-operation', 'api-key': randomUUID() } };
};

test('all provider choices require a user endpoint and reject embedded credentials or insecure URLs', () => {
  for (const provider of [...ASR_PROVIDERS, ...OPTIMIZATION_PROVIDERS]) {
    const field = provider.fields.find(value => value.id === 'endpoint');
    assert.equal(field?.required, true);
    assert.equal(field?.defaultValue, undefined);
  }
  const value = selection('asr');
  const credentialURL = new URL('https://provider.invalid/op'); credentialURL.username = randomUUID(); credentialURL.password = randomUUID();
  for (const endpoint of ['', 'http://provider.invalid/op', credentialURL.href, 'https://provider.invalid/op#fragment']) {
    assert.throws(() => validateProviderSelection('asr', { ...value, values: { ...value.values, endpoint } }));
  }
});

test('request construction preserves the exact configured endpoint instead of appending private routes', () => {
  const wav = loadTestWav();
  try {
    const asr = selection('asr');
    assert.equal(buildASRRequest(wav, asr).url, asr.values.endpoint);
    const optimization = selection('optimization');
    assert.equal(buildOptimizationRequest('Synthetic input.', optimization).url, optimization.values.endpoint);
    assert.equal(wav.subarray(44).every(byte => byte === 0), true);
  } finally { wav.fill(0); }
});

test('remote transport errors cannot reveal endpoint or credential details', async () => {
  const value = selection('asr');
  const wav = loadTestWav();
  try {
    await assert.rejects(transcribe(wav, value, async () => { throw new Error(value.values.endpoint + value.values['api-key']); }, new AbortController().signal),
      error => error instanceof Error && error.message === 'CUSTOM_AI_NETWORK');
  } finally { wav.fill(0); }
});

test('unconfigured recognition fails explicitly while demo recognition requires explicit selection', async () => {
  const options = { signal: new AbortController().signal, onPartial: () => {} };
  assert.throws(() => createRecognitionProvider().createStream(options), /RECOGNITION_NOT_CONFIGURED/);
  const demo = new DemoRecognitionProvider().createStream(options);
  assert.match(await demo.finish(), /simulated/);
  demo.dispose();
});

test('provider adapter treats an empty final result as no speech and suppresses late results after disposal', async () => {
  const empty = new ProviderAudioService({ createStream: () => ({ write: async () => {}, finish: async () => '', dispose() {} }) });
  await empty.start(() => {}, () => {}, new AbortController().signal);
  await assert.rejects(empty.finish(() => {}), /NO_SPEECH/);
  empty.dispose();
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(done => { resolve = done; });
  const late = new ProviderAudioService({ createStream: () => ({ write: async () => {}, finish: () => pending, dispose() {} }) });
  await late.start(() => {}, () => {}, new AbortController().signal);
  const finishing = late.finish(() => {});
  late.dispose(); resolve('Synthetic late result');
  await assert.rejects(finishing, /CANCELLED/);
});

test('local entry unlocks local product pages without inventing a signed-in account or requiring Cloud', () => {
  const state = { launching: false, cloudConfigured: false, interruption: false, signedIn: false, demo: false, onboardingCompleted: false };
  assert.equal(productStage(state), 'setup-unavailable');
  assert.equal(productStage({ ...state, demo: true }), 'ready');
});
