import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { BillingSnapshot, BillingOrder, BillingStatus, ProductError } from '../shared/product';
import { CloudClient, CloudError } from '../adapters/cloud/client';
import { AuthCoordinator, publicError } from './auth-coordinator';
import { ProductStore } from './product-store';
const initial = (): BillingSnapshot => ({ loading: false, offer: null, status: null, error: null, statusDisplayError: null,
  payment: { phase: 'closed', busy: false, order: null, qrDataUrl: null, error: null } });
export class BillingCoordinator {
  private state = initial(); private abort = new AbortController(); private epoch = 0; private disposed = false;
  private poll: ReturnType<typeof setTimeout> | null = null; private cooldown = 0;
  private paymentPresented = false; private backgroundFollowUpUntil: number | null = null;
  private statusRequestVersion = 0;
  private offerError: ProductError | null = null;
  private statusError: ProductError | null = null;
  private operationError: ProductError | null = null;
  private paymentErrorFromStatus = false;
  private overviewTask: Promise<void> | null = null;
  private usageTask: Promise<void> | null = null;
  private usageQueued = false;
  private orderDiscovered = false;
  private paymentTask: Promise<void> | null = null;
  private paymentIntent = 0;
  constructor(private readonly cloud: CloudClient, private readonly auth: AuthCoordinator, private readonly store: ProductStore, private readonly publish: () => void) {}
  get snapshot(): BillingSnapshot {
    const snapshot = structuredClone(this.state);
    snapshot.error = this.operationError ?? this.statusError ?? this.offerError;
    snapshot.statusDisplayError = this.operationError ?? this.statusError;
    // Keep the existing renderer contract: closed means hidden, not a discarded order.
    if (!this.paymentPresented) snapshot.payment.phase = 'closed';
    return snapshot;
  }
  private current(epoch: number) { return !this.disposed && this.epoch === epoch && this.auth.snapshot.signedIn && !this.auth.snapshot.demo; }
  private emit() { if (!this.disposed) this.publish(); }
  private failure(error: unknown, payment: boolean, source: 'offer' | 'status' | 'operation' | 'order' = 'operation') {
    if (this.auth.handleError(error)) return;
    if (error instanceof CloudError) this.cooldown = Date.now() + error.retryAfterSeconds * 1000;
    const value = publicError(error);
    if (source === 'offer') this.offerError = value;
    else if (source === 'status') this.statusError = value;
    else if (source === 'operation') this.operationError = value;
    if (payment) {
      this.paymentErrorFromStatus = source === 'status';
      this.state.payment.error = value;
      this.state.payment.phase = this.state.payment.order?.status === 'paid' ? 'membership-sync-pending' : this.state.payment.qrDataUrl ? 'qr-ready' : 'unconfirmed';
    }
  }
  refresh(): Promise<void> {
    if (this.overviewTask) return this.overviewTask;
    const task = this.performRefresh(); this.overviewTask = task;
    void task.finally(() => { if (this.overviewTask === task) this.overviewTask = null; }).catch(() => undefined);
    return task;
  }
  refreshUsage(): Promise<void> {
    if (this.usageTask) { this.usageQueued = true; return this.usageTask; }
    const task = this.performUsageRefreshLoop(); this.usageTask = task;
    void task.finally(() => { if (this.usageTask === task) this.usageTask = null; }).catch(() => undefined);
    return task;
  }
  private async performUsageRefreshLoop() {
    do {
      this.usageQueued = false;
      await this.performUsageRefresh();
    } while (this.usageQueued && !this.disposed);
  }
  private async performUsageRefresh() {
    if (this.disposed || !this.auth.snapshot.signedIn || Date.now() < this.cooldown || this.auth.snapshot.demo) return;
    const epoch = this.epoch, request = ++this.statusRequestVersion;
    try {
      const token = await this.auth.access(); if (!this.current(epoch)) return;
      const status = await this.cloud.status(token, this.abort.signal);
      this.applyStatus({ status: 'fulfilled', value: status }, epoch, request, false);
    } catch (error) {
      this.applyStatus({ status: 'rejected', reason: error }, epoch, request, false);
    } finally {
      if (this.current(epoch) && request === this.statusRequestVersion) this.emit();
    }
  }
  async refreshMembership() {
    const epoch = this.epoch;
    await this.refresh();
    if (!this.current(epoch) || this.snapshot.error || !this.state.offer || !this.state.status || this.orderDiscovered) return;
    // Discover outstanding orders when opening Membership, without opening payment.
    await this.runPayment('refresh', false, true);
  }
  private async performRefresh() {
    if (this.disposed || this.state.loading || !this.auth.snapshot.signedIn || Date.now() < this.cooldown) return;
    if (this.auth.snapshot.demo) { this.operationError = { code: 'DEMO_NO_BILLING' }; this.emit(); return; }
    const epoch = this.epoch, request = ++this.statusRequestVersion;
    this.state.loading = true; this.operationError = null; this.emit();
    try {
      const token = await this.auth.access(); if (!this.current(epoch)) return;
      const results = await Promise.allSettled([this.cloud.offer(token, this.abort.signal), this.cloud.status(token, this.abort.signal)]);
      if (!this.current(epoch)) return;
      if (results[0].status === 'fulfilled') { this.state.offer = results[0].value; this.offerError = null; }
      else this.failure(results[0].reason, false, 'offer');
      if (!this.current(epoch)) return;
      this.applyStatus(results[1], epoch, request, false);
    } catch (error) { if (this.current(epoch) && request === this.statusRequestVersion) this.failure(error, false); }
    finally { if (this.current(epoch)) { this.state.loading = false; this.emit(); } }
  }
  private applyStatus(result: PromiseSettledResult<BillingStatus>, epoch: number, request: number, payment: boolean) {
    if (!this.current(epoch) || request !== this.statusRequestVersion) return;
    if (result.status === 'fulfilled') {
      this.state.status = result.value; this.statusError = null;
      if (this.paymentErrorFromStatus) { this.state.payment.error = null; this.paymentErrorFromStatus = false; }
      this.applyMembership();
    } else this.failure(result.reason, payment || this.state.payment.order?.status === 'paid' && this.state.payment.phase === 'synchronizing', 'status');
  }
  private applyMembership() {
    if (this.state.payment.order?.status !== 'paid') return;
    const member = this.state.status;
    this.state.payment.phase = member?.kind === 'monthly_membership' && ['active', 'exhausted'].includes(member.status) ? 'success' : 'membership-sync-pending';
  }
  private async applyOrder(order: BillingOrder, epoch: number) {
    // A delayed discovery must not turn a known terminal order back into a payable QR.
    const previous = this.state.payment.order;
    if (previous?.orderId === order.orderId && previous.status !== 'pending' && order.status === 'pending') return;
    let qrDataUrl: string | null = null;
    try { if (order.status === 'pending' && order.codeUrl) qrDataUrl = await QRCode.toDataURL(order.codeUrl, { width: 200, margin: 2, errorCorrectionLevel: 'M' }); }
    catch { /* Preserve the order; the payment view offers refresh for a render failure. */ }
    if (!this.current(epoch)) return;
    if (order.status !== 'pending') this.backgroundFollowUpUntil = null;
    this.state.payment.order = order; this.state.payment.qrDataUrl = qrDataUrl; this.state.payment.error = null; this.paymentErrorFromStatus = false; this.operationError = null;
    this.state.payment.phase = order.status === 'pending' ? order.codeUrl ? 'qr-ready' : 'unavailable' : order.status === 'paid' ? 'synchronizing' : order.status === 'expired' ? 'expired' : 'payment-exception';
    this.emit();
    if (order.status === 'paid') {
      const request = ++this.statusRequestVersion;
      try {
        const token = await this.auth.access(); if (!this.current(epoch)) return;
        const status = await this.cloud.status(token, this.abort.signal);
        this.applyStatus({ status: 'fulfilled', value: status }, epoch, request, true);
      } catch (error) { this.applyStatus({ status: 'rejected', reason: error }, epoch, request, true); }
    }
  }
  private clearPoll() { if (this.poll) clearTimeout(this.poll); this.poll = null; }
  private canPoll() {
    if (this.disposed || !this.auth.snapshot.signedIn || this.auth.snapshot.demo || this.state.payment.order?.status !== 'pending') return false;
    if (this.paymentPresented) return true;
    if (this.backgroundFollowUpUntil !== null && Date.now() < this.backgroundFollowUpUntil) return true;
    this.backgroundFollowUpUntil = null;
    return false;
  }
  private schedule() {
    this.clearPoll();
    // Pending orders are polled. Paid orders get one status synchronization;
    // a still-pending membership is refreshed explicitly, not by another order loop.
    if (!this.canPoll() || this.state.payment.busy) return;
    let delay = Math.max(2000, this.cooldown - Date.now());
    if (!this.paymentPresented && this.backgroundFollowUpUntil !== null) delay = Math.min(delay, this.backgroundFollowUpUntil - Date.now());
    this.poll = setTimeout(() => {
      this.poll = null;
      if (this.canPoll()) void this.runPayment('refresh');
    }, delay);
  }
  async payment(action: 'create' | 'refresh' | 'recover') {
    if (this.disposed || !this.auth.snapshot.signedIn) return;
    const epoch = this.epoch, intent = ++this.paymentIntent;
    // A click can arrive on the same frame that silent order discovery starts.
    // Wait for discovery; never silently lose the explicit action at a busy guard.
    if (this.paymentTask) await this.paymentTask;
    if (this.disposed || epoch !== this.epoch || !this.auth.snapshot.signedIn || intent !== this.paymentIntent) return;
    if (action === 'create' && !this.snapshot.statusDisplayError && this.state.status?.kind === 'monthly_membership' && ['active', 'exhausted'].includes(this.state.status.status)) return;
    const previous = this.state.payment.order;
    // Open a new purchase atomically in its own preparation state. The previous
    // terminal order stays available for discovery, retry and duplicate guards.
    if (action === 'create' && (!previous || ['expired', 'refunded'].includes(previous.status)) &&
        !this.auth.snapshot.demo && Date.now() >= this.cooldown) this.state.payment.phase = 'preparing';
    else if (this.state.payment.phase === 'closed') this.state.payment.phase = 'loading';
    this.paymentPresented = true; this.backgroundFollowUpUntil = null;
    this.emit();
    await this.runPayment(action, true);
  }
  private runPayment(action: 'create' | 'refresh' | 'recover', showProgress = false, discoveryOnly = false): Promise<void> {
    if (this.paymentTask) return this.paymentTask;
    const task = this.performPayment(action, showProgress, discoveryOnly); this.paymentTask = task;
    void task.finally(() => { if (this.paymentTask === task) this.paymentTask = null; }).catch(() => undefined);
    return task;
  }
  private async performPayment(action: 'create' | 'refresh' | 'recover', showProgress: boolean, discoveryOnly: boolean) {
    if (this.disposed || this.state.payment.busy || !this.auth.snapshot.signedIn || Date.now() < this.cooldown) { this.schedule(); return; }
    if (this.auth.snapshot.demo) { this.state.payment = { phase: 'unavailable', busy: false, order: null, qrDataUrl: null, error: { code: 'DEMO_NO_BILLING' } }; this.emit(); return; }
    const epoch = this.epoch; this.state.payment.busy = true; this.state.payment.error = null; this.paymentErrorFromStatus = false; this.operationError = null;
    if (showProgress && action !== 'create') this.state.payment.phase = 'synchronizing';
    else if (this.state.payment.phase === 'closed') this.state.payment.phase = 'loading'; this.emit();
    try {
      const token = await this.auth.access(); if (!this.current(epoch)) return;
      let order: BillingOrder | null;
      if (action !== 'create' && this.state.payment.order) {
        const id = this.state.payment.order.orderId;
        order = await this.cloud.order(token, id, this.abort.signal);
        if (!this.current(epoch)) return;
        if (order.orderId !== id) throw new CloudError('PROTOCOL_ERROR');
      }
      else {
        // Discover the service-owned outstanding order before creating another one.
        order = await this.cloud.currentOrder(token, this.abort.signal);
        if (!this.current(epoch)) return;
        this.orderDiscovered = true;
        if (order && this.store.pendingBilling?.account === this.auth.accountKey &&
          (this.store.pendingBilling.orderId === null || this.store.pendingBilling.orderId !== order.orderId)) {
          // A discovered order resolves the previous ambiguous creation/recovery.
          await this.store.updateSettings((s) => { delete s.pendingBilling; });
          if (!this.current(epoch)) return;
        }
        if (action === 'create' && (!order || ['expired', 'refunded'].includes(order.status))) {
          const request = ++this.statusRequestVersion;
          let status: BillingStatus;
          try { status = await this.cloud.status(token, this.abort.signal); }
          catch (error) { this.applyStatus({ status: 'rejected', reason: error }, epoch, request, true); return; }
          if (!this.current(epoch) || request !== this.statusRequestVersion) return;
          this.applyStatus({ status: 'fulfilled', value: status }, epoch, request, true);
          let offer;
          try { offer = await this.cloud.offer(token, this.abort.signal); }
          catch (error) { if (this.current(epoch) && request === this.statusRequestVersion) this.failure(error, true, 'offer'); return; }
          if (!this.current(epoch) || request !== this.statusRequestVersion) return;
          this.state.offer = offer; this.offerError = null;
          if (!status.purchaseAllowed || !offer.purchasable) throw new CloudError('BILLING_SALES_PAUSED');
          const account = this.auth.accountKey!;
          let pending = this.store.pendingBilling;
          if (!pending || pending.account !== account || pending.orderId !== null) {
            pending = { account, key: randomUUID(), orderId: null }; const save = pending;
            await this.store.updateSettings((s) => { s.pendingBilling = save; });
          }
          if (!this.current(epoch)) return;
          order = await this.cloud.createOrder(token, pending.key, this.abort.signal);
          if (!this.current(epoch)) return;
          await this.store.updateSettings((s) => { delete s.pendingBilling; });
        }
      }
      const previous = this.state.payment.order;
      if (previous && order?.orderId === previous.orderId && previous.status !== 'pending' && order.status === 'pending') throw new CloudError('PROTOCOL_ERROR');
      if (action === 'recover' && order?.status === 'pending' && !order.codeUrl && order.codeUrlRecoveryAvailableAt &&
          Date.parse(order.serverTime) >= Date.parse(order.codeUrlRecoveryAvailableAt)) {
          // Eligibility comes from the just-fetched order, never the renderer clock.
          this.state.payment.order = order; this.state.payment.qrDataUrl = null; this.state.payment.phase = 'restoring'; this.emit();
          const account = this.auth.accountKey!; let pending = this.store.pendingBilling;
          if (!pending || pending.account !== account || pending.orderId !== order.orderId) {
            pending = { account, key: randomUUID(), orderId: order.orderId }; const save = pending;
            await this.store.updateSettings((s) => { s.pendingBilling = save; });
          }
          if (!this.current(epoch)) return;
          const orderId = order.orderId;
          order = await this.cloud.recoverOrder(token, orderId, pending.key, this.abort.signal);
          if (!this.current(epoch)) return;
          if (order.orderId !== orderId) throw new CloudError('PROTOCOL_ERROR');
          await this.store.updateSettings((s) => { delete s.pendingBilling; });
      }
      if (!this.current(epoch)) return;
      if (order) await this.applyOrder(order, epoch);
      else { this.state.payment.phase = discoveryOnly ? 'closed' : 'unavailable'; this.state.payment.error = discoveryOnly ? null : { code: 'NO_CURRENT_ORDER' }; }
    } catch (error) { if (this.current(epoch)) this.failure(error, true, action === 'create' ? 'operation' : 'order'); }
    finally {
      if (this.current(epoch)) {
        // A newer status request can supersede creation before an order arrives.
        // Preparation describes live work only; leave a recoverable view on exit.
        if (this.state.payment.phase === 'preparing') this.state.payment.phase = 'unconfirmed';
        this.state.payment.busy = false; this.emit(); this.schedule();
      }
    }
  }
  close() {
    this.paymentIntent++;
    if (this.disposed || !this.paymentPresented) return;
    this.paymentPresented = false;
    this.backgroundFollowUpUntil = this.state.payment.order?.status === 'pending' ? Date.now() + 60_000 : null;
    this.schedule(); this.emit();
  }
  // Session lock/suspension is a hard boundary; UI close deliberately is not.
  suspend() {
    this.epoch++; this.statusRequestVersion++; this.paymentIntent++; this.abort.abort(); this.abort = new AbortController(); this.clearPoll(); this.overviewTask = null; this.usageTask = null; this.usageQueued = false; this.paymentTask = null; this.orderDiscovered = false;
    this.paymentPresented = false; this.backgroundFollowUpUntil = null;
    this.paymentErrorFromStatus = false; this.operationError = null;
    this.state.loading = false; this.state.payment = initial().payment; this.emit();
  }
  reset() { this.suspend(); this.offerError = null; this.statusError = null; this.operationError = null; this.state = initial(); this.cooldown = 0; this.emit(); }
  dispose() { this.disposed = true; this.suspend(); this.offerError = null; this.statusError = null; this.operationError = null; this.state = initial(); this.cooldown = 0; }
}
