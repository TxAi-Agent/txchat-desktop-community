import type { AuthSnapshot, Language } from '../shared/product';

export const loginDigits = (value: string) => value.replace(/[^0-9]/g, '');
export function loginPhoneDigits(value: string) {
  let digits = loginDigits(value);
  if (digits.startsWith('86') && digits.length > 11) digits = digits.slice(2);
  return digits.slice(0, 11);
}
const grouped = (value: string, lengths: number[]) => {
  let offset = 0;
  return lengths.map((length) => { const group = value.slice(offset, offset + length); offset += length; return group; }).filter(Boolean).join(' ');
};
export const formatLoginPhone = (value: string) => grouped(loginPhoneDigits(value), [3, 4, 4]);
export const formatLoginCode = (value: string) => grouped(loginDigits(value).slice(0, 6), [3, 3]);
export function retryDuration(seconds: number, language: Language) {
  const value = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (value >= 3600) return language === 'zh' ? `${Math.floor(value / 3600)} 小时 ${pad(Math.floor(value % 3600 / 60))} 分` : `${Math.floor(value / 3600)}h ${pad(Math.floor(value % 3600 / 60))}m`;
  if (value >= 60) return language === 'zh' ? `${Math.floor(value / 60)} 分 ${pad(value % 60)} 秒` : `${Math.floor(value / 60)}m ${pad(value % 60)}s`;
  return language === 'zh' ? `${value} 秒` : `${value}s`;
}
export type LoginVisualState = 'initial' | 'phoneEntered' | 'codeSent' | 'credentialEntered' | 'ready' | 'invalidCredential' |
  'challengeExpired' | 'challengeExhausted' | 'verificationRetryLimited' | 'verificationLocked' | 'sendCooldown' | 'sendQuotaLimited' | 'sendUnavailable' | 'serviceUnavailable';
export interface LoginPresentation {
  visualState: LoginVisualState; canVerify: boolean; canRequestCode: boolean; requestTitle: string;
  message: string | null; placement: 'topSMS' | 'bottomCompact' | null; pillWidth: number | null; locked: boolean;
}
export function loginPresentation({ auth, phone, code, accepted, language, now }: {
  auth: AuthSnapshot; phone: string; code: string; accepted: boolean; language: Language; now: number;
}): LoginPresentation {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const phoneValid = /^1[3-9][0-9]{9}$/.test(loginPhoneDigits(phone));
  const active = auth.phoneMatchesChallenge && auth.challengeExpiresAt > now;
  const retry = Math.max(0, Math.ceil((auth.verifyAt - now) / 1000));
  const rawResend = Math.max(0, Math.ceil((auth.resendAt - now) / 1000));
  const resend = rawResend ? Math.max(1, rawResend - auth.resendDisplayOffset) : 0;
  const locked = auth.smsRequestLocked && retry > 0;
  const requestWait = Math.max(resend, locked ? retry : 0);
  const canVerify = phoneValid && active && loginDigits(code).length === 6 && accepted && !auth.codeWasRejected && retry === 0 && !auth.busy && !auth.verifyingSMS;
  const canRequestCode = phoneValid && !auth.requestingSMS && (!auth.busy || auth.verifyingSMS) && resend === 0 && !locked;
  const result: LoginPresentation = { visualState: canVerify ? 'ready' : code ? 'credentialEntered' : active ? 'codeSent' : phone ? 'phoneEntered' : 'initial',
    canVerify, canRequestCode, requestTitle: auth.requestingSMS ? t('获取中…', 'Getting…') : requestWait ? t(`${retryDuration(requestWait, language)}后重试`, `Retry in ${retryDuration(requestWait, language)}`) : t('获取验证码', 'Get Code'),
    message: null, placement: null, pillWidth: null, locked };
  const error = auth.error;
  if (!error) return result;
  const top = (visualState: LoginVisualState, zh: string, en: string, zhWidth: number, enWidth: number, block = false) => ({ ...result, visualState, message: t(zh, en), placement: 'topSMS' as const, pillWidth: language === 'zh' ? zhWidth : enWidth, canVerify: !block && canVerify });
  const compact = (zh: string, en: string) => ({ ...result, visualState: 'serviceUnavailable' as const, message: t(zh, en), placement: 'bottomCompact' as const });
  if (error.code === 'TERMS_REQUIRED') return compact('请先阅读并同意服务条款与隐私说明', 'Please agree to the Terms of Service and Privacy Policy');
  if (['INVALID_PHONE_NUMBER', 'PHONE_INVALID'].includes(error.code)) return compact('请输入正确的中国大陆手机号', 'Enter a valid mainland China mobile number');
  if (error.reason === 'incorrect') {
    const attempts = error.attemptsRemaining ?? 0;
    return top('invalidCredential', `验证码错误，还可尝试 ${attempts} 次`, attempts === 1 ? 'Incorrect code. 1 attempt remaining' : `Incorrect code. ${attempts} attempts remaining`, 316, 420, true);
  }
  if (error.reason === 'expired' || error.code === 'CHALLENGE_EXPIRED') return top('challengeExpired', '短信验证码已过期，请重新获取', 'Verification code expired. Get a new code', 286, 430, true);
  if (error.reason === 'exhausted') return top('challengeExhausted', '本次验证码已失效，请重新获取', 'This code is no longer valid. Get a new code', 330, 485, true);
  if (error.reason === 'verification_retry' && retry) return top('verificationRetryLimited', `操作太快，请 ${retryDuration(retry, language)}后重试`, `Please wait ${retryDuration(retry, language)} and try again`, 286, 360, true);
  if (locked) return top('verificationLocked', `验证码错误次数过多，请 ${retryDuration(retry, language)}后重试`, `Too many incorrect codes. Try again in ${retryDuration(retry, language)}`, 420, 485, true);
  if (error.reason === 'send_cooldown' && resend) return top('sendCooldown', `请 ${retryDuration(resend, language)}后重新获取验证码`, `Get another code in ${retryDuration(resend, language)}`, 316, 360);
  if ((error.reason === 'send_quota' || error.code === 'TOO_MANY_REQUESTS' && auth.loginErrorSource === 'send') && resend) return top('sendQuotaLimited', `发送次数较多，请 ${retryDuration(resend, language)}后重试`, `Too many codes requested. Try again in ${retryDuration(resend, language)}`, 380, 485);
  if (['verification_retry', 'verification_locked', 'send_cooldown', 'send_quota'].includes(error.reason ?? '') || error.code === 'TOO_MANY_REQUESTS' && (auth.verifyAt > 0 || auth.resendAt > 0)) return result;
  if (error.code === 'INVALID_VERIFICATION_CODE' || error.code === 'VERIFICATION_CODE_INVALID_OR_EXPIRED') return { ...result, visualState: 'invalidCredential' };
  if (auth.loginErrorSource === 'send' || error.code === 'SMS_PROVIDER_UNAVAILABLE') return top('sendUnavailable', '短信验证码发送失败，请稍后重试', 'Couldn’t send code. Try again later', 330, 375);
  return compact('服务暂时不可用，请稍后重试', 'Service unavailable. Try again later');
}
