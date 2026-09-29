import { validateProviderSelection, type ProviderSelection } from '../../shared/custom-ai';
import { checkCancelled, CustomAIError } from './errors';
import { buildASRRequest, buildOptimizationRequest } from './requests';
import { parseASRResponse, parseOptimizationResponse } from './responses';
import { type ProviderRequest, type ProviderResponse, type ProviderTransport } from './types';

export * from './types';
export * from './errors';
export * from './wav';
export * from './requests';
export * from './responses';
export * from './prompt';
export * from './synthetic-sample';

async function send(request: ProviderRequest, transport: ProviderTransport, signal: AbortSignal): Promise<ProviderResponse> {
  checkCancelled(signal);
  // Transport is injected by main and owns system proxy, HTTPS, redirect rejection and stream cap.
  try {
    const response = await transport(request, signal);
    checkCancelled(signal);
    return response;
  } catch (error) {
    checkCancelled(signal);
    // Only this class is trusted. Arbitrary native/HTTP errors may contain URLs, keys or bodies.
    if (error instanceof CustomAIError) throw error;
    throw new CustomAIError('CUSTOM_AI_NETWORK');
  }
}

export async function transcribe(wav: Buffer, selection: ProviderSelection,
  transport: ProviderTransport, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  const snapshot = validateProviderSelection('asr', selection);
  const request = buildASRRequest(wav, snapshot);
  const result = parseASRResponse(snapshot, await send(request, transport, signal));
  checkCancelled(signal);
  return result;
}

/** Optimization failures are handled by the owning pipeline; cancellation never falls back. */
export async function optimize(raw: string, selection: ProviderSelection,
  transport: ProviderTransport, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  const snapshot = validateProviderSelection('optimization', selection);
  const request = buildOptimizationRequest(raw, snapshot);
  const result = parseOptimizationResponse(snapshot, await send(request, transport, signal));
  checkCancelled(signal);
  return result;
}
