import type { DocumentKind, ProductDocument } from './documents';
import type { DiagnosticState } from './diagnostics';
import type { ShortcutDisplayLabel } from './shortcut-bindings';
import type { SoftwareUpdateSnapshot, SoftwareUpdateAction } from './software-update';
import type { ShortcutEditorSnapshot } from './shortcut-editor';
import type { HotkeyBinding } from './native-input';

export type ProductPage = 'status' | 'membership' | 'custom-ai' | 'dictionary';
export type Language = 'zh' | 'en';
export type Theme = 'system' | 'light' | 'dark';
export type DictationMode = 'smart' | 'verbatim';
export type ServiceChoice = 'cloud' | 'custom' | 'local';
export interface Preferences { language: Language; theme: Theme; mode: DictationMode; service: ServiceChoice; shortcut: HotkeyBinding; shortcutLabel?: ShortcutDisplayLabel }
export interface ProductError { code: string; reason?: string; attemptsRemaining?: number }
export interface AuthSnapshot {
  /** Saved credentials are being verified; never grants access by itself. */
  restorePending?: boolean;
  busy: boolean; signedIn: boolean; demo: boolean; identityPending: boolean; maskedPhone: string | null;
  requestingSMS: boolean; verifyingSMS: boolean; phoneMatchesChallenge: boolean; codeWasRejected: boolean;
  smsRequestLocked: boolean; resendDisplayOffset: number; codeResetGeneration: number; codeFocusGeneration: number;
  loginErrorSource: 'send' | 'verify' | 'restore' | null;
  challengeExpiresAt: number; resendAt: number; verifyAt: number; error: ProductError | null;
  interruption: 'expired' | 'replaced' | 'disabled' | null;
}
export interface BillingOffer { productId: string; displayName: string; amountFen: number; currency: 'CNY'; includedDurationMs: number; purchasable: boolean }
export interface BillingStatus {
  kind: 'trial' | 'monthly_membership' | 'none'; status: 'active' | 'exhausted' | 'expired' | 'voided' | 'refunded' | 'unavailable';
  remainingDurationMs: number; startsAt: string | null; endsAt: string | null; purchaseAllowed: boolean;
  membershipPurchase: { paidAmountFen: number; currency: 'CNY' } | null;
}
export interface BillingOrder {
  orderId: string; status: 'pending' | 'paid' | 'expired' | 'payment_exception' | 'refunded'; amountFen: number; currency: 'CNY';
  codeUrl: string | null; codeUrlRecoveryAvailableAt: string | null; createdAt: string; expiresAt: string; serverTime: string;
  paidAt: string | null; paidAmountFen: number | null;
}
export type PaymentPhase = 'closed' | 'loading' | 'preparing' | 'qr-ready' | 'confirming' | 'unconfirmed' | 'synchronizing' | 'restoring' |
  'membership-sync-pending' | 'success' | 'expired' | 'payment-exception' | 'unavailable';
export interface BillingSnapshot {
  loading: boolean; offer: BillingOffer | null; status: BillingStatus | null; error: ProductError | null; statusDisplayError: ProductError | null;
  payment: { phase: PaymentPhase; busy: boolean; order: BillingOrder | null; qrDataUrl: string | null; error: ProductError | null };
}
export interface DictionaryEntry { wrong: string; correct: string; enabled: boolean }
export interface DictionarySnapshot { revision?: number; notice?: 'loadFailed' | 'reloadFailed' | 'saveFailed' | 'openFileFailed' | null; entries: DictionaryEntry[]; busy: boolean; skippedLines: number; error: ProductError | null }
export type CustomCategory = 'asr' | 'optimization';
export interface PublicProviderConfiguration { providerId: string; modelId: string; values: Record<string, string>; configuredFields: string[] }
export interface CustomTestResult { generation: number; phase: 'idle' | 'running' | 'passed' | 'failed'; category: 'asr' | 'optimization' | 'all'; providerId: string | null; code: string | null; configurationVersion: number }
export interface CustomSnapshot {
  selected: Record<CustomCategory, string>;
  configurations: Record<CustomCategory, PublicProviderConfiguration[]>;
  busy: boolean; version: number; error: ProductError | null; test: CustomTestResult;
}
export type ProductStage = 'launching' | 'setup-unavailable' | 'signed-out' | 'onboarding' | 'ready' | 'interrupted';
export interface ProductSnapshot {
  stage: ProductStage; page: ProductPage;
  shortcutEditor?: ShortcutEditorSnapshot | null;
  preferences: Preferences; environment: { configured: boolean; origin: string | null; label: string };
  auth: AuthSnapshot; onboarding: { step: 'microphone' | 'accessibility' | 'voice-test' | 'complete'; completed: boolean };
  billing: BillingSnapshot; dictionary: DictionarySnapshot; custom: CustomSnapshot;
  voiceTest: boolean; voiceTestResult: string | null; notice: string | null; storageError: ProductError | null;
  diagnostics: DiagnosticState;
  document?: ProductDocument | null;
  update: SoftwareUpdateSnapshot;
}
export type ProductCommand =
  { type: SoftwareUpdateAction } |
  { type: 'shortcut-open' } |
  { type: 'shortcut-capture' | 'shortcut-save' | 'shortcut-cancel'; sessionId: string } |
  { type: 'product-page'; page: ProductPage } |
  { type: 'preferences'; language?: Language; theme?: Theme; mode?: DictationMode; service?: ServiceChoice } |
  { type: 'auth-phone-edited'; phone: string } |
  { type: 'auth-code-edited'; code: string } |
  { type: 'auth-send'; phone: string; acceptedTerms: boolean } |
  { type: 'auth-verify'; code: string; acceptedTerms: boolean; inviteCode?: string } |
  { type: 'auth-restore' | 'auth-logout' | 'auth-reauthenticate' | 'demo-enter' | 'onboarding-permission' | 'permissions-repair' | 'onboarding-next' | 'voice-test-start' | 'voice-test-stop' | 'voice-test-skip' | 'voice-test-close' } |
  { type: 'billing-refresh' | 'payment-create' | 'payment-refresh' | 'payment-recover' | 'payment-close' } |
  { type: 'dictionary-save'; entries: DictionaryEntry[] } |
  { type: 'dictionary-reload' | 'dictionary-open' } |
  { type: 'custom-save'; category: CustomCategory; providerId: string; modelId: string; values: Record<string, string>; clearFields: string[]; select: boolean } |
  { type: 'custom-apply'; enabled: boolean } |
  { type: 'custom-select'; category: CustomCategory; providerId: string } |
  { type: 'custom-test'; category: CustomCategory | 'all'; providerId?: string; modelId?: string; values?: Record<string, string>; clearFields?: string[] } |
  { type: 'custom-test-cancel' | 'result-copy' | 'diagnostics-send' | 'diagnostics-retry' | 'diagnostics-discard' | 'diagnostics-done' | 'document-close' } |
  { type: 'system-settings'; capability: 'microphone' | 'accessibility' } |
  { type: 'document-open'; document: DocumentKind };
