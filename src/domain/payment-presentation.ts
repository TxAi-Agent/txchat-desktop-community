import type { BillingSnapshot, Language } from '../shared/product';

export type PaymentState = 'scan' | 'preparing' | 'confirming' | 'unconfirmed' | 'synchronizing' | 'activatingMembership' | 'membershipSyncPending' | 'success' | 'restoring' | 'uncertain' | 'expired' | 'incomplete';
export interface PaymentPresentation {
  state: PaymentState; screenTitle: string; productName: string; productDescription: string;
  prefix: string; amount: string; title: string; detail: string; inlineAction: string | null;
  countdown: string; countdownKey: string | null; countdownSeconds: number | null;
  qr: string | null; scanWarning: boolean; busy: boolean;
  orderReference: string | null;
}
function isPreparingNewPayment(payment: BillingSnapshot['payment']): boolean {
  return payment.phase === 'preparing' && (!payment.order || ['expired', 'refunded'].includes(payment.order.status));
}
export function paymentCountdownKey(billing: BillingSnapshot): string | null {
  if (isPreparingNewPayment(billing.payment)) return null;
  const order = billing.payment.order;
  return order && Number.isFinite(Date.parse(order.expiresAt)) && Number.isFinite(Date.parse(order.serverTime))
    ? `${order.orderId}:${order.expiresAt}:${order.serverTime}` : null;
}

