import type { DictionaryEntry } from '../shared/product';
const marker = '<!-- txchat-dictionary-schema: 1 -->';
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const length = (value: string) => [...graphemes.segment(value)].length;
export function validateDictionary(entries: DictionaryEntry[]) {
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error('DICTIONARY_LIMIT');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'correct,enabled,wrong' || typeof entry.wrong !== 'string' || typeof entry.correct !== 'string' || typeof entry.enabled !== 'boolean' ||
      !entry.wrong || !entry.correct || entry.wrong.length > 4096 || entry.correct.length > 4096 || entry.wrong.normalize('NFC') === entry.correct.normalize('NFC') || length(entry.wrong) > 100 || length(entry.correct) > 100 ||
      /[\r\n\u000B\u000C\u0085\u2028\u2029\0]/u.test(entry.wrong + entry.correct)) throw new Error('DICTIONARY_INVALID_ENTRY');
    // Canonically equivalent originals must not create duplicate rules.
    const key = entry.wrong.normalize('NFC');
    if (seen.has(key)) throw new Error('DICTIONARY_DUPLICATE'); seen.add(key);
  }
}
export function encodeDictionary(entries: DictionaryEntry[]) {
  validateDictionary(entries);
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const text = [marker, '', '| wrong | correct | enabled |', '| --- | --- | --- |',
    ...entries.map((e) => `| ${escape(e.wrong)} | ${escape(e.correct)} | ${e.enabled} |`), ''].join('\n');
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('DICTIONARY_LIMIT'); return text;
}
function columns(line: string): string[] | null {
  const trimmed = line.trim(); if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const result: string[] = []; let current = '', escaped = false;
  const add = () => { result.push(current.replace(/^ /, '').replace(/ $/, '')); current = ''; };
  for (const ch of trimmed.slice(1, -1)) {
    if (escaped) { current += ch === '|' || ch === '\\' ? ch : `\\${ch}`; escaped = false; }
    else if (ch === '\\') escaped = true;
    else if (ch === '|') add(); else current += ch;
  }
  if (escaped) current += '\\'; add(); return result;
}
export function decodeDictionary(bytes: Uint8Array): { entries: DictionaryEntry[]; skippedLines: number } {
  if (bytes.length > 1_048_576) throw new Error('DICTIONARY_LIMIT');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
  catch { throw new Error('DICTIONARY_ENCODING'); }
  const lines = text.split(/\r\n|[\r\n\u000B\u000C\u0085\u2028\u2029]/u);
  if (lines.find((l) => l.trim().startsWith('<!-- txchat-dictionary-schema:'))?.trim() !== marker) throw new Error('DICTIONARY_SCHEMA');
  const index = lines.findIndex((line) => columns(line)?.map((s) => s.trim()).join(',') === 'wrong,correct,enabled');
  if (index < 0 || columns(lines[index + 1] ?? '')?.map((s) => s.trim()).join(',') !== '---,---,---') throw new Error('DICTIONARY_FORMAT');
  const entries: DictionaryEntry[] = []; let skippedLines = 0; const seen = new Set<string>();
  for (const line of lines.slice(index + 2)) {
    if (!line.trim() || line.trim().startsWith('<!--')) continue;
    const cells = columns(line);
    if (!cells || cells.length !== 3 || !['true', 'false'].includes(cells[2])) { skippedLines++; continue; }
    const entry = { wrong: cells[0], correct: cells[1], enabled: cells[2] === 'true' };
    try { validateDictionary([entry]); if (seen.has(entry.wrong.normalize('NFC')) || entries.length >= 1000) throw new Error(); }
    catch { skippedLines++; continue; }
    entries.push(entry); seen.add(entry.wrong.normalize('NFC'));
  }
  return { entries, skippedLines };
}
/** Longest scalar match, left-to-right; replacements are never re-scanned. */
export function replaceDictionary(text: string, entries: DictionaryEntry[]) {
  interface Node { children: Map<string, Node>; replacement?: string }
  const root: Node = { children: new Map() };
  for (const e of entries.filter((e) => e.enabled)) {
    let node = root;
    for (const scalar of e.wrong) { if (!node.children.has(scalar)) node.children.set(scalar, { children: new Map() }); node = node.children.get(scalar)!; }
    node.replacement ??= e.correct;
  }
  const source = [...text]; let result = '';
  for (let i = 0; i < source.length;) {
    let node = root, end = i, replacement: string | undefined;
    for (let j = i; j < source.length; j++) {
      const next = node.children.get(source[j]); if (!next) break; node = next;
      if (node.replacement !== undefined) { end = j + 1; replacement = node.replacement; }
    }
    if (replacement !== undefined) { result += replacement; i = end; } else result += source[i++];
  }
  return result;
}
