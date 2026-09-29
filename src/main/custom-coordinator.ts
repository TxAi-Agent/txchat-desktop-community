import type { CustomCategory, CustomSnapshot, CustomTestResult, ProductCommand, ProductError } from '../shared/product';
import { ASR_PROVIDERS, OPTIMIZATION_PROVIDERS, defaultProviderSelection, getProvider, validateProviderSelection, type ProviderSelection } from '../shared/custom-ai';
import { CustomAIError, FIXED_OPTIMIZATION_TEST_TEXT, loadTestWav, optimize, transcribe, type ProviderTransport } from '../adapters/custom-ai';
import { ProductStore } from './product-store';
import { parseCustomDraftRequest, parseCustomDraftRead, type CustomDraftRead } from '../shared/custom-ai-editor';
import { publicError } from './auth-coordinator';
const testState = (generation = 0): CustomTestResult => ({ generation, phase: 'idle', category: 'all', providerId: null, code: null, configurationVersion: 0 });
export class CustomCoordinator {
  private busy = false; private version = 0; private error: ProductError | null = null;
  private test = testState(); private abort: AbortController | null = null; private epoch = 0; private disposed = false;
  constructor(private readonly store: ProductStore, private readonly transport: ProviderTransport, private readonly publish: () => void,
    private readonly editable: () => boolean) {}
  get snapshot(): CustomSnapshot {
    const vault = this.store.secrets;
    const category = (kind: CustomCategory) => (kind === 'asr' ? ASR_PROVIDERS : OPTIMIZATION_PROVIDERS).map((p) => {
      const stored = vault.providers[kind][p.id] ?? defaultProviderSelection(kind, p.id);
      return { providerId: p.id, modelId: stored.modelId,
        values: Object.fromEntries(p.fields.filter((f) => !f.secret && stored.values[f.id] !== undefined).map((f) => [f.id, stored.values[f.id]])),
        configuredFields: p.fields.filter((f) => !!stored.values[f.id]).map((f) => f.id) };
    });
    return { selected: { ...vault.selected }, configurations: { asr: category('asr'), optimization: category('optimization') }, busy: this.busy,
      version: this.version, error: this.error, test: { ...this.test } };
  }
  /** Explicit one-provider editor read. Admission to the product window is
   * enforced by ProductCoordinator and IPC; this method never emits a snapshot. */
  readDraft(input: unknown): CustomDraftRead {
    try {
      if (this.disposed || this.busy || !this.editable()) throw new Error('CUSTOM_AI_DRAFT_READ_FAILED');
      const request = parseCustomDraftRequest(input);
      const provider = getProvider(request.category, request.providerId)!;
      const stored = this.store.secrets.providers[request.category][request.providerId] ?? defaultProviderSelection(request.category, request.providerId);
      const draft = parseCustomDraftRead({ modelId: stored.modelId,
        values: Object.fromEntries(provider.fields.map((field) => [field.id, stored.values[field.id] ?? field.defaultValue ?? ''])),
        version: this.version }, request);
      Object.freeze(draft.values);
      return Object.freeze(draft);
    } catch { throw new Error('CUSTOM_AI_DRAFT_READ_FAILED'); }
  }
  private emit() { if (!this.disposed) this.publish(); }
  private errorOf(error: unknown) { return error instanceof CustomAIError ? { code: error.code } : error instanceof Error && error.message === 'CUSTOM_AI_INVALID_CONFIGURATION' ? { code: error.message } : publicError(error); }
  private selection(kind: CustomCategory, id: string, model?: string, values: Record<string, string> = {}, clearFields: string[] = []): ProviderSelection {
    const descriptor = getProvider(kind, id); if (!descriptor) throw new Error('CUSTOM_AI_INVALID_CONFIGURATION');
    const old = this.store.secrets.providers[kind][id] ?? defaultProviderSelection(kind, id);
    const candidate = { providerId: id, modelId: model ?? old.modelId, values: { ...old.values } };
    for (const [key, value] of Object.entries(values)) {
      const field = descriptor.fields.find((field) => field.id === key); if (!field) throw new Error('CUSTOM_AI_INVALID_CONFIGURATION');
      // Blank secret fields mean unchanged. Explicit deletion uses clearFields.
      if (value !== '' || !field.secret) candidate.values[key] = value.trim();
    }
    for (const key of clearFields) { if (!descriptor.fields.some((f) => f.id === key)) throw new Error('CUSTOM_AI_INVALID_CONFIGURATION'); delete candidate.values[key]; }
    return candidate;
  }
  runtime(kind: CustomCategory): ProviderSelection {
    const vault = this.store.secrets, id = vault.selected[kind];
    if (!id) throw new Error('CUSTOM_AI_INVALID_CONFIGURATION');
    return validateProviderSelection(kind, vault.providers[kind][id]);
  }
  async save(command: Extract<ProductCommand, { type: 'custom-save' }>) {
    if (this.busy || !this.editable() || this.disposed) return;
    this.busy = true; this.error = null; this.emit();
    try {
      const candidate = validateProviderSelection(command.category, this.selection(command.category, command.providerId, command.modelId, command.values, command.clearFields), command.select);
      await this.store.updateVault((v) => {
        v.providers[command.category][command.providerId] = candidate;
        if (command.select) v.selected[command.category] = command.providerId;
        else if (v.selected[command.category] === command.providerId) {
          try { validateProviderSelection(command.category, candidate); } catch { v.selected[command.category] = ''; }
        }
      });
      this.version++; this.test = testState(this.epoch);
    } catch (error) { this.error = this.errorOf(error); }
    finally { this.busy = false; this.emit(); }
  }
  async select(kind: CustomCategory, id: string) {
    if (this.busy || !this.editable() || this.disposed) return;
    this.busy = true; this.error = null; this.emit();
    try {
      validateProviderSelection(kind, this.store.secrets.providers[kind][id]);
      await this.store.updateVault((v) => { v.selected[kind] = id; }); this.version++; this.test = testState(this.epoch);
    } catch (error) { this.error = this.errorOf(error); }
    finally { this.busy = false; this.emit(); }
  }
  async runTest(command: Extract<ProductCommand, { type: 'custom-test' }>) {
    if (this.busy || !this.editable() || this.disposed) return;
    const epoch = ++this.epoch; const abort = new AbortController(); this.abort = abort;
    this.busy = true; this.error = null;
    this.test = { generation: epoch, phase: 'running', category: command.category, providerId: command.providerId ?? null, code: null, configurationVersion: this.version }; this.emit();
    let sample: Buffer | null = null;
    try {
      let text = FIXED_OPTIMIZATION_TEST_TEXT;
      if (command.category === 'asr' || command.category === 'all') {
        const selection = command.category === 'all' ? this.runtime('asr') : validateProviderSelection('asr', this.selection('asr', command.providerId ?? this.store.secrets.selected.asr, command.modelId, command.values, command.clearFields));
        sample = loadTestWav(); text = await transcribe(sample, selection, this.transport, abort.signal);
      }
      if (command.category === 'optimization' || command.category === 'all') {
        const selection = command.category === 'all' ? this.runtime('optimization') : validateProviderSelection('optimization', this.selection('optimization', command.providerId ?? this.store.secrets.selected.optimization, command.modelId, command.values, command.clearFields));
        await optimize(text, selection, this.transport, abort.signal);
      }
      if (epoch === this.epoch && !abort.signal.aborted) this.test = { ...this.test, phase: 'passed' };
    } catch (error) {
      if (epoch === this.epoch && !abort.signal.aborted) { this.error = this.errorOf(error); this.test = { ...this.test, phase: 'failed', code: this.error.code }; }
    } finally { sample?.fill(0); if (epoch === this.epoch) { this.busy = false; this.abort = null; this.emit(); } }
  }
  cancelTest() { if (!this.abort) return; this.epoch++; this.abort.abort(); this.abort = null; this.busy = false; this.test = testState(this.epoch); this.emit(); }
  dispose() { this.disposed = true; this.cancelTest(); }
}
