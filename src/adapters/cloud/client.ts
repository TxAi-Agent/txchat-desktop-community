import type { BillingOffer, BillingOrder, BillingStatus, ProductError } from '../../shared/product';
import type { DiagnosticReceipt, ServiceAccount, ServiceAdapter, SessionBundle, SMSChallenge, SMSVerification } from '../services/integration';
export type { SessionBundle } from '../services/integration';

/** Opaque client identifier: no deployment-specific alphabet or identifier format. */
export const cloudId = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f|]/u.test(value);
const codes = new Set(['CLOUD_NOT_CONFIGURED', 'CLOUD_CONFIGURATION_INVALID', 'PROTOCOL_ERROR', 'OPERATION_FAILED',
  'CANCELLED', 'NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'AUTH_REQUIRED', 'SESSION_REPLACED', 'SESSION_EXPIRED',
  'SESSION_REPLAYED', 'ACCOUNT_DISABLED', 'TOO_MANY_REQUESTS', 'INVALID_PHONE_NUMBER', 'PHONE_INVALID',
  'SMS_PROVIDER_UNAVAILABLE', 'INVALID_REQUEST', 'PHONE_NOT_ALLOWED', 'INVALID_VERIFICATION_CODE',
  'VERIFICATION_CODE_INVALID_OR_EXPIRED', 'SERVICE_UNAVAILABLE', 'BILLING_NOT_CONFIGURED', 'BILLING_SALES_PAUSED',
  'BILLING_ORDER_PENDING', 'BILLING_MEMBERSHIP_ACTIVE', 'BILLING_PAYMENT_EXCEPTION', 'BILLING_INVALID_REQUEST',
  'BILLING_SERVICE_UNAVAILABLE', 'BILLING_QUOTA_EXHAUSTED', 'REPORT_ID_CONFLICT', 'DIAGNOSTIC_INVALID']);
const reasons = new Set(['incorrect', 'expired', 'exhausted', 'invalid_or_expired', 'verification_retry',
  'verification_locked', 'send_cooldown', 'send_quota']);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const text = (value: unknown, max = 256): value is string => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const token = (value: unknown): value is string => text(value, 8192) && !/\s/u.test(value);
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const duration = (value: unknown, min = 1): value is number => integer(value, min) &&
  Number.isSafeInteger(Date.now() + value * 1000) && Number.isFinite(new Date(Date.now() + value * 1000).getTime());
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudError('PROTOCOL_ERROR');
  return value as Record<string, unknown>;
};
function valid(condition: unknown): asserts condition { if (!condition) throw new CloudError('PROTOCOL_ERROR'); }

/** Only documented client error codes may reach UI; never expose adapter messages. */
export class CloudError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number;
  readonly reason: string | undefined;
  readonly attemptsRemaining: number | undefined;
  constructor(code: string, retryAfterSeconds = 0, reason?: string, attemptsRemaining?: number) {
    const safe = codes.has(code) ? code : 'OPERATION_FAILED'; super(safe); this.code = safe;
    this.retryAfterSeconds = integer(retryAfterSeconds) && retryAfterSeconds * 1000 <= 2_147_483_647 ? retryAfterSeconds : 0;
    this.reason = reason && reasons.has(reason) ? reason : undefined;
    this.attemptsRemaining = integer(attemptsRemaining) ? attemptsRemaining : undefined;
  }
  get publicError(): ProductError { return { code: this.code, ...(this.reason ? { reason: this.reason } : {}),
    ...(this.attemptsRemaining === undefined ? {} : { attemptsRemaining: this.attemptsRemaining }) }; }
}

