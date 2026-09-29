import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNativeDisplay } from '../src/shared/native-display';

test('private display geometry permits negative virtual-screen origins and no current screen', () => {
  assert.equal(parseNativeDisplay({ bounds: null }), null);
  const bounds = { x: -3840, y: -1080, width: 3840, height: 2160 };
  assert.deepEqual(parseNativeDisplay({ bounds }), bounds);
});
test('display response rejects wrong units metadata, arbitrary window data and unbounded geometry', () => {
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  for (const value of [{ bounds, windowTitle: 'private' }, { bounds: { ...bounds, scale: 2 } },
    { bounds: { ...bounds, x: NaN } }, { bounds: { ...bounds, width: 0 } },
    { bounds: { ...bounds, height: 1.5 } }, { bounds: { ...bounds, y: -1_000_001 } }]) {
    assert.throws(() => parseNativeDisplay(value), /INVALID_DISPLAY_RESULT/);
  }
});
