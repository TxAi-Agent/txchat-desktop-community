import type { Scenario } from '../shared/contracts';
import type { SessionPort } from '../domain/dictation';

export const SAMPLE_TEXT = '这是一段合成的验证文本，用于检查共享听写流程。';
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('CANCELLED')); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** This adapter has no audio, network, filesystem or OS input capabilities. */
export function createSimulatedSession(scenario: Scenario): SessionPort {
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let offset = 0;
  let written = false;
  const clear = () => { if (interval) clearInterval(interval); interval = undefined; };
  return {
    async start(onPartial, signal) {
      await pause(100, signal);
      if (disposed) throw new Error('CANCELLED');
      interval = setInterval(() => { offset = Math.min(SAMPLE_TEXT.length, offset + 2); onPartial(SAMPLE_TEXT.slice(0, offset)); }, 130);
    },
    async finish(onOrganizing, signal) {
      clear(); await pause(250, signal);
      if (scenario === 'service-failure') throw new Error('SIMULATED_SERVICE_FAILURE');
      onOrganizing(); await pause(300, signal); return SAMPLE_TEXT;
    },
    async insert(_text, _operationId, signal) {
      if (written || disposed) throw new Error('ALREADY_CONSUMED');
      written = true; await pause(120, signal);
      return scenario === 'insertion-rejected' ? 'notInserted' : scenario === 'insertion-unknown' ? 'partialOrUnknown' : 'inserted';
    },
    dispose() { disposed = true; clear(); },
  };
}
