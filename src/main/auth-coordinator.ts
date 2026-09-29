import { randomUUID } from 'node:crypto';
import type { AuthSnapshot, ProductError } from '../shared/product';
import { CloudClient, CloudError, type SessionBundle } from '../adapters/cloud/client';
import { ProductStore, type StoredSession } from './product-store';
import { loginDigits, loginPhoneDigits } from '../domain/login-presentation';
import { accountPhoneDisplay, verifiedPhoneDisplay } from '../domain/account-phone';
const initial = (): AuthSnapshot => ({ busy: false, signedIn: false, restorePending: false, demo: false, identityPending: false, maskedPhone: null, requestingSMS: false, verifyingSMS: false, phoneMatchesChallenge: false, codeWasRejected: false, smsRequestLocked: false, resendDisplayOffset: 0, codeResetGeneration: 0, codeFocusGeneration: 0, loginErrorSource: null, challengeExpiresAt: 0, resendAt: 0, verifyAt: 0, error: null, interruption: null });
const interruptions = ['AUTH_REQUIRED', 'SESSION_REPLACED', 'SESSION_EXPIRED', 'SESSION_REPLAYED', 'ACCOUNT_DISABLED'];
export function publicError(error: unknown, fallback = 'OPERATION_FAILED'): ProductError {
  if (error instanceof CloudError) return error.publicError;
  const known = ['CANCELLED', 'NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'RESPONSE_TOO_LARGE', 'PROXY_AUTH_REQUIRED', 'ENDPOINT_NOT_ALLOWED',
    'CUSTOM_AI_INVALID_CONFIGURATION', 'VOICE_TEST_SAVE_FAILED', 'ONBOARDING_SAVE_FAILED', 'STORAGE_WRITE_FAILED', 'STORAGE_READ_FAILED', 'SETTINGS_READ_FAILED', 'SECURE_STORAGE_READ_FAILED', 'SECURE_STORAGE_UNAVAILABLE',
    'DICTIONARY_LIMIT', 'DICTIONARY_INVALID_ENTRY', 'DICTIONARY_DUPLICATE', 'DICTIONARY_ENCODING', 'DICTIONARY_SCHEMA', 'DICTIONARY_FORMAT'];
  return { code: error instanceof Error && known.includes(error.message) ? error.message : fallback };
}
export class AuthCoordinator {
  private state = initial(); private abort = new AbortController(); private epoch = 0; private disposed = false;
  private challenge: { id: string; phone: string } | null = null;
  private session: StoredSession | null = null; private refreshing: Promise<string> | null = null;
  private sessionWrites: Promise<void> = Promise.resolve();
  private phone = ''; private rejectedCode: string | null = null; private restoreBlocked = false;
  private restoration: Promise<void> | null = null;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreAttempt = 0;
  private serverRetryNotBefore = 0;
  private restorationPaused = false;
  private readonly loginTimer: ReturnType<typeof setInterval>;
  constructor(private readonly cloud: CloudClient, private readonly store: ProductStore,
    private readonly publish: () => void, private readonly invalidateTasks: () => void) {
    cloud.setAccessRecovery((rejected) => this.recoverRejected(rejected));
    this.loginTimer = setInterval(() => this.refreshLoginTiming(), 1000);
    this.loginTimer.unref();
  }
  async recoverRejected(rejected: string) {
    if (!this.session || this.disposed) throw new CloudError('AUTH_REQUIRED');
    try { return this.session.accessToken !== rejected && this.session.accessExpiresAt > Date.now() + 30_000 ? this.session.accessToken : await this.refreshAccess(); }
    catch (error) { this.handleError(error); throw error; }
  }
  get snapshot(): AuthSnapshot { return structuredClone(this.state); }
  get accountKey() { return this.state.demo ? 'local-development' : !this.state.identityPending && this.session?.accountId ? `${this.session.origin}|${this.session.accountId}` : null; }
  private update(change: Partial<AuthSnapshot>) { if (!this.disposed) { this.state = { ...this.state, ...change }; this.publish(); } }
  private current(epoch: number) { return !this.disposed && this.epoch === epoch; }
  /** Merge independent identity/token changes at commit time, after earlier writes.
   * Capturing a full session before an await can resurrect old tokens or erase identity. */
  private commitSession(epoch: number, change: (current: StoredSession) => StoredSession): Promise<StoredSession> {
    const write = this.sessionWrites.then(async () => {
      if (!this.current(epoch) || !this.session) throw new Error('CANCELLED');
      const next = change(this.session);
      await this.store.updateSession(next);
      if (!this.current(epoch)) throw new Error('CANCELLED');
      this.session = next;
      return next;
    });
    this.sessionWrites = write.then(() => undefined, () => undefined);
    return write;
  }
  private cancelRestoreTimer() { if (this.restoreTimer) clearTimeout(this.restoreTimer); this.restoreTimer = null; }
  pauseRestoration() { this.restorationPaused = true; this.cancelRestoreTimer(); }
  resumeRestoration() {
    this.restorationPaused = false;
    if (this.state.restorePending && !this.state.busy && !this.restoreTimer && !this.restoreBlocked && !this.disposed) {
      const delay = this.serverRetryNotBefore - Date.now();
      if (delay > 0) this.queueRestore(delay, this.epoch); else void this.restore();
    }
  }
  private scheduleRestore(error: unknown, epoch: number) {
    const transient = error instanceof CloudError ? ['SERVICE_UNAVAILABLE', 'TOO_MANY_REQUESTS'].includes(error.code)
      : error instanceof Error && ['NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT'].includes(error.message);
    if (!transient || !this.current(epoch) || this.restoreBlocked || !this.state.restorePending || this.state.signedIn || this.state.interruption) return;
    const retryAfter = error instanceof CloudError ? error.retryAfterSeconds * 1000 : 0;
    this.serverRetryNotBefore = Date.now() + retryAfter;
    if (this.restorationPaused) return;
    const backoff = [2000, 5000, 10000, 30000][Math.min(this.restoreAttempt++, 3)];
    this.queueRestore(Math.max(backoff, retryAfter), epoch);
  }
  private queueRestore(delay: number, epoch: number) {
    this.cancelRestoreTimer();
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null;
      if (this.current(epoch) && !this.restorationPaused && !this.restoreBlocked && this.state.restorePending) void this.restore();
    }, delay);
    this.restoreTimer.unref();
  }
  private resetNetwork() { this.cancelRestoreTimer(); this.epoch++; this.abort.abort(); this.abort = new AbortController(); this.refreshing = null; return this.epoch; }
  private bundle(bundle: SessionBundle, previous: Pick<StoredSession, 'origin' | 'accountId' | 'maskedPhone'>): StoredSession {
    return { ...previous, accessToken: bundle.access.accessToken, refreshToken: bundle.refresh.refreshToken,
      accessExpiresAt: Date.now() + bundle.access.accessExpiresInSeconds * 1000, refreshExpiresAt: Date.now() + bundle.refresh.refreshSlidingExpiresInSeconds * 1000,
      deviceId: bundle.access.deviceId, sessionId: bundle.access.sessionId, pendingRefresh: null };
  }
  restore(): Promise<void> {
    if (this.restoration) return this.restoration;
    const task = this.performRestore(); this.restoration = task;
    void task.finally(() => { if (this.restoration === task) this.restoration = null; }).catch(() => undefined);
    return task;
  }
  private async performRestore() {
    if (this.state.busy || this.disposed || this.restoreBlocked || this.state.interruption) return;
    if (this.state.signedIn) { if (this.state.identityPending) await this.resolveIdentity(); return; }
    const epoch = this.resetNetwork(); let retryError: unknown;
    this.update({ busy: true, error: null, loginErrorSource: 'restore' });
    try {
      const stored = this.store.secrets.session;
      if (!stored || stored.origin !== this.cloud.origin || stored.refreshExpiresAt <= Date.now()) {
        if (stored && stored.refreshExpiresAt <= Date.now()) await this.store.clearSession();
        this.restoreAttempt = 0; this.update({ restorePending: false }); return;
      }
      this.session = stored; this.update({ restorePending: true });
      if (stored.pendingRefresh || stored.accessExpiresAt <= Date.now() + 30_000) await this.refreshAccess();
      if (!this.current(epoch) || !this.session) return;
      const access = this.session.accessToken;
      const account = await this.cloud.account(access, this.abort.signal);
      if (!this.current(epoch)) return;
      await this.confirmIdentity(epoch, account.maskedPhone);
      if (this.current(epoch)) { this.restoreAttempt = 0; this.serverRetryNotBefore = 0; this.update({ restorePending: false }); }
    } catch (error) { if (this.current(epoch) && !this.handleError(error)) { retryError = error; this.update({ error: publicError(error), signedIn: false }); } }
    finally { if (this.current(epoch)) { this.update({ busy: false }); this.scheduleRestore(retryError, epoch); } }
  }
  /** A verified login survives a temporary account-context failure. Identity is
   * still required before associating an onboarding completion with an account. */
  private async confirmIdentity(epoch: number, maskedPhone: string): Promise<boolean> {
    const session = this.session;
    if (!session || !this.current(epoch)) return false;
    maskedPhone = accountPhoneDisplay(maskedPhone, session.maskedPhone);
    try {
      const accountId = await this.cloud.accountContext(session.accessToken, this.abort.signal);
      if (!this.current(epoch) || !this.session) return false;
      if (session.accountId !== null && accountId !== session.accountId) throw new CloudError('PROTOCOL_ERROR');
      await this.commitSession(epoch, (current) => {
        if (current.accountId !== null && current.accountId !== accountId) throw new CloudError('PROTOCOL_ERROR');
        return { ...current, accountId, maskedPhone };
      });
      if (!this.current(epoch)) return false;
      this.update({ signedIn: true, demo: false, identityPending: false, maskedPhone, interruption: null, error: null });
      return true;
    } catch (error) {
      if (this.current(epoch) && !this.handleError(error)) this.update({ signedIn: true, demo: false, identityPending: true,
        maskedPhone, interruption: null, error: { code: 'ACCOUNT_IDENTITY_PENDING' } });
      return false;
    }
  }
  async resolveIdentity(): Promise<boolean> {
    if (this.disposed || this.state.busy || !this.state.signedIn) return false;
    if (!this.state.identityPending) return this.accountKey !== null;
    const epoch = this.epoch; this.update({ busy: true, error: null });
    try {
      await this.access();
      if (!this.current(epoch) || !this.session) return false;
      return await this.confirmIdentity(epoch, this.state.maskedPhone ?? this.session.maskedPhone);
    } catch (error) {
      if (this.current(epoch) && !this.handleError(error)) this.update({ error: { code: 'ACCOUNT_IDENTITY_PENDING' } });
      return false;
    } finally { if (this.current(epoch)) this.update({ busy: false }); }
  }
  private clearChallenge() {
    this.challenge = null; this.rejectedCode = null;
    return { challengeExpiresAt: 0, phoneMatchesChallenge: false, codeWasRejected: false,
      codeResetGeneration: this.state.codeResetGeneration + 1 };
  }
  private refreshLoginTiming() {
    if (this.disposed || this.state.signedIn) return;
    const now = Date.now(); const change: Partial<AuthSnapshot> = {};
    if (this.state.verifyAt > 0 && this.state.verifyAt <= now) {
      change.verifyAt = 0; change.smsRequestLocked = false;
      if (['verification_locked', 'verification_retry'].includes(this.state.error?.reason ?? '') ||
          this.state.error?.code === 'TOO_MANY_REQUESTS' && this.state.loginErrorSource === 'verify') change.error = null;
    }
    if (this.challenge && !this.state.verifyingSMS && this.state.challengeExpiresAt <= now) {
      Object.assign(change, this.clearChallenge());
      // Challenge expiry does not shorten a verification lockout.
      if (!this.state.smsRequestLocked || this.state.verifyAt <= now) {
        change.verifyAt = 0; change.error = { code: 'CHALLENGE_EXPIRED' }; change.loginErrorSource = 'verify';
      }
    }
    if (this.state.resendAt > 0 && this.state.resendAt <= now) {
      change.resendAt = 0; change.resendDisplayOffset = 0;
      if (['send_cooldown', 'send_quota'].includes(this.state.error?.reason ?? '') ||
          this.state.error?.code === 'TOO_MANY_REQUESTS' && this.state.loginErrorSource === 'send') change.error ??= null;
    }
    if (Object.keys(change).length) this.update(change);
  }
  editPhone(value: string) {
    if (this.disposed || this.state.signedIn) return;
    const phone = loginPhoneDigits(value);
    if (phone === this.phone) return;
    const hadSessionWork = this.state.verifyingSMS || this.session !== null;
    this.phone = phone; this.resetNetwork(); this.restoreAttempt = 0; this.restoreBlocked = true; this.session = null;
    this.update({ ...this.clearChallenge(), busy: false, restorePending: false, requestingSMS: false, verifyingSMS: false,
      resendAt: 0, verifyAt: 0, smsRequestLocked: false, resendDisplayOffset: 0, error: null, loginErrorSource: null });
    if (hadSessionWork) {
      const epoch = this.epoch;
      void this.store.clearSession().catch(() => { if (this.current(epoch)) this.update({ error: { code: 'STORAGE_DELETE_FAILED' } }); });
    }
  }
  editCode(value: string) {
    if (this.disposed || this.state.signedIn) return;
    const code = loginDigits(value);
    if (this.rejectedCode !== null && /^[0-9]{6}$/.test(code) && code !== this.rejectedCode) {
      this.rejectedCode = null;
      const error = this.state.error;
      const clear = error?.code === 'INVALID_VERIFICATION_CODE' || error?.code === 'VERIFICATION_CODE_INVALID_OR_EXPIRED';
      this.update({ codeWasRejected: false, ...(clear ? { error: null, loginErrorSource: null } : {}) });
    }
  }
  beginReauthentication() {
    if (this.disposed || this.state.busy || this.state.signedIn || !this.state.interruption) return;
    this.resetNetwork(); this.restoreBlocked = true; this.session = null; this.phone = '';
    const reset = this.clearChallenge();
    this.update({ ...initial(), ...reset });
  }
  private feedback(error: unknown, epoch: number, source: 'send' | 'verify', submittedCode?: string) {
    if (!this.current(epoch)) return;
    const e = publicError(error); const seconds = error instanceof CloudError ? error.retryAfterSeconds : 0;
    const after = seconds > 0 ? Date.now() + seconds * 1000 : 0;
    const change: Partial<AuthSnapshot> = { error: e, loginErrorSource: source };
    if (source === 'verify' && (e.reason === 'verification_locked' || e.code === 'TOO_MANY_REQUESTS' && e.reason !== 'verification_retry')) {
      change.verifyAt = after; change.smsRequestLocked = seconds > 0;
    } else if (e.reason === 'verification_retry') change.verifyAt = after;
    else if (source === 'send' && seconds) { change.resendAt = after; change.resendDisplayOffset = 0; }
    if (source === 'verify' && submittedCode && (e.code === 'INVALID_VERIFICATION_CODE' || e.code === 'VERIFICATION_CODE_INVALID_OR_EXPIRED') &&
        !['expired', 'exhausted', 'verification_retry', 'verification_locked'].includes(e.reason ?? '')) {
      this.rejectedCode = submittedCode; change.codeWasRejected = true;
    }
    if (['expired', 'exhausted'].includes(e.reason ?? '')) Object.assign(change, this.clearChallenge(), { verifyAt: 0 });
    this.update(change);
  }
  async send(phone: string, _accepted: boolean) {
    this.refreshLoginTiming();
    if (this.state.requestingSMS || this.state.busy && !this.state.verifyingSMS || this.disposed || this.state.signedIn || this.state.interruption) return;
    const compact = loginPhoneDigits(phone);
    // A changed phone invalidates its previous challenge and per-phone timings.
    this.editPhone(compact);
    if (Date.now() < this.state.resendAt || this.state.smsRequestLocked) return;
    if (!/^1[3-9]\d{9}$/.test(compact)) { this.update({ error: { code: 'INVALID_PHONE_NUMBER' }, loginErrorSource: 'send' }); return; }
    this.restoreBlocked = true;
    const supersedesVerification = this.state.verifyingSMS;
    const epoch = supersedesVerification ? this.resetNetwork() : this.epoch;
    this.update({ ...this.clearChallenge(), busy: true, requestingSMS: true, verifyingSMS: false, verifyAt: 0, error: null, loginErrorSource: null });
    try {
      // Requesting another SMS abandons any earlier verified-but-unidentified account.
      if (supersedesVerification || this.session?.accountId === null) { await this.store.clearSession(); if (!this.current(epoch)) return; this.session = null; }
      const result = await this.cloud.requestSMS(`+86${compact}`, this.abort.signal);
      if (!this.current(epoch) || compact !== this.phone) return;
      this.challenge = { id: result.challengeId, phone: compact };
      this.update({ phoneMatchesChallenge: true, challengeExpiresAt: Date.now() + result.expiresInSeconds * 1000,
        resendAt: Date.now() + result.resendAfterSeconds * 1000, resendDisplayOffset: 1, codeFocusGeneration: this.state.codeFocusGeneration + 1 });
    } catch (error) { this.feedback(error, epoch, 'send'); }
    finally { if (this.current(epoch)) this.update({ busy: false, requestingSMS: false }); }
  }
  async verify(code: string, accepted: boolean, inviteCode?: string) {
    this.refreshLoginTiming();
    if (this.state.busy || this.disposed || this.state.signedIn || this.state.interruption || Date.now() < this.state.verifyAt) return;
    if (!accepted) { this.update({ error: { code: 'TERMS_REQUIRED' }, loginErrorSource: 'verify' }); return; }
    if (!this.challenge || this.challenge.phone !== this.phone || Date.now() >= this.state.challengeExpiresAt) {
      this.update({ ...this.clearChallenge(), error: { code: 'CHALLENGE_EXPIRED' }, loginErrorSource: 'verify' }); return;
    }
    const compactCode = loginDigits(code);
    if (!/^\d{6}$/.test(compactCode) || (inviteCode && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(inviteCode))) {
      this.update({ error: { code: 'INVALID_VERIFICATION_CODE' }, loginErrorSource: 'verify' }); return;
    }
    // Only an explicit input edit clears a server-rejected credential.
    if (this.rejectedCode !== null) return;
    const epoch = this.epoch; const challenge = this.challenge;
    this.update({ busy: true, verifyingSMS: true, error: null, loginErrorSource: null });
    try {
      this.store.requireSecureStorage();
      await this.store.clearSession();
      if (!this.current(epoch)) return;
      const result = await this.cloud.verifySMS(challenge.id, compactCode, this.abort.signal, inviteCode);
      if (!this.current(epoch) || this.challenge !== challenge) return;
      const maskedPhone = verifiedPhoneDisplay(challenge.phone, result.account.maskedPhone);
      const pending = this.bundle(result.session, { origin: this.cloud.origin!, accountId: null, maskedPhone });
      await this.store.updateSession(pending);
      if (!this.current(epoch)) return;
      this.session = pending; this.restoreBlocked = false; this.phone = '';
      this.update({ ...this.clearChallenge(), resendAt: 0, resendDisplayOffset: 0, verifyAt: 0 });
      await this.confirmIdentity(epoch, pending.maskedPhone);
    } catch (error) { if (this.challenge === challenge) this.feedback(error, epoch, 'verify', compactCode); }
    finally { if (this.current(epoch)) this.update({ busy: false, verifyingSMS: false }); }
  }
  private refreshAccess(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const task = (async () => {
      const previous = this.session;
      if (!previous || previous.refreshExpiresAt <= Date.now()) throw new CloudError('SESSION_EXPIRED');
      // Preserve the durable request ID for retrying an interrupted refresh.
      // The configured service adapter owns refresh idempotency and expiry.
      const pending = previous.pendingRefresh ?? { id: randomUUID(), startedAt: Date.now() };
      await this.commitSession(epoch, (current) => ({ ...current, pendingRefresh: pending }));
      if (!this.current(epoch)) throw new Error('CANCELLED');
      let result: SessionBundle;
      try { result = await this.cloud.refresh(previous.refreshToken, pending.id, this.abort.signal); }
      catch (error) {
        const retryable = error instanceof CloudError ? error.code === 'SERVICE_UNAVAILABLE' : ['NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT'].includes((error as Error).message);
        const remaining = 25_000 - (Date.now() - pending.startedAt);
        if (!retryable || remaining < 100 || !this.current(epoch)) throw error;
        result = await this.cloud.refresh(previous.refreshToken, pending.id, this.abort.signal, Math.min(20_000, remaining));
      }
      if (!this.current(epoch)) throw new Error('CANCELLED');
      if (result.access.deviceId !== previous.deviceId || result.access.sessionId !== previous.sessionId) throw new CloudError('PROTOCOL_ERROR');
      const next = await this.commitSession(epoch, (current) => this.bundle(result, current));
      if (!this.current(epoch)) throw new Error('CANCELLED');
      return next.accessToken;
    })();
    this.refreshing = task;
    void task.finally(() => { if (this.refreshing === task) this.refreshing = null; }).catch(() => undefined); return task;
  }
  async access(): Promise<string> {
    if (!this.state.signedIn || this.state.demo || !this.session || this.disposed) throw new CloudError('AUTH_REQUIRED');
    try { return this.session.pendingRefresh || this.session.accessExpiresAt <= Date.now() + 30_000 ? await this.refreshAccess() : this.session.accessToken; }
    catch (error) { this.handleError(error); throw error; }
  }
  handleError(error: unknown): boolean {
    if (!(error instanceof CloudError) || !interruptions.includes(error.code)) return false;
    this.invalidateTasks(); this.resetNetwork(); this.restoreBlocked = true; this.session = null; this.challenge = null; this.rejectedCode = null; this.phone = '';
    const epoch = this.epoch;
    void this.store.clearSession().catch(() => { if (this.current(epoch)) this.update({ error: { code: 'STORAGE_DELETE_FAILED' } }); });
    this.update({ ...initial(), interruption: error.code === 'SESSION_REPLACED' ? 'replaced' : error.code === 'ACCOUNT_DISABLED' ? 'disabled' : 'expired', error: error.publicError }); return true;
  }
  async logout() {
    if (this.disposed) return;
    const previous = this.session; const epoch = this.resetNetwork(); this.invalidateTasks(); this.restoreBlocked = true; this.session = null; this.challenge = null; this.rejectedCode = null; this.phone = '';
    this.update({ ...initial(), busy: true });
    try { await this.store.clearSession(); }
    catch { this.update({ error: { code: 'STORAGE_DELETE_FAILED' } }); }
    if (previous && previous.origin === this.cloud.origin) {
      // Local sign-out is authoritative. This best-effort revocation never restores a failed remote session.
      try { await this.cloud.logout(previous.accessToken, this.abort.signal); } catch { /* remain signed out */ }
    }
    if (this.current(epoch)) this.update({ busy: false });
  }
  async enterDemo() {
    if (this.state.busy || this.state.signedIn || this.state.demo || this.disposed) return;
    const epoch = this.resetNetwork(); this.session = null; this.challenge = null; this.rejectedCode = null; this.phone = ''; this.restoreBlocked = true; this.update({ busy: true });
    try {
      await this.store.clearSession();
      if (this.current(epoch)) this.update({ ...initial(), signedIn: false, demo: true, maskedPhone: null });
    } catch { if (this.current(epoch)) this.update({ busy: false, error: { code: 'STORAGE_DELETE_FAILED' } }); }
  }
  async settleSessionWrites() {
    this.pauseRestoration();
    await this.restoration?.catch(() => undefined);
    await this.refreshing?.catch(() => undefined);
    await this.sessionWrites;
  }
  dispose() { this.pauseRestoration(); this.disposed = true; clearInterval(this.loginTimer); this.resetNetwork(); this.session = null; this.challenge = null; this.rejectedCode = null; this.phone = ''; }
}
