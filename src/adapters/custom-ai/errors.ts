export type CustomAIErrorCode = 'CUSTOM_AI_INVALID_CONFIGURATION' | 'CUSTOM_AI_UNSUPPORTED_PROVIDER'
  | 'CUSTOM_AI_INVALID_REQUEST' | 'CUSTOM_AI_INVALID_AUDIO' | 'CUSTOM_AI_AUDIO_LIMIT'
  | 'CUSTOM_AI_INVALID_RESPONSE' | 'CUSTOM_AI_RESPONSE_TOO_LARGE' | 'CUSTOM_AI_UNAPPROVED_ENDPOINT'
  | 'CUSTOM_AI_AUTHENTICATION' | 'CUSTOM_AI_PERMISSION_OR_MODEL' | 'CUSTOM_AI_RATE_LIMIT'
  | 'CUSTOM_AI_AUDIO_SAMPLE' | 'CUSTOM_AI_NETWORK' | 'CUSTOM_AI_TIMEOUT' | 'CUSTOM_AI_EMPTY_RESULT'
  | 'CUSTOM_AI_PROMPT_INVALID' | 'CUSTOM_AI_FIDELITY_REJECTED' | 'CANCELLED';

/** Contains only an allowlisted code, never remote body, credentials, request ID or raw error. */
export class CustomAIError extends Error {
  constructor(readonly code: CustomAIErrorCode) { super(code); this.name = 'Error'; }
}
export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CustomAIError('CANCELLED');
}
