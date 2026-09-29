import type { DiagnosticCategory, DiagnosticCode, DiagnosticIncident, DiagnosticStage } from '../shared/diagnostics';

export interface DiagnosticFailureInput { source: DiagnosticCategory; stage: DiagnosticStage; errorCode: unknown }
/** Positive mapping only. Never serialize an Error, provider text, or its arbitrary code.
 * Unknown/network/cancellation/permissions/OTP/quota/no-target/fallback return null. */
export function classifyDiagnosticFailure(input: DiagnosticFailureInput): DiagnosticIncident | null {
  if (typeof input.errorCode !== 'string') return null;
  const common: Record<string, DiagnosticCode> = {
    STORAGE_READ_FAILED: 'LOCAL_STATE_READ_FAILED', SETTINGS_READ_FAILED: 'LOCAL_STATE_READ_FAILED',
    SECURE_STORAGE_READ_FAILED: 'LOCAL_STATE_READ_FAILED', SESSION_STORAGE_READ_FAILED: 'LOCAL_STATE_READ_FAILED',
    DICTIONARY_READ_FAILED: 'LOCAL_STATE_READ_FAILED', DICTIONARY_WRITE_FAILED: 'LOCAL_STATE_WRITE_FAILED',
    STORAGE_WRITE_FAILED: 'LOCAL_STATE_WRITE_FAILED', VOICE_TEST_SAVE_FAILED: 'LOCAL_STATE_WRITE_FAILED', ONBOARDING_SAVE_FAILED: 'LOCAL_STATE_WRITE_FAILED',
    STORAGE_DELETE_FAILED: 'LOCAL_STATE_DELETE_FAILED', PROTOCOL_ERROR: 'PROTOCOL_VIOLATION', PROTOCOL_MISMATCH: 'PROTOCOL_VIOLATION',
  };
  const audio: Record<string, DiagnosticCode> = {
    AUDIO_CONVERSION_FAILED: 'AUDIO_CONVERSION_FAILED', AUDIO_OVERFLOW: 'AUDIO_BUFFER_OVERFLOW',
    AUDIO_INVALID_STATE: 'CAPTURE_INTERNAL_FAILURE', INVALID_AUDIO_START: 'PROTOCOL_VIOLATION',
    INVALID_AUDIO_PREFLIGHT: 'PROTOCOL_VIOLATION',
    INVALID_AUDIO_STOP: 'PROTOCOL_VIOLATION', INVALID_AUDIO_BATCH: 'PROTOCOL_VIOLATION',
    INVALID_AUDIO_FRAME: 'PROTOCOL_VIOLATION', INVALID_AUDIO_READ: 'PROTOCOL_VIOLATION', INVALID_AUDIO_STATUS: 'PROTOCOL_VIOLATION',
  };
  const insertion: Record<string, DiagnosticCode> = {
    INSERTION_TRANSACTION_BUSY: 'INSERTION_TRANSACTION_BUSY', PASTEBOARD_SNAPSHOT_FAILED: 'PASTEBOARD_SNAPSHOT_FAILED',
    PASTEBOARD_WRITE_FAILED: 'PASTEBOARD_WRITE_FAILED', PASTE_EVENT_FAILED: 'PASTE_EVENT_FAILED',
    // Native cleanup remains a distinct local warning.
    PASTEBOARD_RESTORE_FAILED: 'PASTEBOARD_WRITE_FAILED',
  };
  const update: Record<string, DiagnosticCode> = {
    UPDATE_METADATA_INVALID: 'UPDATE_METADATA_INVALID', UPDATE_SIGNATURE_INVALID: 'UPDATE_SIGNATURE_INVALID', UPDATE_INSTALL_FAILED: 'UPDATE_INSTALL_FAILED',
  };
  const custom: Record<string, DiagnosticCode> = { CUSTOM_AI_PROTOCOL_ERROR: 'PROVIDER_PROTOCOL_VIOLATION', CUSTOM_AI_INVALID_RESPONSE: 'PROVIDER_PROTOCOL_VIOLATION' };
  const specific = input.source === 'dictation' ? audio : input.source === 'insertion' ? insertion : input.source === 'update' ? update : ['custom_asr', 'custom_optimization'].includes(input.source) ? custom : {};
  const code = Object.hasOwn(specific, input.errorCode) ? specific[input.errorCode] : Object.hasOwn(common, input.errorCode) ? common[input.errorCode] : undefined;
  return code ? { category: input.source, stage: input.stage, code } : null;
}
