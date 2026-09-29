import { isToken } from '../shared/native-input';
import { SOFTWARE_UPDATE_ACTIONS } from '../shared/software-update';
import type { ProductCommand, DictionaryEntry } from '../shared/product';
import { exactObject } from '../shared/native-protocol';
import { validateDictionary } from '../domain/dictionary';
const string = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max && !/[\0\r\n]/.test(v);
const category = (v: unknown) => v === 'asr' || v === 'optimization';
const fields = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.entries(v).length <= 8 &&
  Object.entries(v).every(([k, value]) => /^[a-z-]{1,30}$/.test(k) && string(value));
const known = ['shortcut-open', 'auth-restore', 'auth-logout', 'auth-reauthenticate', 'demo-enter', 'onboarding-permission', 'permissions-repair', 'onboarding-next', 'voice-test-start', 'voice-test-stop', 'voice-test-skip', 'voice-test-close',
  'billing-refresh', 'payment-create', 'payment-refresh', 'payment-recover', 'payment-close', 'dictionary-reload', 'dictionary-open',
  'custom-test-cancel', 'result-copy', 'diagnostics-send', 'diagnostics-retry', 'diagnostics-discard', 'diagnostics-done', 'document-close', ...SOFTWARE_UPDATE_ACTIONS];
export function parseProductCommand(value: unknown): ProductCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_COMMAND');
  const r = value as Record<string, unknown>;
  if (exactObject(r, ['type', 'sessionId']) && ['shortcut-capture', 'shortcut-save', 'shortcut-cancel'].includes(r.type as string) && isToken(r.sessionId)) return r as ProductCommand;
  if (exactObject(r, ['type']) && known.includes(r.type as string)) return r as ProductCommand;
  if (exactObject(r, ['type', 'page']) && r.type === 'product-page' && ['status', 'membership', 'custom-ai', 'dictionary'].includes(r.page as string)) return r as ProductCommand;
  if (r.type === 'preferences' && Object.keys(r).length > 1 && Object.keys(r).every((k) => ['type', 'language', 'theme', 'mode', 'service'].includes(k)) &&
    (r.language === undefined || ['zh', 'en'].includes(r.language as string)) && (r.theme === undefined || ['system', 'light', 'dark'].includes(r.theme as string)) &&
    (r.mode === undefined || ['smart', 'verbatim'].includes(r.mode as string)) && (r.service === undefined || ['cloud', 'custom', 'local'].includes(r.service as string))) return r as ProductCommand;
  if (r.type === 'auth-phone-edited' && exactObject(r, ['type', 'phone']) && string(r.phone, 32)) return r as ProductCommand;
  if (r.type === 'auth-code-edited' && exactObject(r, ['type', 'code']) && string(r.code, 16)) return r as ProductCommand;
  if (r.type === 'auth-send' && exactObject(r, ['type', 'phone', 'acceptedTerms']) && string(r.phone, 32) && typeof r.acceptedTerms === 'boolean') return r as ProductCommand;
  if (r.type === 'auth-verify' && exactObject(r, r.inviteCode === undefined ? ['type', 'code', 'acceptedTerms'] : ['type', 'code', 'acceptedTerms', 'inviteCode']) &&
    string(r.code, 16) && typeof r.acceptedTerms === 'boolean' && (r.inviteCode === undefined || string(r.inviteCode, 128))) return r as ProductCommand;
  if (r.type === 'dictionary-save' && exactObject(r, ['type', 'entries']) && Array.isArray(r.entries) && r.entries.every((entry) => exactObject(entry, ['wrong', 'correct', 'enabled']))) {
    validateDictionary(r.entries as unknown as DictionaryEntry[]); return r as ProductCommand;
  }
  if (r.type === 'custom-apply' && exactObject(r, ['type', 'enabled']) && typeof r.enabled === 'boolean') return r as ProductCommand;
  if (r.type === 'custom-select' && exactObject(r, ['type', 'category', 'providerId']) && category(r.category) && string(r.providerId, 40)) return r as ProductCommand;
  if (r.type === 'custom-save' && exactObject(r, ['type', 'category', 'providerId', 'modelId', 'values', 'clearFields', 'select']) && category(r.category) &&
    string(r.providerId, 40) && string(r.modelId, 128) && fields(r.values) && Array.isArray(r.clearFields) && r.clearFields.length <= 8 &&
    r.clearFields.every((f) => string(f, 30)) && typeof r.select === 'boolean') return r as ProductCommand;
  if (r.type === 'custom-test' && Object.keys(r).every((k) => ['type', 'category', 'providerId', 'modelId', 'values', 'clearFields'].includes(k)) &&
    (category(r.category) || r.category === 'all') && (r.providerId === undefined || string(r.providerId, 40)) &&
    (r.modelId === undefined || string(r.modelId, 128)) && (r.values === undefined || fields(r.values)) &&
    (r.clearFields === undefined || Array.isArray(r.clearFields) && r.clearFields.length <= 8 && r.clearFields.every((f) => string(f, 30)))) return r as ProductCommand;
  if (r.type === 'system-settings' && exactObject(r, ['type', 'capability']) && ['microphone', 'accessibility'].includes(r.capability as string)) return r as ProductCommand;
  if (r.type === 'document-open' && exactObject(r, ['type', 'document']) && ['privacy', 'terms', 'cloud', 'guide', 'about'].includes(r.document as string)) return r as ProductCommand;
  throw new Error('INVALID_COMMAND');
}
