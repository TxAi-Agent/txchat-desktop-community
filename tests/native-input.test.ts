import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseConfigureInput, parseHotkeyEvent, parseInputStatus, parseInsertion } from '../src/shared/native-input';
import { parseShortcutBinding } from '../src/shared/shortcut-bindings';
import { shortcutFromKey } from '../src/shared/shortcut-editor';

test('input contracts reject unknown fields and inconsistent target authorization', () => {
  const status = { accessibility: 'granted', inputMonitoring: 'granted', enabled: false,
    binding: 'ctrl-alt-space', generation: 0, reason: null };
  assert.deepEqual(parseInputStatus(status), status);
  for (const bad of [{ ...status, enabled: true }, { ...status, generation: 2 ** 31 },
    { ...status, reason: 'untrusted diagnostic' }, { ...status, rawKeys: [] }]) assert.throws(() => parseInputStatus(bad));
  const activation = { v: 1, event: 'hotkey', instanceId: randomUUID(), sequence: 2, generation: 1,
    phase: 'activated', targetId: randomUUID(), reason: null };
  assert.deepEqual(parseHotkeyEvent(activation), activation);
  for (const bad of [{ ...activation, sequence: 0 }, { ...activation, targetId: 'pid:123' },
    { ...activation, phase: 'pressed' }, { ...activation, phase: 'released' },
    { ...activation, targetId: null }, { ...activation, reason: 'TARGET_CHANGED' }]) assert.throws(() => parseHotkeyEvent(bad));
  const configuration = { enabled: true, binding: 'ctrl-alt-space', generation: 1, excludedPids: [process.pid] };
  assert.deepEqual(parseConfigureInput(configuration), configuration);
  for (const bad of [{ ...configuration, excludedPids: [] }, { ...configuration, generation: 0 },
    { ...configuration, excludedPids: [-1] }, { ...configuration, executable: 'other' }]) assert.throws(() => parseConfigureInput(bad));
});

test('delivery acknowledgement preserves clipboard warnings without enabling retries', () => {
  const delivered = { outcome: 'submitted', reason: null, warning: 'PASTEBOARD_RESTORE_FAILED' };
  assert.deepEqual(parseInsertion(delivered), delivered);
  assert.throws(() => parseInsertion({ outcome: 'submitted', reason: 'DELIVERY_UNCONFIRMED' }));
  assert.throws(() => parseInsertion({ ...delivered, warning: 'arbitrary message' }));
  assert.deepEqual(parseInsertion({ outcome: 'partialOrUnknown', reason: 'DELIVERY_UNCONFIRMED' }),
    { outcome: 'partialOrUnknown', reason: 'DELIVERY_UNCONFIRMED' });
});

test('physical-key bindings respect platform support and reject unsafe bare keys', () => {
  assert.equal(parseShortcutBinding('fn', 'win32'), null);
  assert.equal(parseShortcutBinding('key::F8', 'darwin'), null);
  assert.ok(parseShortcutBinding('key::F8', 'win32'));
  for (const binding of ['key::KeyA', 'key:shift:KeyA', 'key:ctrl+ctrl:KeyA', 'key:meta+ctrl:KeyA']) {
    assert.equal(parseShortcutBinding(binding), null);
  }
  const input = { type: 'keyDown', code: 'KeyA', key: 'a', isAutoRepeat: false,
    control: false, alt: false, shift: false, meta: false };
  assert.equal(shortcutFromKey(input, 'darwin')?.phase, 'unavailable');
  assert.equal(shortcutFromKey({ ...input, control: true }, 'darwin')?.candidate, 'key:ctrl:KeyA');
  assert.equal(shortcutFromKey({ ...input, control: true, isAutoRepeat: true }, 'darwin'), null);
});
