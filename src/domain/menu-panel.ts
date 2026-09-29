import type { AppSnapshot } from '../shared/contracts';
import { hudPresentation } from './hud';

/** ProductPresentation.menu: a live summary, with no credentials or transcript in its copy. */
export function menuPresentation(snapshot: AppSnapshot) {
  const { product, dictation, input, audio, helper } = snapshot;
  const t = (zh: string, en: string) => product.preferences.language === 'zh' ? zh : en;
  const ready = ['granted', 'systemManaged'].includes(audio.status?.permission ?? '') &&
    ['granted', 'notRequired'].includes(input.status?.accessibility ?? '') && input.status?.enabled && helper.status === 'ready';
  let title: string, detail: string;
  const setupUnavailable = product.stage === 'setup-unavailable';
  switch (product.stage) {
    case 'launching': title = t('正在准备', 'TxChat Is Starting'); detail = t('正在准备本机体验', 'Preparing TxChat'); break;
    case 'setup-unavailable': title = t('TxChat 需要设置', 'TxChat Needs Setup'); detail = t('服务尚未配置', 'Service Not Configured'); break;
    case 'signed-out': title = t('未登录', 'TxChat Needs Login'); detail = t('打开 TxChat 完成登录', 'Open TxChat to log in'); break;
    case 'onboarding': title = t('TxChat 需要设置', 'TxChat Needs Setup'); detail = t('完成设置即可开始听写', 'Complete setup to start dictation'); break;
    case 'interrupted': title = t('TxChat 需要登录', 'TxChat Needs Login'); detail = t('打开 TxChat 重新登录', 'Open TxChat to log in again'); break;
    case 'ready':
      if (['idle', 'completed'].includes(dictation.phase)) {
        title = ready ? t('TxChat 已就绪', 'TxChat Ready') : t('TxChat 需要设置', 'TxChat Needs Setup'); detail = t('可以开始听写', 'Ready to start dictation');
      } else {
        const overlay = hudPresentation({ ...dictation, cancelled: false }, product.preferences.language);
        title = overlay.title; detail = dictation.phase === 'listening' ? t('正在识别语音', 'Recognizing voice') : overlay.detail;
      }
  }
  return { title, detail, kind: !setupUnavailable && ['ready', 'onboarding'].includes(product.stage) ? 'success' : 'attention',
    open: t('打开 TxChat', 'Open TxChat'), quit: t('退出 TxChat', 'Quit TxChat') } as const;
}

export function menuPosition(anchor: { x: number; y: number; width: number; height: number }, area: { x: number; y: number; width: number; height: number }) {
  const x = Math.round(Math.min(Math.max(area.x, anchor.x + anchor.width / 2 - 180), Math.max(area.x, area.x + area.width - 360)));
  const below = anchor.y + anchor.height + 4;
  const y = Math.round(Math.max(area.y, Math.min(below + 220 <= area.y + area.height ? below : anchor.y - 224, area.y + area.height - 220)));
  return { x, y };
}
