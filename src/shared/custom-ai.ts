export type ProviderCategory = 'asr' | 'optimization';
export interface ProviderSelection {
  providerId: string;
  modelId: string;
  values: Record<string, string>;
}
export interface ProviderDescriptor {
  id: string;
  nameZh: string;
  nameEn: string;
  models: { id: string; nameZh: string; nameEn: string }[];
  fields: { id: string; label: string; secret: boolean; required: boolean; defaultValue?: string }[];
}
const endpoint = () => ({ id: 'endpoint', label: 'Endpoint URL (HTTPS)', secret: false, required: true });
const apiKey = () => ({ id: 'api-key', label: 'API Key', secret: true, required: true });
const model = (id: string, nameZh: string, nameEn = nameZh) => ({ id, nameZh, nameEn });
export const ASR_PROVIDERS: ProviderDescriptor[] = [
  { id: 'alibaba-bailian', nameZh: '阿里云百炼', nameEn: 'Alibaba Bailian', models: [
    model('fun-asr-flash-2026-06-15', 'Fun-ASR Flash'),
    model('qwen3-asr-flash-2026-02-10', 'Qwen3-ASR Flash')], fields: [endpoint(), apiKey()] },
  { id: 'volcengine', nameZh: '火山引擎', nameEn: 'Volcengine', models: [
    model('volc.bigasr.auc_turbo', 'Seed-ASR 2.0 极速版', 'Seed-ASR 2.0 Turbo')], fields: [endpoint(), apiKey()] },
];
export const OPTIMIZATION_PROVIDERS: ProviderDescriptor[] = [
  { id: 'alibaba-bailian', nameZh: '阿里云百炼', nameEn: 'Alibaba Bailian', models: [
    model('qwen3.7-plus', 'Qwen3.7 Plus'), model('qwen3.7-flash', 'Qwen3.7 Flash')], fields: [endpoint(), apiKey()] },
  { id: 'volcengine', nameZh: '火山引擎', nameEn: 'Volcengine', models: [
    model('doubao-seed-2-0-lite-260215', 'Doubao Seed 2.0 Lite')], fields: [endpoint(), apiKey(),
    { id: 'endpoint-id', label: 'Endpoint ID（可选）', secret: false, required: false }] },
  { id: 'deepseek', nameZh: 'DeepSeek', nameEn: 'DeepSeek', models: [
    model('deepseek-v4-flash', 'DeepSeek V4 Flash'), model('deepseek-v4-pro', 'DeepSeek V4 Pro')], fields: [endpoint(), apiKey()] },
  { id: 'kimi', nameZh: 'Kimi', nameEn: 'Kimi', models: [model('kimi-k3', 'Kimi K3')], fields: [endpoint(), apiKey()] },
  { id: 'glm', nameZh: 'GLM', nameEn: 'GLM', models: [
    model('glm-5', 'GLM-5'), model('glm-5-turbo', 'GLM-5-Turbo')], fields: [endpoint(), apiKey()] },
];

export function getProvider(category: ProviderCategory, id: string): ProviderDescriptor | undefined {
  if (category !== 'asr' && category !== 'optimization') return undefined;
  return (category === 'asr' ? ASR_PROVIDERS : OPTIMIZATION_PROVIDERS).find((provider) => provider.id === id);
}
/** Called only after an explicit provider choice. Optional Endpoint ID has no default value. */
export function defaultProviderSelection(category: ProviderCategory, providerId: string): ProviderSelection {
  const provider = getProvider(category, providerId);
  if (!provider) throw new Error('CUSTOM_AI_INVALID_CONFIGURATION');
  return { providerId, modelId: provider.models[0].id,
    values: Object.fromEntries(provider.fields.filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.id, field.defaultValue!])) };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Returns a fresh allowlisted copy. Draft/storage validation may omit secrets; runtime may not.
 * Credential strings are never put in diagnostics. Newline-bearing credentials are rejected
 * before they can enter HTTP headers. Empty optional input is equivalent to absence.
 */
export function validateProviderSelection(category: ProviderCategory, input: unknown, requireCredentials = true): ProviderSelection {
  const fail = (): never => { throw new Error('CUSTOM_AI_INVALID_CONFIGURATION'); };
  if (!record(input) || Object.keys(input).some((key) => !['providerId', 'modelId', 'values'].includes(key))
    || typeof input.providerId !== 'string' || typeof input.modelId !== 'string' || !record(input.values)) return fail();
  const provider = getProvider(category, input.providerId);
  if (!provider || !provider.models.some((item) => item.id === input.modelId)) return fail();
  const values: Record<string, string> = {};
  for (const [id, value] of Object.entries(input.values)) {
    const field = provider.fields.find((item) => item.id === id);
    if (!field || typeof value !== 'string' || value !== value.trim()
      || new TextEncoder().encode(value).length > 16_384 || /[\p{Cc}\p{Cf}]/u.test(value)) return fail();
    if (!value) continue;
    if (id === 'endpoint') {
      try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.length > 2048) return fail(); } catch { return fail(); }
    }
    if (id === 'endpoint-id' && !/^[A-Za-z0-9._-]{1,256}$/.test(value)) return fail();
    values[id] = value;
  }
  for (const field of provider.fields) {
    if (field.required && (!field.secret || requireCredentials) && !values[field.id]) return fail();
  }
  return { providerId: input.providerId, modelId: input.modelId, values };
}
export function isProviderSelection(category: ProviderCategory, input: unknown, requireCredentials = true): input is ProviderSelection {
  try { validateProviderSelection(category, input, requireCredentials); return true; } catch { return false; }
}
