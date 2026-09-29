import type { BillingSnapshot, BillingStatus, Language } from '../shared/product';
import { currentMembership } from './billing-presentation';

export type MembershipState = 'loading' | 'purchasable' | 'active' | 'exhausted' | 'pending' | 'paymentException' | 'salesUnavailable' | 'priceUnavailable' | 'networkUnavailable' | 'loginInvalid' | 'expired';
export interface MembershipPresentation {
  state: MembershipState; title: string; subtitle: string; productName: string;
  price: { prefix: string; value: string }; period: string; expiration: string | null;
  freeTitle: string; freeAction: string; freeBenefits: string[]; benefits: string[];
  action: string; enabled: boolean; command: 'billing-refresh' | 'payment-create' | 'payment-refresh' | null;
  message: string | null;
}
const authenticationErrors = new Set(['AUTH_REQUIRED', 'SESSION_EXPIRED', 'SESSION_REPLACED', 'SESSION_REPLAYED', 'ACCOUNT_DISABLED']);
const unavailable = { prefix: '', value: '—' };
const amount = (fen: number) => ({ prefix: '¥', value: (fen / 100).toFixed(2) });

/** Computes membership presentation from the current entitlement. */
export function membershipPresentation(billing: BillingSnapshot, language: Language): MembershipPresentation {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const { offer, payment: { order }, error } = billing;
  let status = billing.status;
  let state: MembershipState, price = unavailable, action: string, enabled = true, message: string | null = null;
  const networkMessage = t('暂时无法同步会员信息，请稍后重试。', 'Membership information could not be synced. Try again later.');
  const salesMessage = t('会员套餐暂不可购买，请稍后再试。', 'Membership is temporarily unavailable for purchase.');
  const priceMessage = t('价格暂未配置，请稍后再试。', 'Pricing is not configured yet. Try again later.');
  const verified = !billing.statusDisplayError && status?.status !== 'unavailable' ? status : null;
  const loginInvalid = !!error && authenticationErrors.has(error.code);
  // A failed sales quote must not replace a successful entitlement or an outstanding order.
  const effectiveError = error && (loginInvalid || (order?.status !== 'pending' && !currentMembership(verified)));
  if (error) status = loginInvalid ? null : verified;
  if (effectiveError) {
    state = loginInvalid ? 'loginInvalid' : error.code === 'BILLING_SALES_PAUSED' ? 'salesUnavailable'
      : error.code === 'BILLING_PRICE_UNAVAILABLE' ? 'priceUnavailable' : 'networkUnavailable';
    message = state === 'loginInvalid' ? t('登录状态已失效，请重新登录后查看。', 'Your session has expired. Sign in again to continue.')
      : state === 'salesUnavailable' ? salesMessage : state === 'priceUnavailable' ? priceMessage : networkMessage;
    enabled = state !== 'loginInvalid' && state !== 'priceUnavailable';
    action = state === 'loginInvalid' ? t('登录后查看', 'Sign In to View') : state === 'priceUnavailable' ? t('暂不可购买', 'Unavailable') : t('重新同步', 'Sync Again');
  } else if (order?.status === 'pending') {
    state = 'pending'; price = amount(order.amountFen); action = t('查看支付状态', 'View Payment Status');
    if (status?.status === 'unavailable') status = null;
    message = t('你有一笔待支付订单，可查看服务端支付状态。', 'You have a pending order. Check its server payment status.');
  } else if (status?.status === 'unavailable') {
    state = 'networkUnavailable'; status = null; message = networkMessage; action = t('重新同步', 'Sync Again');
  } else if (currentMembership(status)) {
    state = status!.status === 'exhausted' ? 'exhausted' : 'active'; enabled = false;
    price = status!.membershipPurchase ? amount(status!.membershipPurchase.paidAmountFen)
      : { prefix: '', value: t('本期实付暂不可用', 'Paid amount unavailable') };
    action = state === 'active' ? t('当前方案', 'Current Plan') : t('额度已用完', 'Allowance Used');
    if (state === 'exhausted') message = t('本期会员时长已用完，当前会员到期后可重新购买。', 'You have used all time for this membership. You can purchase again after it expires.');
  } else if (!offer) {
    state = 'loading'; enabled = false; action = t('请稍候', 'Please Wait');
  } else if (offer.amountFen <= 0) {
    state = 'priceUnavailable'; enabled = false; message = priceMessage; action = t('暂不可购买', 'Unavailable');
  } else {
    price = amount(offer.amountFen);
    if (!offer.purchasable || status?.purchaseAllowed === false) {
      state = 'salesUnavailable'; enabled = false; message = salesMessage; action = t('暂不可购买', 'Unavailable');
    } else if (order?.status === 'payment_exception') {
      state = 'paymentException'; action = t('检查异常订单', 'Check Order Issue');
      message = t('支付结果待确认，请勿重复支付。', 'Payment result pending. Do not pay again.');
    } else if (status?.kind === 'trial' && ['expired', 'exhausted'].includes(status.status)) {
      state = 'expired'; message = t('试用已结束', 'Trial has ended'); action = t('立即办理', 'Subscribe Now');
    } else if (status?.kind === 'monthly_membership' && status.status === 'expired') {
      state = 'expired'; action = t('立即办理', 'Subscribe Now');
      message = t('会员已到期，重新办理后可获得当前套餐时长。', 'Membership expired. Subscribe again for the current plan allowance.');
    } else { state = 'purchasable'; action = t('微信扫码购买', 'Buy with WeChat'); }
  }
  const minutes = Math.max(0, Math.ceil((status?.remainingDurationMs ?? 0) / 60_000));
  const included = Math.max(0, Math.ceil((offer?.includedDurationMs ?? 0) / 60_000));
  const freeAction = state === 'loginInvalid' ? t('登录后查看', 'Sign In to View')
    : !status ? state === 'loading' ? t('正在同步', 'Syncing') : t('状态待同步', 'Status unavailable')
    : status.kind === 'trial' && status.status === 'active' && status.remainingDurationMs > 0 ? t('当前方案', 'Current Plan') : t('试用已结束', 'Trial Ended');
  const freeAllowance = state === 'loginInvalid' ? t('登录后查看默认云服务用量', 'Sign in to view default cloud usage')
    : ((state === 'networkUnavailable' || state === 'pending') && !status) || status?.status === 'unavailable' ? t('默认云服务用量暂不可用', 'Default cloud usage is unavailable')
    : status?.kind === 'trial' && status.status === 'active' ? minutes > 0 ? t(`默认云服务当前可用 ${minutes} 分钟`, `Default cloud service currently has ${minutes} minutes available`)
      : t('默认云服务当前无可用时长', 'No default cloud time is currently available')
    : status ? t('默认云服务免费试用已结束', 'The default cloud free trial has ended') : t('默认云服务试用用量暂不可用', 'Default cloud trial usage is unavailable');
  return { state, title: t('会员套餐', 'Membership'), subtitle: t('选择适合你的默认云服务方案', 'Choose the default cloud plan that fits you'),
    productName: offer?.displayName ?? t('TxChat 会员套餐', 'TxChat Membership'), price, period: t('/ 月', '/ month'),
    expiration: membershipExpiration(status, language), freeTitle: t('免费', 'Free'), freeAction,
    freeBenefits: [freeAllowance, t('每账号一次免费试用', 'One free trial per account')],
    benefits: [included > 0 ? t(`默认云服务每月 ${included} 分钟`, `${included} minutes of default cloud service each month`)
      : t('默认云服务套餐用量以服务端为准', 'Default cloud allowance is provided by the server'),
    t('购买后生效 1 个月', 'Activates for one month after purchase'), t('权益与登录账号同步', 'Benefits sync with your signed-in account')],
    action, enabled, message, command: !enabled ? null : state === 'networkUnavailable' || state === 'salesUnavailable' ? 'billing-refresh' : state === 'pending' || state === 'paymentException' ? 'payment-refresh' : 'payment-create' };
}

function membershipExpiration(status: BillingStatus | null, language: Language): string | null {
  if (status?.kind !== 'monthly_membership' || !status.endsAt || !Number.isFinite(Date.parse(status.endsAt))) return null;
  const date = new Date(status.endsAt);
  if (language === 'zh') return `有效期至 ${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  return `Valid until ${new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)}`;
}
