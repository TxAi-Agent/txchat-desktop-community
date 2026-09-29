import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftwareUpdateCoordinator, type SoftwareUpdateBackend } from '../src/main/software-update-coordinator';

function updater(backend: SoftwareUpdateBackend | null) {
  return new SoftwareUpdateCoordinator({ currentVersion: '0.1.0', backend, publish() {}, dictationPhase: () => 'idle',
    loadSkippedVersion: () => null, saveSkippedVersion: async () => {}, prepareForInstall: async () => {}, quit: async () => {} });
}
test('manual update check displays missing integration while background checks stay quiet', async () => {
  const coordinator = updater(null);
  await coordinator.check(false);
  assert.equal(coordinator.snapshot.visible, false);
  await coordinator.check(true);
  assert.equal(coordinator.snapshot.phase, 'unavailable');
  assert.equal(coordinator.snapshot.visible, true);
  assert.equal(coordinator.snapshot.item, null);
  coordinator.close();
  assert.equal(coordinator.snapshot.visible, false);
  coordinator.dispose();
});
test('update backend errors expose only classified failure and release the busy state', async () => {
  let calls = 0;
  const coordinator = updater({ check: async () => { calls++; throw Error('PRIVATE_PROVIDER_ERROR'); }, download: async () => {}, install: async () => {}, dispose() {} });
  await coordinator.check();
  assert.equal(coordinator.snapshot.phase, 'failed');
  assert.ok(!JSON.stringify(coordinator.snapshot).includes('PRIVATE_PROVIDER_ERROR'));
  await coordinator.check();
  assert.equal(calls, 2);
  coordinator.dispose();
});
