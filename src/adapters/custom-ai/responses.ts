import { validateProviderSelection, type ProviderSelection } from '../../shared/custom-ai';
import { CustomAIError, type CustomAIErrorCode } from './errors';
import { MAX_RESPONSE_BYTES, MAX_TEXT_BYTES, type ProviderResponse } from './types';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function first(value: unknown): unknown { return Array.isArray(value) ? value[0] : undefined; }
function header(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}
function parsedJSON(body: Uint8Array): Record<string, unknown> | undefined {
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); } catch { return undefined; }
}
function validateResponse(response: ProviderResponse): void {
  if (!response || !(response.body instanceof Uint8Array) || !Number.isInteger(response.status)
    || response.status < 100 || response.status > 599 || !object(response.headers)
    || Object.values(response.headers).some((value) => typeof value !== 'string')) {
    throw new CustomAIError('CUSTOM_AI_INVALID_RESPONSE');
  }
  if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new CustomAIError('CUSTOM_AI_RESPONSE_TOO_LARGE');
}
function failure(status: number, providerCode: unknown): CustomAIError {
  // A provider code is only examined internally and never retained or interpolated into the error.
  const code = typeof providerCode === 'string' && providerCode.length <= 128 ? providerCode.toLowerCase()
    : typeof providerCode === 'number' && Number.isSafeInteger(providerCode) ? String(providerCode) : '';
  let error: CustomAIErrorCode = 'CUSTOM_AI_INVALID_RESPONSE';
  if (status === 401 || code === '45000010') error = 'CUSTOM_AI_AUTHENTICATION';
  else if (status === 403 || status === 404) error = 'CUSTOM_AI_PERMISSION_OR_MODEL';
  else if (code === '20000003') error = 'CUSTOM_AI_AUDIO_SAMPLE';
  else if (code.startsWith('450')) error = 'CUSTOM_AI_INVALID_REQUEST';
  else if (code.startsWith('550')) error = 'CUSTOM_AI_NETWORK';
  else if (['invalidapikey', 'invalid_api_key', 'unauthorized', 'authentication'].some((part) => code.includes(part))) error = 'CUSTOM_AI_AUTHENTICATION';
  else if (['rate_limit', 'ratelimit', 'too_many_requests'].some((part) => code.includes(part))) error = 'CUSTOM_AI_RATE_LIMIT';
  else if (['permission', 'accessdenied', 'model_not_found'].some((part) => code.includes(part))) error = 'CUSTOM_AI_PERMISSION_OR_MODEL';
  else if (status === 429) error = 'CUSTOM_AI_RATE_LIMIT';
  else if (status >= 400 && status < 500) error = 'CUSTOM_AI_INVALID_REQUEST';
  else if (status >= 500) error = 'CUSTOM_AI_NETWORK';
  return new CustomAIError(error);
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string') throw new CustomAIError('CUSTOM_AI_INVALID_RESPONSE');
  const result = value.trim();
  if (!result) throw new CustomAIError('CUSTOM_AI_EMPTY_RESULT');
  if (Buffer.byteLength(result) > MAX_TEXT_BYTES) throw new CustomAIError('CUSTOM_AI_INVALID_RESPONSE');
  return result;
}

export function parseASRResponse(input: ProviderSelection, response: ProviderResponse): string {
  const selected = validateProviderSelection('asr', input, false);
  validateResponse(response);
  const data = parsedJSON(response.body);
  const status = selected.providerId === 'volcengine' ? header(response.headers, 'x-api-status-code') : data?.code;
  if (response.status < 200 || response.status > 299) throw failure(response.status, status);
  if (!data) throw new CustomAIError('CUSTOM_AI_INVALID_RESPONSE');
  if (selected.providerId === 'volcengine') {
    if (status === undefined) throw new CustomAIError('CUSTOM_AI_INVALID_RESPONSE');
    if (status !== '20000000') throw failure(response.status, status);
    return nonempty(object(data.result)?.text);
  }
  const output = object(data.output);
  if (selected.modelId.startsWith('fun-asr-flash')) {
    const nested = object(output?.output);
    return nonempty(string(output?.text) ?? string(object(output?.sentence)?.text)
      ?? string(nested?.text) ?? string(object(nested?.sentence)?.text));
  }
  const message = object(object(first(output?.choices))?.message), content = message?.content;
  return nonempty(Array.isArray(content) ? content.flatMap((item) => {
    const text = string(object(item)?.text); return text === undefined ? [] : [text];
  }).join('') : undefined);
}

export function parseOptimizationResponse(input: ProviderSelection, response: ProviderResponse): string {
  validateProviderSelection('optimization', input, false);
  validateResponse(response);
  const data = parsedJSON(response.body), error = object(data?.error);
  if (response.status < 200 || response.status > 299) throw failure(response.status, error?.code ?? error?.type);
  if (!data) throw new CustomAIError('CUSTOM_AI_INVALID_RESPONSE');
  return nonempty(object(object(first(data.choices))?.message)?.content);
}