function session(value: unknown): SessionBundle {
  const v = record(value), access = record(v.access), refresh = record(v.refresh);
  valid(token(access.accessToken) && duration(access.accessExpiresInSeconds) && cloudId(access.deviceId) && cloudId(access.sessionId));
  valid(token(refresh.refreshToken) && duration(refresh.refreshSlidingExpiresInSeconds));
  return { access: { accessToken: access.accessToken, accessExpiresInSeconds: access.accessExpiresInSeconds,
    deviceId: access.deviceId, sessionId: access.sessionId }, refresh: { refreshToken: refresh.refreshToken,
    refreshSlidingExpiresInSeconds: refresh.refreshSlidingExpiresInSeconds } };
}
function account(value: unknown): ServiceAccount {
  const v = record(value); valid(text(v.maskedPhone, 128) && v.loggedIn === true);
  return { maskedPhone: v.maskedPhone, loggedIn: true };
}
function offer(value: unknown): BillingOffer {
  const v = record(value);
  valid(cloudId(v.productId) && text(v.displayName) && integer(v.amountFen, 1) && v.currency === 'CNY' &&
    integer(v.includedDurationMs, 1) && typeof v.purchasable === 'boolean');
  return { productId: v.productId, displayName: v.displayName, amountFen: v.amountFen, currency: v.currency,
    includedDurationMs: v.includedDurationMs, purchasable: v.purchasable };
}
function status(value: unknown): BillingStatus {
  const v = record(value);
  valid(['trial', 'monthly_membership', 'none'].includes(v.kind as string) &&
    ['active', 'exhausted', 'expired', 'voided', 'refunded', 'unavailable'].includes(v.status as string) &&
    integer(v.remainingDurationMs) && nullableDate(v.startsAt) && nullableDate(v.endsAt) && typeof v.purchaseAllowed === 'boolean');
  let membershipPurchase: BillingStatus['membershipPurchase'] = null;
  if (v.membershipPurchase !== null) {
    const purchase = record(v.membershipPurchase); valid(integer(purchase.paidAmountFen, 1) && purchase.currency === 'CNY');
    valid(v.kind === 'monthly_membership' && ['active', 'exhausted'].includes(v.status as string));
    membershipPurchase = { paidAmountFen: purchase.paidAmountFen, currency: purchase.currency };
  } else valid(!(v.kind === 'monthly_membership' && ['active', 'exhausted'].includes(v.status as string)));
  return { kind: v.kind as BillingStatus['kind'], status: v.status as BillingStatus['status'],
    remainingDurationMs: v.remainingDurationMs, startsAt: v.startsAt as string | null, endsAt: v.endsAt as string | null,
    purchaseAllowed: v.purchaseAllowed, membershipPurchase };
}
function order(value: unknown): BillingOrder {
  const v = record(value);
  valid(cloudId(v.orderId) && ['pending', 'paid', 'expired', 'payment_exception', 'refunded'].includes(v.status as string) &&
    integer(v.amountFen, 1) && v.currency === 'CNY' && date(v.createdAt) && date(v.expiresAt) && date(v.serverTime) &&
    nullableDate(v.codeUrlRecoveryAvailableAt) && nullableDate(v.paidAt) && (v.codeUrl === null || text(v.codeUrl, 4096)) &&
    (v.paidAmountFen === null || integer(v.paidAmountFen, 1)));
  valid(Date.parse(v.expiresAt) > Date.parse(v.createdAt));
  if (v.status === 'pending') valid(v.paidAt === null && v.paidAmountFen === null);
  else valid(v.codeUrl === null && v.codeUrlRecoveryAvailableAt === null);
  if (v.status === 'paid' || v.status === 'refunded') valid(v.paidAt !== null && v.paidAmountFen === v.amountFen);
  if (v.status === 'expired') valid(v.paidAt === null && v.paidAmountFen === null);
  if (v.status === 'payment_exception') valid(v.paidAt === null ? v.paidAmountFen === null : v.paidAmountFen === v.amountFen);
  return { orderId: v.orderId, status: v.status as BillingOrder['status'], amountFen: v.amountFen, currency: v.currency,
    codeUrl: v.codeUrl as string | null, codeUrlRecoveryAvailableAt: v.codeUrlRecoveryAvailableAt as string | null,
    createdAt: v.createdAt, expiresAt: v.expiresAt, serverTime: v.serverTime, paidAt: v.paidAt as string | null,
    paidAmountFen: v.paidAmountFen as number | null };
}