/** Presentation never treats a local countdown, click or QR render as proof of payment. */
export function paymentPresentation(billing: BillingSnapshot, language: Language, elapsedSeconds = 0, qrRenderFailed = false): PaymentPresentation {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const { payment, offer } = billing, { order, phase } = payment;
  let state: PaymentState;
  if (order?.status === 'paid') state = phase === 'success' ? 'success' : phase === 'membership-sync-pending' ? 'membershipSyncPending' : 'activatingMembership';
  else if (isPreparingNewPayment(payment)) state = 'preparing';
  else if (order?.status === 'expired') state = 'expired';
  else if (order?.status === 'payment_exception') state = 'uncertain';
  else if (order?.status === 'refunded') state = 'incomplete';
  else state = phase === 'loading' || phase === 'synchronizing' ? 'synchronizing' : phase === 'confirming' ? 'confirming'
    : phase === 'unconfirmed' || phase === 'success' ? 'unconfirmed' : phase === 'restoring' ? 'restoring'
    : phase === 'membership-sync-pending' ? 'membershipSyncPending' : phase === 'expired' ? 'expired'
    : phase === 'payment-exception' ? 'uncertain' : phase === 'unavailable' ? 'incomplete' : 'scan';
  const validQR = order?.status === 'pending' && !!order.codeUrl?.startsWith('weixin://wxpay/');
  if (state === 'scan' && !validQR) state = 'incomplete';
  const countdownKey = paymentCountdownKey(billing);
  const initialSeconds = countdownKey && order ? Math.max(0, Math.floor((Date.parse(order.expiresAt) - Date.parse(order.serverTime)) / 1000)) : null;
  const countdownSeconds = initialSeconds === null ? null : Math.max(0, initialSeconds - Math.max(0, Math.floor(elapsedSeconds)));
  const serverExpired = state === 'scan' && initialSeconds !== null && initialSeconds <= 0;
  if (serverExpired) state = 'expired';
  const locallyExpired = state === 'scan' && countdownSeconds !== null && countdownSeconds <= 0;
  const renderFailure = state === 'scan' && qrRenderFailed;
  if (renderFailure) state = 'incomplete';
  else if (locallyExpired) state = 'expired';
  const copy: Record<PaymentState, [string, string]> = {
    scan: [t('微信扫码支付', 'Pay with WeChat'), t('请使用微信扫描二维码完成支付', 'Scan the QR code with WeChat to pay')],
    preparing: [t('正在准备支付二维码', 'Preparing payment QR code'), t('请稍候', 'Please wait')],
    confirming: [t('正在确认支付结果', 'Confirming payment'), t('请稍候，不要重复支付', 'Please wait and do not pay again')],
    unconfirmed: [t('暂未确认支付结果', 'Payment not confirmed'), t('我们会继续同步，请勿重复支付', 'We will keep syncing. Do not pay again')],
    synchronizing: [t('正在同步订单', 'Syncing order'), t('正在确认已有订单状态', 'Checking the existing order')],
    activatingMembership: [t('支付已确认', 'Payment confirmed'), t('正在同步会员权益，请勿重复支付', 'Syncing membership access. Do not pay again')],
    membershipSyncPending: [t('支付已确认，权益待同步', 'Payment confirmed; access pending'), t('请勿重复支付，可点击刷新再次同步', 'Do not pay again. Refresh to sync membership access')],
    success: [t('支付成功', 'Payment successful'), t('会员时长已更新', 'Membership time has been updated')],
    restoring: [t('正在恢复二维码', 'Restoring QR code'), t('请稍候', 'Please wait')],
    uncertain: [t('支付结果待确认', 'Payment result pending'), t('请勿重复支付，稍后可再次同步', 'Do not pay again. Sync again later')],
    expired: [t('二维码已过期', 'QR code expired'), t('请先检查订单状态，再关闭窗口返回会员套餐。', 'Check the order status, then close this window to return to Membership.')],
    incomplete: [t('支付信息不完整', 'Payment details incomplete'), t('请点击刷新同步服务端订单信息', 'Refresh to sync server order details')],
  };
  let [title, detail] = copy[state];
  let inlineAction = state === 'expired' ? t('检查订单', 'Check Order')
    : ['unconfirmed', 'membershipSyncPending', 'uncertain', 'incomplete'].includes(state) ? t('刷新', 'Refresh') : null;
  const scanWarning = state === 'scan' && payment.error !== null;
  if (order?.status === 'refunded' && state !== 'preparing') { title = t('订单已退款', 'Order refunded'); detail = t('该订单无法继续支付，请勿重复支付', 'This order cannot be paid again. Do not submit another payment.'); }
  else if (renderFailure) { title = t('二维码无法显示', 'QR code unavailable'); detail = t('请刷新并同步服务端订单信息', 'Refresh to sync payment information with the server'); inlineAction = t('刷新', 'Refresh'); }
  else if (locallyExpired) { detail = t('请刷新并同步服务端订单信息', 'Refresh to sync the order with the server'); inlineAction = t('刷新', 'Refresh'); }
  else if (scanWarning) { detail = t('支付码仍有效，订单同步暂时失败，可点击刷新。', 'The QR code remains valid, but order sync failed. Refresh to try again.'); inlineAction = t('刷新', 'Refresh'); }
  const included = Math.max(0, Math.ceil((offer?.includedDurationMs ?? 0) / 60_000));
  const clock = countdownSeconds === null ? null : `${Math.floor(countdownSeconds / 60).toString().padStart(2, '0')}:${(countdownSeconds % 60).toString().padStart(2, '0')}`;
  const createdAt = order ? new Date(order.createdAt) : null;
  const createdLabel = createdAt && Number.isFinite(createdAt.getTime()) ? new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB',
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(createdAt) : null;
  const orderReference = state === 'uncertain' && order
    ? t(`订单尾号 ${order.orderId.slice(-8)}`, `Order ending ${order.orderId.slice(-8)}`) + (createdLabel ? ` · ${createdLabel}` : '') : null;
  return { state, screenTitle: t('微信扫码支付', 'Pay with WeChat'), productName: offer?.displayName ?? t('TxChat 会员套餐', 'TxChat Membership'),
    productDescription: included ? t(`默认云服务 ${included} 分钟，购买后生效 1 个月`, `${included} minutes of default cloud service, active for one month`) : t('套餐信息待同步', 'Plan details pending sync'),
    prefix: order && state !== 'preparing' ? '¥' : '', amount: order && state !== 'preparing' ? (order.amountFen / 100).toFixed(2) : '—', title, detail, inlineAction,
    countdown: state !== 'scan' ? '' : clock ? t(`请在 ${clock} 内完成支付`, `Complete payment within ${clock}`) : t('有效期以服务端为准', 'Validity is determined by the server'),
    countdownKey, countdownSeconds, qr: state === 'scan' ? payment.qrDataUrl : null, scanWarning, orderReference,
    busy: ['preparing', 'confirming', 'synchronizing', 'activatingMembership', 'restoring'].includes(state) };
}
