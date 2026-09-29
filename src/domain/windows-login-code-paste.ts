/** User-initiated paste only; never reads or watches the system clipboard. */
export function pastedVerificationCode(text: string): string | null {
  if (text.length > 16_384) return null;
  const trimmed = text.trim();
  if (/^[0-9]{6}$/.test(trimmed)) return trimmed;
  if (/^[0-9]{3}\s+[0-9]{3}$/.test(trimmed)) return trimmed.replace(/\s/g, '');
  // Keep phone numbers, longer identifiers and adjacent Latin letters out. Chinese
  // prose may touch a code directly. Two occurrences are ambiguous even if equal.
  const candidates = [...trimmed.matchAll(/(?<![A-Za-z\p{N}])([0-9]{6})(?![A-Za-z\p{N}])/gu)];
  return candidates.length === 1 ? candidates[0][1] : null;
}
