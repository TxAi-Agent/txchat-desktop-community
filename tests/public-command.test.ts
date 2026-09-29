import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/main/command-policy';
test('commands reject extra fields and unsupported types', () => {
  assert.equal(parseCommand({type:'start'}).type, 'start');
  for (const value of [null, [], {type:'start', path:'extra'}, {type:'open-file'}, {type:'native-enable',binding:'unsupported'}]) assert.throws(() => parseCommand(value));
});
test('dictionary commands validate content and return an independent value', () => {
  const input={type:'dictionary-save', entries:[{wrong:'alpha',correct:'beta',enabled:true}]};
  const parsed=parseCommand(input);
  assert.equal(parsed.type,'dictionary-save');
  input.entries[0].correct='changed';
  assert.equal(parsed.type==='dictionary-save' && parsed.entries[0].correct,'beta');
  assert.throws(()=>parseCommand({type:'dictionary-save',entries:[{wrong:'alpha',correct:'beta',enabled:true,extra:true}]}));
});
