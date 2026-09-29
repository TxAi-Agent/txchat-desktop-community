import type { RecognitionPort, SessionEvents } from '../domain/dictation';
import type { NativeHost } from '../main/native-host';
import type { AudioProgress, FixtureScenario } from '../shared/native-audio';
import { NativeAudioCapture } from './native-audio';
import { createRecognitionProvider, type RecognitionProvider, type RecognitionStream } from './recognition-provider';
export function createMicrophoneSession(host:NativeHost,scenario:FixtureScenario,publish:(value:AudioProgress)=>void,failure:(error:Error)=>void,provider:RecognitionProvider=createRecognitionProvider()):RecognitionPort {
  let stream:RecognitionStream|undefined;let disposed=false;let events:SessionEvents|undefined;
  const failed=(error:Error)=>{if(!disposed){failure(error);events?.failed(error);capture.cancel();stream?.dispose();}};
  const capture=new NativeAudioCapture(host,value=>{if(!disposed)publish(value);},async pcm=>{
    if(!stream)throw Error('AUDIO_INVALID_STATE');
    if(scenario==='disconnect')throw Error('RECOGNITION_FAILED');
    // The capture buffer belongs to the native adapter and is zeroed after this promise.
    await stream.write(pcm);
  },error=>{if(error)failed(error);else if(!disposed)events?.ended();});
  return {
    async start(partial,signal,callbacks){events=callbacks;try{await capture.prepare(signal);stream=provider.createStream({signal,onPartial:partial});if(disposed||signal.aborted)throw Error('CANCELLED');await capture.start(signal);}catch(error){failed(error instanceof Error?error:Error('RECOGNITION_FAILED'));throw error;}},
    async finish(organizing,signal){await capture.stop();if(disposed||signal.aborted||!stream)throw Error('CANCELLED');if(scenario==='upstream-failure')throw Error('RECOGNITION_FAILED');if(scenario==='empty-final')throw Error('NO_SPEECH');organizing();return await stream.finish();},
    dispose(){if(disposed)return;disposed=true;capture.cancel();stream?.dispose();},
  };
}
