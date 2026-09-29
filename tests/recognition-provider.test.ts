import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoRecognitionProvider } from '../src/adapters/recognition-provider';
test('memory recognizer bounds audio and returns explicitly synthetic text',async()=>{
  const provider=new DemoRecognitionProvider();const controller=new AbortController();
  const stream=provider.createStream({signal:controller.signal,onPartial:()=>{}});
  await stream.write(new Uint8Array(3200));const text=await stream.finish();assert.match(text,/simulated/i);
  await assert.rejects(stream.write(new Uint8Array(2)));stream.dispose();
});
test('cancellation and malformed PCM reject without persisting audio',async()=>{
  const controller=new AbortController();const stream=new DemoRecognitionProvider().createStream({signal:controller.signal,onPartial:()=>{}});
  await assert.rejects(stream.write(new Uint8Array(1)));controller.abort();await assert.rejects(stream.finish());stream.dispose();
});
