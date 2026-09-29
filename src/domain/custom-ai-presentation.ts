import type { CustomTestResult, Language } from '../shared/product';
export type CustomAlertKind = 'unsaved' | 'incomplete' | 'unsupported' | 'load-failed' | 'save-failed';
export type CustomFailureCategory = 'microphone' | 'audio-sample' | 'network' | 'authentication' | 'permission-or-model' | 'rate-limit' | 'invalid-request' | 'incompatible-response';
export const customSheetLayout = (fieldCount: number) => fieldCount <= 1 ? { width: 620, height: 300, top: 100 } : fieldCount === 2 ? { width: 620, height: 380, top: 75 } : { width: 620, height: 460, top: 50 };
export const customCardPosition = (category: 'asr' | 'optimization', index: number) => ({ left: [40, 258, 476][index % 3], top: (category === 'asr' ? 146 : 340) + Math.floor(index / 3) * 70 });
export function customCardModelName(model: { id: string; nameZh: string; nameEn: string } | undefined, language: Language) {
  if (!model) return '';
  const names: Record<string, string> = { 'fun-asr-flash-2026-06-15': 'Fun-ASR', 'qwen3-asr-flash-2026-02-10': 'Qwen3-ASR',
    'volc.bigasr.auc_turbo': 'Seed 2.0', 'qwen3.7-plus': 'Qwen3.7+', 'qwen3.7-flash': 'Qwen3.7 Flash',
    'doubao-seed-2-0-lite-260215': 'Seed 2.0 Lite', 'deepseek-v4-flash': 'V4 Flash', 'deepseek-v4-pro': 'V4 Pro' };
  return names[model.id] ?? (language === 'zh' ? model.nameZh : model.nameEn);
}
export function customFailureCategory(code: string | null): CustomFailureCategory {
  if (['AUDIO_PERMISSION_REQUIRED', 'AUDIO_DEVICE_UNAVAILABLE', 'AUDIO_INTERRUPTED', 'CUSTOM_AI_INVALID_AUDIO'].includes(code ?? '')) return 'microphone';
  if (['CUSTOM_AI_AUDIO_SAMPLE', 'CUSTOM_AI_EMPTY_RESULT', 'CUSTOM_AI_AUDIO_LIMIT'].includes(code ?? '')) return 'audio-sample';
  if (['CUSTOM_AI_NETWORK', 'CUSTOM_AI_TIMEOUT', 'NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'PROXY_AUTH_REQUIRED'].includes(code ?? '')) return 'network';
  if (code === 'CUSTOM_AI_AUTHENTICATION') return 'authentication';
  if (['CUSTOM_AI_PERMISSION_OR_MODEL', 'CUSTOM_AI_UNSUPPORTED_PROVIDER', 'CUSTOM_AI_UNAPPROVED_ENDPOINT'].includes(code ?? '')) return 'permission-or-model';
  if (code === 'CUSTOM_AI_RATE_LIMIT') return 'rate-limit';
  if (['CUSTOM_AI_INVALID_CONFIGURATION', 'CUSTOM_AI_INVALID_REQUEST', 'CUSTOM_AI_PROMPT_INVALID'].includes(code ?? '')) return 'invalid-request';
  return 'incompatible-response';
}
export function customTestFailure(code: string | null, language: Language) {
  if (code === null) return language === 'zh' ? '测试异常' : 'Test failed';
  const labels: Record<CustomFailureCategory, [string, string]> = {
    microphone: ['麦克风不可用', 'Microphone unavailable'], 'audio-sample': ['未检测到有效语音', 'No speech detected'], network: ['网络连接失败', 'Network error'],
    authentication: ['认证失败', 'Authentication failed'], 'permission-or-model': ['权限或模型不可用', 'Permission or model unavailable'],
    'rate-limit': ['请求过于频繁', 'Rate limit reached'], 'invalid-request': ['请求配置无效', 'Invalid request'], 'incompatible-response': ['服务响应不兼容', 'Incompatible response'],
  };
  return labels[customFailureCategory(code)][language === 'zh' ? 0 : 1];
}
export function customAlertCopy(kind: CustomAlertKind, language: Language) {
  const copy: Record<CustomAlertKind, [[string, string], [string, string]]> = {
    unsaved: [['有未保存的更改', 'You have unsaved changes'], ['AI 模型服务配置尚未保存。离开后，本次更改将不会生效。', 'Your AI model service settings haven’t been saved. These changes won’t take effect if you leave.']],
    incomplete: [['配置不完整', 'Incomplete Settings'], ['请完成所选语音识别和内容优化服务的必填配置。', 'Complete all required fields for the selected speech recognition and content optimization services.']],
    unsupported: [['服务已停止支持', 'Service No Longer Supported'], ['原服务已不再支持，请重新选择。', 'The previous service is no longer supported. Please select another provider.']],
    'load-failed': [['无法读取配置', 'Couldn’t Load Settings'], ['本地配置无法安全读取，请取消后重试。', 'The local settings could not be read safely. Cancel and retry.']],
    'save-failed': [['保存失败', 'Couldn’t Save'], ['配置未更改，请检查系统钥匙串后重试。', 'No settings were changed. Check Keychain and try again.']],
  };
  const index = language === 'zh' ? 0 : 1;
  return { title: copy[kind][0][index], body: copy[kind][1][index] };
}
export function customAlertForError(code: string | undefined): Exclude<CustomAlertKind, 'unsaved'> | null {
  if (!code) return null;
  if (['SECURE_STORAGE_READ_FAILED', 'SETTINGS_READ_FAILED', 'STORAGE_READ_FAILED'].includes(code)) return 'load-failed';
  if (code === 'CUSTOM_AI_UNSUPPORTED_PROVIDER') return 'unsupported';
  if (['CUSTOM_AI_INVALID_CONFIGURATION', 'CUSTOM_AI_NOT_CONFIGURED'].includes(code)) return 'incomplete';
  return 'save-failed';
}

/** Only a newer matching request may supply feedback for this draft. */
export function customTestResultMatches(result: CustomTestResult, request: {
  category: CustomTestResult['category']; providerId: string | null; version: number; afterGeneration: number;
}, currentVersion: number) {
  return result.generation > request.afterGeneration && result.configurationVersion === request.version &&
    currentVersion === request.version && result.category === request.category && result.providerId === request.providerId && result.phase !== 'idle';
}
