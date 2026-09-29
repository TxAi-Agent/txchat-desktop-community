export function parseUpdateVersion(value: unknown): number[] | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value)) return null;
  return value.split('.').map(Number);
}
export function compareUpdateVersions(a: string, b: string) {
  const left = parseUpdateVersion(a), right = parseUpdateVersion(b);
  if (!left || !right) throw new Error('UPDATE_METADATA_INVALID');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
