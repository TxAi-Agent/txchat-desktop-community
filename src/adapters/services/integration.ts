import type { BillingOffer, BillingOrder, BillingStatus } from '../../shared/product';

/** Client domain values, not a transport or server response specification. */
export interface SessionBundle {
  access: { accessToken: string; accessExpiresInSeconds: number; deviceId: string; sessionId: string };
  refresh: { refreshToken: string; refreshSlidingExpiresInSeconds: number };
}
export interface ServiceAccount { maskedPhone: string; loggedIn: true }
export interface SMSChallenge { challengeId: string; expiresInSeconds: number; resendAfterSeconds: number }
export interface SMSVerification { accountCreated: boolean; account: ServiceAccount; session: SessionBundle }
export interface DiagnosticReceipt { diagnosticNumber: string; reportId: string; receivedAt: string }

/** Implement in the main process, translating your own service protocol to these
 * domain values. No endpoint, transport, account, or credentials are supplied.
 * Abort in-flight work when signalled and do not log tokens or submitted data.
 * Refresh request IDs and billing keys identify retries of the same operation. */
export interface ServiceAdapter {
  /** Stable non-URL configuration label. Change it when switching account realms. */
  readonly scope: string;
  requestSMS(phone: string, signal: AbortSignal): Promise<SMSChallenge>;
  verifySMS(challengeId: string, verificationCode: string, signal: AbortSignal, inviteCode?: string): Promise<SMSVerification>;
  refresh(refreshToken: string, requestId: string, signal: AbortSignal, timeoutMs?: number): Promise<SessionBundle>;
  account(accessToken: string, signal: AbortSignal): Promise<ServiceAccount>;
  accountContext(accessToken: string, signal: AbortSignal): Promise<string>;
  logout(accessToken: string, signal: AbortSignal): Promise<void>;
  offer(accessToken: string, signal: AbortSignal): Promise<BillingOffer>;
  status(accessToken: string, signal: AbortSignal): Promise<BillingStatus>;
  currentOrder(accessToken: string, signal: AbortSignal): Promise<BillingOrder | null>;
  createOrder(accessToken: string, idempotencyKey: string, signal: AbortSignal): Promise<BillingOrder>;
  order(accessToken: string, orderId: string, signal: AbortSignal): Promise<BillingOrder>;
  recoverOrder(accessToken: string, orderId: string, idempotencyKey: string, signal: AbortSignal): Promise<BillingOrder>;
  reportDiagnostics(payload: object, signal: AbortSignal): Promise<DiagnosticReceipt>;
}

/** Supply your own adapter here to enable account, billing and diagnostic services. */
export function createServiceAdapter(): ServiceAdapter | null { return null; }
