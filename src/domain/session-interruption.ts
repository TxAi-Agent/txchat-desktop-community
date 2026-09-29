import type { AuthSnapshot } from '../shared/product';
export function sessionInterruption(reason: NonNullable<AuthSnapshot['interruption']>, language: 'zh' | 'en') {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  return {
    title: reason === 'replaced' ? t('账号已在其他设备登录', 'Signed in on another device') : reason === 'disabled' ? t('账号已停用', 'Account disabled') : t('登录状态已过期', 'Login session expired'),
    detail: reason === 'disabled' ? t('此账号当前无法使用，请联系支持人员', 'This account is unavailable. Please contact support.') : t('重新登录后可继续使用', 'Log in again to continue'),
    action: reason === 'disabled' ? t('返回登录', 'Back to Login') : t('重新登录', 'Log In Again'),
    status: reason === 'replaced' ? t('TxChat 已停止', 'TxChat Stopped') : t('TxChat 需要登录', 'TxChat Needs Login'),
    illustration: reason === 'replaced' ? 'conflict' : 'expired',
  };
}
