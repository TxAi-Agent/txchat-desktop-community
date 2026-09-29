import { exactObject } from './native-protocol';

/** Windows virtual-screen physical pixels, not Electron DIP. Main process only. */
export interface NativeDisplayBounds { x: number; y: number; width: number; height: number }
export function parseNativeDisplay(value: unknown): NativeDisplayBounds | null {
  if (!exactObject(value, ['bounds'])) throw new Error('INVALID_DISPLAY_RESULT');
  if (value.bounds === null) return null;
  const b = value.bounds;
  if (!exactObject(b, ['x', 'y', 'width', 'height']) ||
      ![b.x, b.y, b.width, b.height].every((part) => Number.isSafeInteger(part) && Math.abs(part as number) <= 1_000_000) ||
      (b.width as number) <= 0 || (b.height as number) <= 0) throw new Error('INVALID_DISPLAY_RESULT');
  return b as unknown as NativeDisplayBounds;
}
