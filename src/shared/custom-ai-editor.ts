import { getProvider, type ProviderDescriptor } from './custom-ai';
import { exactObject } from './native-protocol';
import type { CustomCategory } from './product';

export interface CustomDraftRequest { category: CustomCategory; providerId: string }
/** Sensitive, one-provider reply for an explicitly opened editor. Never a snapshot. */
export interface CustomDraftRead { modelId: string; values: Record<string, string>; version: number }
export interface CustomEditorDraft { modelId: string; values: Record<string, string> }
export function parseCustomDraftRequest(value: unknown): CustomDraftRequest {
  if (!exactObject(value, ['category', 'providerId']) || (value.category !== 'asr' && value.category !== 'optimization') ||
      typeof value.providerId !== 'string' || value.providerId.length > 40 || !getProvider(value.category, value.providerId)) throw new Error('INVALID_CUSTOM_DRAFT_REQUEST');
  return { category: value.category, providerId: value.providerId };
}
export function parseCustomDraftRead(value: unknown, request: CustomDraftRequest): CustomDraftRead {
  const fail = (): never => { throw new Error('CUSTOM_AI_DRAFT_READ_FAILED'); };
  let target: CustomDraftRequest;
  try { target = parseCustomDraftRequest(request); } catch { return fail(); }
  const provider = getProvider(target.category, target.providerId)!;
  if (!exactObject(value, ['modelId', 'values', 'version']) || typeof value.modelId !== 'string' || !provider.models.some((model) => model.id === value.modelId) ||
      !Number.isSafeInteger(value.version) || (value.version as number) < 0 || !exactObject(value.values, provider.fields.map((field) => field.id))) return fail();
  const values: Record<string, string> = {};
  for (const field of provider.fields) {
    const text = value.values[field.id];
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > 16384 || /[\p{Cc}\p{Cf}]/u.test(text)) return fail();
    values[field.id] = text;
  }
  return { modelId: value.modelId, values, version: value.version as number };
}
/** The editor submits a full replacement for its provider fields. Empty means
 * explicit deletion, including secrets; legacy partial commands keep their semantics. */
export function customDraftSubmission(provider: ProviderDescriptor, draft: CustomEditorDraft) {
  const values = Object.fromEntries(provider.fields.map((field) => [field.id, (draft.values[field.id] ?? '').trim()]));
  return { modelId: draft.modelId, values, clearFields: provider.fields.filter((field) => values[field.id] === '').map((field) => field.id) };
}
