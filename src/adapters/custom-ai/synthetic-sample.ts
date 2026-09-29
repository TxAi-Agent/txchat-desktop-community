import { buildWav } from './wav';
export const FIXED_OPTIMIZATION_TEST_TEXT = 'This is a synthetic configuration test. Preserve its meaning.';
/** Generated silence verifies transport handling, not speech-recognition accuracy. */
export function loadTestWav(): Buffer { return buildWav(Buffer.alloc(16_000 * 2)); }
