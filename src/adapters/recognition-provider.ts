/** Implement this in-process interface to connect an independently configured model or service.
 * The default provider never makes network requests or stores audio. */
export interface RecognitionStream {
  write(pcm:Uint8Array):Promise<void>;
  finish():Promise<string>;
  dispose():void;
}
export interface RecognitionProvider {
  readonly configured?: boolean;
  createStream(options:{signal:AbortSignal;onPartial:(text:string)=>void;mode?:'smart'|'verbatim'}):RecognitionStream;
}
export class DemoRecognitionProvider implements RecognitionProvider {
  createStream({signal}: {signal:AbortSignal;onPartial:(text:string)=>void}):RecognitionStream {
    let ended=signal.aborted;let samples=0;
    const dispose=()=>{ended=true;samples=0;signal.removeEventListener('abort',dispose);};
    signal.addEventListener('abort',dispose,{once:true});
    return {
      async write(pcm){if(ended || signal.aborted)throw Error('CANCELLED');if(pcm.byteLength%2)throw Error('AUDIO_INVALID_STATE');samples+=pcm.byteLength/2;if(samples>4_800_000){dispose();throw Error('AUDIO_LIMIT_EXCEEDED');}},
      async finish(){if(ended || signal.aborted)throw Error('CANCELLED');dispose();return 'This is simulated text, not a speech transcription.';},
      dispose,
    };
  }
}
export class UnconfiguredRecognitionProvider implements RecognitionProvider {
  readonly configured = false;
  createStream(): RecognitionStream { throw new Error('RECOGNITION_NOT_CONFIGURED'); }
}
/** DemoRecognitionProvider must be selected explicitly by the caller. */
export function createRecognitionProvider():RecognitionProvider {return new UnconfiguredRecognitionProvider();}
