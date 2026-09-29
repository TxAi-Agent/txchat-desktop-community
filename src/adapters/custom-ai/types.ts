export const MAX_PCM_BYTES = 9_600_000;
export const MAX_WAV_BYTES = 10_000_000;
export const MAX_RESPONSE_BYTES = 2_097_152;
export const MAX_TEXT_BYTES = 1_048_576;
// The injected transport implements this hard total budget (and may enforce a shorter idle budget).
export const PROVIDER_TIMEOUT_MS = 330_000;
export interface ProviderRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Uint8Array | string;
  maximumResponseBytes: number;
  timeoutMs: number;
}
export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
/** Main-process transport must reject redirects, cap the incoming stream and abort on signal.
 * No implementation is installed by default; importing this module never performs network I/O.
 */
export interface ProviderTransport {
  (request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}
