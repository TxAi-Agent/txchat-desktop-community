import { randomUUID } from 'node:crypto';
import { validateProviderSelection, type ProviderSelection } from '../../shared/custom-ai';
import { CustomAIError } from './errors';
import { loadOptimizationPrompt } from './prompt';
import { MAX_RESPONSE_BYTES, MAX_TEXT_BYTES, PROVIDER_TIMEOUT_MS, type ProviderRequest } from './types';
import { validateWav } from './wav';

function jsonRequest(url: string, headers: Record<string, string>, body: unknown): ProviderRequest {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new CustomAIError('CUSTOM_AI_UNAPPROVED_ENDPOINT');
  return { url, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), maximumResponseBytes: MAX_RESPONSE_BYTES, timeoutMs: PROVIDER_TIMEOUT_MS };
}

export function buildASRRequest(wav: Buffer, input: ProviderSelection, requestId: string = randomUUID()): ProviderRequest {
  const selected = validateProviderSelection('asr', input);
  validateWav(wav);
  if (selected.providerId === 'alibaba-bailian') {
    const dataURI = `data:audio/wav;base64,${wav.toString('base64')}`;
    const fun = selected.modelId.startsWith('fun-asr-flash');
    return jsonRequest(selected.values.endpoint, { Authorization: `Bearer ${selected.values['api-key']}`, 'X-DashScope-SSE': 'disable' }, {
      model: selected.modelId,
      input: { messages: [{ role: 'user', content: fun
        ? [{ type: 'input_audio', input_audio: { data: dataURI } }] : [{ audio: dataURI }] }] },
      parameters: fun ? { format: 'wav', sample_rate: '16000' } : { asr_options: { enable_itn: false } },
    });
  }
  if (selected.providerId !== 'volcengine') throw new CustomAIError('CUSTOM_AI_UNSUPPORTED_PROVIDER');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new CustomAIError('CUSTOM_AI_INVALID_REQUEST');
  }
  const uid = requestId.toLowerCase();
  return jsonRequest(selected.values.endpoint, { 'X-Api-Key': selected.values['api-key'],
    'X-Api-Resource-Id': 'volc.bigasr.auc_turbo', 'X-Api-Request-Id': uid, 'X-Api-Sequence': '-1' },
  { user: { uid }, audio: { data: wav.toString('base64') }, request: { model_name: 'bigmodel' } });
}

export function buildOptimizationRequest(raw: string, input: ProviderSelection): ProviderRequest {
  const selected = validateProviderSelection('optimization', input);
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() || Buffer.byteLength(raw) > MAX_TEXT_BYTES
    || /[\p{Cc}\p{Cf}]/u.test(raw.replaceAll('\n', ''))) throw new CustomAIError('CUSTOM_AI_INVALID_REQUEST');
  const url = selected.values.endpoint;
  if (!url) throw new CustomAIError('CUSTOM_AI_UNSUPPORTED_PROVIDER');
  return jsonRequest(url, { Authorization: `Bearer ${selected.values['api-key']}` }, {
    model: selected.values['endpoint-id'] || selected.modelId,
    messages: [{ role: 'system', content: loadOptimizationPrompt().content }, { role: 'user', content: raw }], stream: false,
  });
}
