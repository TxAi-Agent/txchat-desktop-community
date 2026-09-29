import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceDictionary, validateDictionary } from '../src/domain/dictionary';
import type { DictionaryEntry } from '../src/shared/contracts';

const entry = (wrong: string, correct: string, enabled = true): DictionaryEntry => ({ wrong, correct, enabled });

test('an empty dictionary preserves input', () => {
  validateDictionary([]);
  assert.equal(replaceDictionary('A small example. 示例 👋', []), 'A small example. 示例 👋');
});

test('dictionary entry count permits 1000 and rejects 1001', () => {
  const entries = Array.from({ length: 1000 }, (_, index) => entry(`word-${index}`, 'replacement'));
  assert.doesNotThrow(() => validateDictionary(entries));
  assert.throws(() => validateDictionary([...entries, entry('extra', 'replacement')]), /DICTIONARY_LIMIT/);
});

test('phrase lengths use graphemes rather than UTF-16 code units', () => {
  const family = '👨‍👩‍👧‍👦';
  assert.doesNotThrow(() => validateDictionary([entry(family.repeat(100), 'family')]));
  assert.throws(() => validateDictionary([entry(family.repeat(101), 'family')]), /DICTIONARY_INVALID_ENTRY/);
  assert.throws(() => validateDictionary([entry('source', family.repeat(101))]), /DICTIONARY_INVALID_ENTRY/);
});

test('a single very large grapheme is limited by UTF-16 length', () => {
  assert.doesNotThrow(() => validateDictionary([entry('a' + '\u0301'.repeat(4095), 'replacement')]));
  assert.throws(() => validateDictionary([entry('a' + '\u0301'.repeat(4096), 'replacement')]), /DICTIONARY_INVALID_ENTRY/);
  assert.throws(() => validateDictionary([entry('source', 'a' + '\u0301'.repeat(4096))]), /DICTIONARY_INVALID_ENTRY/);
});

test('empty phrases and all forbidden line separators are rejected', () => {
  assert.throws(() => validateDictionary([entry('', 'replacement')]), /DICTIONARY_INVALID_ENTRY/);
  assert.throws(() => validateDictionary([entry('source', '')]), /DICTIONARY_INVALID_ENTRY/);
  for (const separator of ['\r', '\n', '\u000B', '\u000C', '\u0085', '\u2028', '\u2029', '\0']) {
    assert.throws(() => validateDictionary([entry(`a${separator}b`, 'replacement')]), /DICTIONARY_INVALID_ENTRY/);
    assert.throws(() => validateDictionary([entry('source', `a${separator}b`)]), /DICTIONARY_INVALID_ENTRY/);
  }
});

test('canonically equivalent original and replacement phrases are rejected', () => {
  assert.throws(() => validateDictionary([entry('é', 'e\u0301')]), /DICTIONARY_INVALID_ENTRY/);
  assert.throws(() => validateDictionary([entry('same', 'same')]), /DICTIONARY_INVALID_ENTRY/);
});

test('duplicate originals are compared using NFC even when disabled', () => {
  assert.throws(() => validateDictionary([entry('é', 'first'), entry('e\u0301', 'second', false)]), /DICTIONARY_DUPLICATE/);
});

test('case-distinct originals remain distinct', () => {
  const entries = [entry('Word', 'capital'), entry('word', 'lowercase')];
  validateDictionary(entries);
  assert.equal(replaceDictionary('Word word WORD', entries), 'capital lowercase WORD');
});

test('runtime validation rejects wrong field types and unknown data', () => {
  for (const candidate of [null, { wrong: 3, correct: 'b', enabled: true }, { wrong: 'a', correct: 'b', enabled: 'true' },
    { wrong: 'a', correct: 'b', enabled: true, extra: 'unexpected' }]) {
    assert.throws(() => validateDictionary([candidate as unknown as DictionaryEntry]), /DICTIONARY_INVALID_ENTRY/);
  }
});

test('disabled replacements do not mask enabled shorter matches', () => {
  const entries = [entry('cat', 'animal', false), entry('ca', 'prefix')];
  assert.equal(replaceDictionary('cat cat', entries), 'prefixt prefixt');
});

test('longest match wins at each position independent of dictionary order', () => {
  const entries = [entry('car', 'short'), entry('cart', 'long'), entry('art', 'other')];
  assert.equal(replaceDictionary('cart car', entries), 'long short');
  assert.equal(replaceDictionary('cart car', [...entries].reverse()), 'long short');
});

test('overlapping matches advance left to right without rescanning replacements', () => {
  assert.equal(replaceDictionary('ababa', [entry('aba', 'x'), entry('ba', 'y')]), 'xy');
  assert.equal(replaceDictionary('cat', [entry('cat', 'dog'), entry('dog', 'wolf')]), 'dog');
});

test('adjacent matches and unmatched supplementary scalars survive', () => {
  assert.equal(replaceDictionary('🚀猫猫🌙', [entry('猫', 'cat')]), '🚀catcat🌙');
  assert.equal(replaceDictionary('👩‍💻👩', [entry('👩‍💻', 'coder'), entry('👩', 'person')]), 'coderperson');
});

test('replacement matching preserves exact scalar spelling and spaces', () => {
  const entries = [entry('é', 'accent'), entry(' word ', ' spaced ')];
  assert.equal(replaceDictionary('é e\u0301 word ', entries), 'accent e\u0301 spaced ');
});
