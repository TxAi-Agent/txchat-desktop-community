import type { SessionPort, RecognitionPort } from '../domain/dictation';
import type { NativeHost } from '../main/native-host';
import type { NativeInsertion } from '../shared/native-input';
import { createSimulatedSession } from './simulated-session';

/** A captured target is single-use. An ordinary unavailable target retains recognized text without native writes. */
export function createNativeSession(host: NativeHost, targetId: string | null, isCurrent: () => boolean,
  onResult: (result: NativeInsertion) => void, service: RecognitionPort = createSimulatedSession('success')): SessionPort {
  let disposed = false;
  let consumed = false;
  const release = () => { if (targetId) void host.releaseTarget(targetId).catch(() => undefined); };
  return {
    start: (partial, signal, events) => service.start(partial, signal, events),
    finish: (organizing, signal) => service.finish(organizing, signal),
    async insert(text, operationId, signal) {
      if (disposed || consumed || signal.aborted || !isCurrent() || host.snapshot.status !== 'ready') return 'notInserted';
      if (targetId === null) {
        consumed = true; onResult({ outcome: 'notInserted', reason: 'TARGET_UNAVAILABLE' }); return 'notInserted';
      }
      if (!text.trim() || text.length > 8192 || text.includes('\0')) {
        onResult({ outcome: 'notInserted', reason: 'TEXT_TOO_LONG' }); return 'notInserted';
      }
      consumed = true;
      const sessionId = operationId.replace(/-write-1$/, '');
      try {
        const result = await host.insertText({ targetId, sessionId, operationId, text });
        if (!disposed && isCurrent()) onResult(result);
        return result.outcome;
      } catch {
        // Once dispatched, timeout/EOF cannot prove that the target was untouched.
        if (!disposed && isCurrent()) onResult({ outcome: 'partialOrUnknown', reason: 'DELIVERY_UNCONFIRMED' });
        return 'partialOrUnknown';
      }
    },
    dispose() { if (disposed) return; disposed = true; service.dispose(); release(); },
  };
}