/** Domain facade. Developers implement their own transport behind ServiceAdapter. */
export class CloudClient {
  readonly origin: string | null;
  private recoverAccess: ((rejected: string) => Promise<string>) | null = null;
  constructor(private readonly adapter: ServiceAdapter | null) {
    if (adapter && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(adapter.scope)) throw new CloudError('CLOUD_CONFIGURATION_INVALID');
    this.origin = adapter?.scope ?? null;
  }
  setAccessRecovery(recover: (rejected: string) => Promise<string>) { this.recoverAccess = recover; }
  private async call<T>(signal: AbortSignal, operation: (adapter: ServiceAdapter) => Promise<T>): Promise<T> {
    if (!this.adapter) throw new CloudError('CLOUD_NOT_CONFIGURED');
    if (signal.aborted) throw new CloudError('CANCELLED');
    try {
      const result = await operation(this.adapter);
      if (signal.aborted) throw new CloudError('CANCELLED');
      return result;
    } catch (error) {
      if (signal.aborted) throw new CloudError('CANCELLED');
      if (error instanceof CloudError) throw error;
      throw new CloudError('SERVICE_UNAVAILABLE');
    }
  }
  private async authorized<T>(access: string, signal: AbortSignal, operation: (adapter: ServiceAdapter, token: string) => Promise<T>): Promise<T> {
    try { return await this.call(signal, a => operation(a, access)); }
    catch (error) {
      if (!(error instanceof CloudError) || !['AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(error.code) || !this.recoverAccess) throw error;
      const next = await this.recoverAccess(access);
      if (!token(next)) throw new CloudError('PROTOCOL_ERROR');
      return this.call(signal, a => operation(a, next));
    }
  }
  async requestSMS(phone: string, signal: AbortSignal): Promise<SMSChallenge> {
    return this.call(signal, async a => { const v = record(await a.requestSMS(phone, signal));
      valid(cloudId(v.challengeId) && duration(v.expiresInSeconds) && duration(v.resendAfterSeconds, 0));
      return { challengeId: v.challengeId, expiresInSeconds: v.expiresInSeconds, resendAfterSeconds: v.resendAfterSeconds }; });
  }
  async verifySMS(challengeId: string, code: string, signal: AbortSignal, inviteCode?: string): Promise<SMSVerification> {
    return this.call(signal, async a => { const v = record(await a.verifySMS(challengeId, code, signal, inviteCode));
      valid(typeof v.accountCreated === 'boolean'); return { accountCreated: v.accountCreated, account: account(v.account), session: session(v.session) }; });
  }
  async refresh(refreshToken: string, requestId: string, signal: AbortSignal, timeoutMs?: number) {
    return this.call(signal, async a => session(await a.refresh(refreshToken, requestId, signal, timeoutMs)));
  }
  async account(access: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => account(await a.account(t, signal))); }
  async accountContext(access: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => {
    const id = await a.accountContext(t, signal); valid(cloudId(id)); return id; }); }
  async logout(access: string, signal: AbortSignal) { await this.call(signal, a => a.logout(access, signal)); }
  async offer(access: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => offer(await a.offer(t, signal))); }
  async status(access: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => status(await a.status(t, signal))); }
  async currentOrder(access: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => {
    const value = await a.currentOrder(t, signal); return value === null ? null : order(value); }); }
  async createOrder(access: string, key: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => order(await a.createOrder(t, key, signal))); }
  async order(access: string, id: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => {
    valid(cloudId(id)); const result = order(await a.order(t, id, signal)); valid(result.orderId === id); return result; }); }
  async recoverOrder(access: string, id: string, key: string, signal: AbortSignal) { return this.authorized(access, signal, async (a, t) => {
    valid(cloudId(id)); const result = order(await a.recoverOrder(t, id, key, signal)); valid(result.orderId === id); return result; }); }
  async reportDiagnostics(payload: object, signal: AbortSignal): Promise<DiagnosticReceipt> { return this.call(signal, async a => {
    const value = record(await a.reportDiagnostics(payload, signal));
    valid(cloudId(value.diagnosticNumber) && cloudId(value.reportId) && date(value.receivedAt));
    return { diagnosticNumber: value.diagnosticNumber, reportId: value.reportId, receivedAt: value.receivedAt }; }); }
  async diagnostic(payload: object, signal: AbortSignal) { return this.reportDiagnostics(payload, signal); }
}
