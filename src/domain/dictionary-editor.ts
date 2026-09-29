import type { DictionaryEntry } from '../shared/product';
export type DictionaryEditorError = 'wrongEmpty' | 'correctEmpty' | 'equal' | 'tooLong' | 'lineBreak' | 'duplicate' | 'limit';
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
/** Validate raw rule content; NFC is for equality only, never a storage transform. */
export function dictionaryEditorError(entry: DictionaryEntry, entries: DictionaryEntry[], index: number | null): DictionaryEditorError | null {
  if (!entry.wrong) return 'wrongEmpty';
  if (!entry.correct) return 'correctEmpty';
  if (entry.wrong.normalize('NFC') === entry.correct.normalize('NFC')) return 'equal';
  if (entry.wrong.length > 4096 || entry.correct.length > 4096 || [...graphemes.segment(entry.wrong)].length > 100 || [...graphemes.segment(entry.correct)].length > 100) return 'tooLong';
  if (/[\r\n\u000B\u000C\u0085\u2028\u2029\0]/u.test(entry.wrong + entry.correct)) return 'lineBreak';
  if (entries.some((other, i) => i !== index && other.wrong.normalize('NFC') === entry.wrong.normalize('NFC'))) return 'duplicate';
  if (index === null && entries.length >= 1000) return 'limit';
  return null;
}
