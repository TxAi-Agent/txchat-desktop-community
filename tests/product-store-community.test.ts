import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProductStore, type Cipher } from '../src/main/product-store';
import { ASR_PROVIDERS } from '../src/shared/custom-ai';

function cipher(): Cipher {
  const key = randomBytes(32);
  return {
    available: () => true,
    encrypt(text) {
      const iv = randomBytes(12), encryption = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([encryption.update(text, 'utf8'), encryption.final()]);
      return Buffer.concat([iv, encryption.getAuthTag(), data]);
    },
    decrypt(bytes) {
      const decryption = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decryption.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decryption.update(bytes.subarray(28)), decryption.final()]).toString('utf8');
    },
  };
}

test('local preferences and encrypted provider fields survive restart without plaintext credential files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'community-product-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const protection = cipher(), store = new ProductStore(root, protection);
  assert.deepEqual(await store.load(), []);
  const provider = ASR_PROVIDERS[0], generatedCredential = randomUUID().repeat(100);
  await store.updateSettings(value => { value.preferences.language = 'en'; value.preferences.service = 'custom'; });
  await store.updateVault(value => {
    value.providers.asr[provider.id] = { providerId: provider.id, modelId: provider.models[0].id,
      values: { endpoint: 'https://provider.invalid/configured-operation', 'api-key': generatedCredential } };
    value.selected.asr = provider.id;
  });
  const encrypted = await readFile(path.join(root, 'credentials.enc'));
  assert.equal(encrypted.includes(Buffer.from(generatedCredential)), false);
  const settings = await readFile(path.join(root, 'settings.json'), 'utf8');
  assert.equal(settings.includes(generatedCredential), false);
  const restored = new ProductStore(root, protection);
  assert.deepEqual(await restored.load(), []);
  assert.equal(restored.preferences.language, 'en');
  assert.equal(restored.secrets.providers.asr[provider.id].values['api-key'], generatedCredential);
  const exported = restored.secrets; exported.providers.asr[provider.id].values['api-key'] = 'changed';
  assert.equal(restored.secrets.providers.asr[provider.id].values['api-key'], generatedCredential);
});

test('unreadable encrypted provider data is preserved instead of being silently replaced', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'community-product-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const damaged = Buffer.from('deliberately invalid synthetic encrypted data');
  await writeFile(path.join(root, 'credentials.enc'), damaged);
  const store = new ProductStore(root, cipher());
  assert.ok((await store.load()).includes('SECURE_STORAGE_READ_FAILED'));
  await assert.rejects(store.updateVault(() => {}), /SECURE_STORAGE_UNAVAILABLE/);
  assert.deepEqual(await readFile(path.join(root, 'credentials.enc')), damaged);
});
