import type { BillingOffer, BillingStatus } from '../shared/product';

/** Uses the actual receipt for the current period, including exhausted memberships. */
export function currentMembership(status: BillingStatus | null) {
  return status?.kind === 'monthly_membership' && (status.status === 'active' || status.status === 'exhausted');
}
export function membershipPrice(status: BillingStatus | null, offer: BillingOffer | null): number | null {
  return currentMembership(status) ? status!.membershipPurchase?.paidAmountFen ?? null : offer?.amountFen ?? null;
}
export function usageProgress(status: BillingStatus | null, offer: BillingOffer | null, unavailable: boolean): number {
  if (unavailable || !status) return 0;
  const total = status.kind === 'trial' ? 3_600_000 : status.kind === 'monthly_membership' ? offer?.includedDurationMs ?? 0 : 0;
  return total > 0 ? Math.min(100, Math.max(0, status.remainingDurationMs / total * 100)) : 0;
}

/** Allowance formatting: round partial seconds up; do not discard seconds or convert minutes to hours. */
export function allowanceText(status: BillingStatus | null, unavailable: boolean, language: 'zh' | 'en'): string {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  if (unavailable || !status || status.status === 'unavailable') return t('用量暂不可用', 'Usage unavailable');
  if (status.remainingDurationMs <= 0) return t('无可用时长', 'No time available');
  const total = Math.ceil(status.remainingDurationMs / 1000), minutes = Math.floor(total / 60), seconds = total % 60;
  return seconds > 0 ? minutes > 0 ? t(`剩余 ${minutes} 分 ${seconds} 秒可用`, `${minutes}m ${seconds}s remaining`)
    : t(`剩余 ${seconds} 秒可用`, `${seconds}s remaining`)
    : t(`剩余 ${minutes} 分钟可用`, `${minutes} min remaining`);
}
