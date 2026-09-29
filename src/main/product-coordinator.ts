import type { DocumentKind, ProductDocument } from '../shared/documents';
import { ShortcutEditorCoordinator } from './shortcut-editor';
import type { HotkeyBinding } from '../shared/native-input';
import { clipboard, nativeTheme, shell, type Session } from 'electron';
import type { ProductSnapshot, ProductCommand, DictionarySnapshot } from '../shared/product';
import type { DictationController, RecognitionPort, SessionPort } from '../domain/dictation';
import { onboardingStep } from '../domain/onboarding';
import { replaceDictionary } from '../domain/dictionary';
import { CloudClient } from '../adapters/cloud/client';
import { AuthCoordinator, publicError } from './auth-coordinator';
import { CustomCoordinator } from './custom-coordinator';
import { BillingCoordinator } from './billing-coordinator';
import { ProductStore } from './product-store';
import type { DiagnosticRuntime } from './diagnostic-runtime';
import { classifyDiagnosticFailure } from './diagnostic-classifier';
import type { DiagnosticCategory, DiagnosticStage } from '../shared/diagnostics';
import type { SoftwareUpdateCoordinator } from './software-update-coordinator';
import { SOFTWARE_UPDATE_ACTIONS, type SoftwareUpdateAction } from '../shared/software-update';
import type { DictationSnapshot } from '../shared/contracts';
import type { ProviderTransport } from '../adapters/custom-ai';
import { DemoRecognitionProvider, type RecognitionProvider } from '../adapters/recognition-provider';
import { CustomAudioService, ProviderAudioService, microphoneRecognition } from '../adapters/product-recognition';
import type { NativeHost } from './native-host';
import type { NativeInputCoordinator } from './native-input';
import type { AudioInputCoordinator } from './audio-input';
import { productStage, restoreCloudAuthentication, setupUnavailableCommandAllowed } from '../domain/product-stage';
import { cloudUsageRefreshGeneration } from '../domain/billing-usage-refresh';
export class ProductCoordinator {
  readonly shortcutEditor: ShortcutEditorCoordinator;
  readonly auth: AuthCoordinator; readonly custom: CustomCoordinator; readonly billing: BillingCoordinator;
  private document: ProductDocument | null = null;
  private documentGeneration = 0;
  private documentKind: DocumentKind | null = null;
  private page: ProductSnapshot['page'] = 'status'; private launching = true; private disposed = false;
  private step: ProductSnapshot['onboarding']['step'] = 'microphone'; private voice = false; private voiceResult: string | null = null;
  private dictionary: DictionarySnapshot = { entries: [], busy: false, skippedLines: 0, error: null };
  private storageError: ProductSnapshot['storageError'] = null; private notice: string | null = null;
  private unsubscribeDiagnostics?: () => void;
  private preparingUpdate = false;
  private commands = new Set<Promise<void>>();
  private authKey: string | null = null;
  private lastAuthError: string | null = null; private lastCustomError: string | null = null;
  private onboardingSaving = false;
  private shortcutSaving = false;
  private attemptedAutoEnable = false; private manuallyDisabled = false;
  private lastUsageRefreshGeneration: number | null = null;
  constructor(private readonly store: ProductStore, private readonly cloud: CloudClient, private readonly network: Session,
    private readonly transport: ProviderTransport, private readonly native: NativeHost, private readonly controller: DictationController,
    private readonly input: NativeInputCoordinator, private readonly audio: AudioInputCoordinator, private readonly version: string,
    private readonly publish: () => void, private readonly loadDocument: (document: DocumentKind, language: 'zh' | 'en') => Promise<ProductDocument>,
    private readonly updates?: SoftwareUpdateCoordinator, private readonly diagnosticRuntime?: DiagnosticRuntime,
    private readonly applyTheme: (theme: ProductSnapshot['preferences']['theme']) => void = (theme) => { nativeTheme.themeSource = theme; }, private readonly recognitionProvider?: RecognitionProvider) {
    this.unsubscribeDiagnostics = diagnosticRuntime?.subscribe(() => this.emit());
    this.shortcutEditor = new ShortcutEditorCoordinator(input, native, process.platform === 'darwin' ? 'darwin' : 'win32',
      () => store.preferences.shortcut,
      (binding, label) => store.updateSettings((settings) => { settings.preferences.shortcut = binding; if (label) settings.preferences.shortcutLabel = label; else delete settings.preferences.shortcutLabel; }),
      () => this.emit(), () => !this.disposed && (this.auth.snapshot.signedIn || this.auth.snapshot.demo),
      () => { this.manuallyDisabled = false; this.attemptedAutoEnable = true; },
      (reason) => { this.notice = reason; this.attemptedAutoEnable = true; this.emit(); }, () => store.preferences.shortcutLabel);
    this.auth = new AuthCoordinator(cloud, store, () => this.authChanged(), () => this.invalidate());
    this.custom = new CustomCoordinator(store, transport, () => this.customChanged(), () => this.idle() && (this.auth.snapshot.signedIn || this.auth.snapshot.demo));
    this.billing = new BillingCoordinator(cloud, this.auth, store, () => this.emit());
  }
  private emit() { if (!this.disposed) this.publish(); }
  private idle() { return ['idle', 'completed', 'failed', 'unavailable'].includes(this.controller.snapshot.phase); }
  get snapshot(): ProductSnapshot {
    const auth = this.auth.snapshot; const key = this.auth.accountKey;
    const completed = auth.demo || key !== null && this.store.onboardingComplete(key);
    return { stage: productStage({ launching: this.launching, cloudConfigured: !!this.cloud.origin, interruption: !!auth.interruption,
      signedIn: auth.signedIn, demo: auth.demo, onboardingCompleted: completed }),
      shortcutEditor: this.shortcutEditor.snapshot, page: this.page, preferences: this.store.preferences, environment: { configured: !!this.cloud.origin, origin: this.cloud.origin, label: this.cloud.origin ?? '未配置 Cloud / Cloud not configured' },
      auth, onboarding: { step: this.step, completed }, billing: this.billing.snapshot, dictionary: structuredClone(this.dictionary), custom: this.custom.snapshot,
      voiceTest: this.voice, voiceTestResult: this.voiceResult, notice: this.notice, storageError: this.storageError, diagnostics: this.diagnosticRuntime?.snapshot ?? { phase: 'idle', reportId: null, diagnosticNumber: null, isAbnormalExit: false },
      document: this.document ? structuredClone(this.document) : null,
      update: this.updates?.snapshot ?? { phase: 'unavailable', version: this.version, item: null, downloadedBytes: 0, totalBytes: 0, progress: 0, failure: null, pendingAction: null, blocksNewDictation: false, visible: false } };
  }
  async initialize(errors: string[]) {
    await this.diagnosticRuntime?.initialize();
    if (errors.length) { this.storageError = { code: errors[0] }; for (const code of errors) this.recordDiagnosticFailure('application', 'lifecycle', code); }
    this.applyTheme(this.store.preferences.theme);
    await this.reloadDictionary();
    await restoreCloudAuthentication(!!this.cloud.origin, () => this.auth.restore());
    this.launching = false; this.emit();
  }
  readCustomDraft(request: unknown) {
    if (!this.canStart() || !this.idle() || this.snapshot.stage !== 'ready' || this.page !== 'custom-ai' ||
        this.document || this.voice || this.input.snapshot.busy || this.audio.snapshot.busy || this.storageError)
      throw new Error('CUSTOM_AI_DRAFT_READ_DENIED');
    return this.custom.readDraft(request);
  }
  private customChanged() {
    const snapshot = this.custom?.snapshot; const code = snapshot?.error?.code ?? null;
    if (code && code !== this.lastCustomError) this.recordDiagnosticFailure(snapshot?.test.category === 'optimization' ? 'custom_optimization' : 'custom_asr', 'provider_test', code);
    this.lastCustomError = code; this.emit();
  }
  observeDictation(state: DictationSnapshot) {
    this.updates?.observeDictation(state.phase);
    const generation = cloudUsageRefreshGeneration(state, this.store.preferences.service, this.lastUsageRefreshGeneration);
    if (generation !== null) {
      this.lastUsageRefreshGeneration = generation;
      void this.billing.refreshUsage();
    }
  }
  recordDiagnosticFailure(source: DiagnosticCategory, stage: DiagnosticStage, errorCode: unknown) {
    if (source === 'dictation' && typeof errorCode === 'string' && errorCode.startsWith('CUSTOM_AI_')) {
      source = 'custom_asr'; stage = 'provider_response';
    }
    const incident = classifyDiagnosticFailure({ source, stage, errorCode });
    if (incident) void this.diagnosticRuntime?.record(incident).catch(() => undefined);
  }

  private authChanged() {
    const error = this.auth.snapshot.error?.code ?? null;
    if (error && error !== this.lastAuthError) this.recordDiagnosticFailure('authentication', 'session_restore', error);
    this.lastAuthError = error;
    const key = (this.auth.snapshot.signedIn || this.auth.snapshot.demo) ? this.auth.accountKey : null;
    if (key !== this.authKey) {
      this.authKey = key; this.step = 'microphone'; this.voiceResult = null; this.page = 'status'; this.attemptedAutoEnable = false; this.manuallyDisabled = false; this.lastUsageRefreshGeneration = null; this.billing?.reset();
      if (key && !this.auth.snapshot.demo) void this.billing?.refresh();
    }
    this.emit();
  }
  private invalidate() {
    void this.shortcutEditor.close(false);
    this.controller.setAvailable(false); this.controller.setAvailable(this.native.snapshot.status === 'ready');
    this.controller.dismiss(); this.voice = false; this.voiceResult = null; this.custom?.cancelTest(); this.billing?.reset();
    this.input.disable();
  }
  async reloadDictionary(kind: 'loadFailed' | 'reloadFailed' = 'loadFailed') {
    if (this.dictionary.busy || !this.idle()) return; this.dictionary.busy = true; this.dictionary.error = null; this.dictionary.notice = null; this.emit();
    try { const value = await this.store.loadDictionary(); this.dictionary.entries = value.entries; this.dictionary.skippedLines = value.skippedLines; this.dictionary.revision = (this.dictionary.revision ?? 0) + 1; }
    catch (error) { this.dictionary.notice = kind; this.dictionary.error = publicError(error, 'DICTIONARY_READ_FAILED'); this.recordDiagnosticFailure('application', 'lifecycle', this.dictionary.error.code); }
    finally { this.dictionary.busy = false; this.emit(); }
  }
  observeAudioStatus() {
    const status = this.audio.snapshot.status;
    if (this.notice === 'AUDIO_PERMISSION_REQUIRED' && status?.permission === 'granted' && status.reason !== 'AUDIO_PERMISSION_REQUIRED') this.notice = null;
  }
  canStart() { return !this.preparingUpdate && !this.updates?.blocksNewDictation && !this.shortcutSaving && !this.shortcutEditor.active && !this.onboardingSaving && (this.auth.snapshot.signedIn || this.auth.snapshot.demo) && !this.auth.snapshot.busy && !this.custom.snapshot.busy && !this.dictionary.busy && !this.disposed; }
  helperBuildMissing() { this.notice = 'HELPER_NOT_BUILT'; this.emit(); }
  helperChanged(ready: boolean) { if (!ready) { this.attemptedAutoEnable = false; void this.shortcutEditor.close(false); } }
  synchronizeReadiness() {
    if (this.disposed || this.launching || !this.canStart() || !this.idle()) return;
    const completed = this.snapshot.onboarding.completed;
    if (!completed) {
      const next = onboardingStep(this.step, this.audio.snapshot.status, this.input.snapshot.status,
        this.store.voiceTestCompleted);
      if (next !== this.step) { this.step = next; this.emit(); }
    }
    if (!['granted', 'systemManaged'].includes(this.audio.snapshot.status?.permission ?? '') ||
      !['granted', 'notRequired'].includes(this.input.snapshot.status?.accessibility ?? '')) {
      // A later observed grant must permit one new registration attempt after revocation.
      this.attemptedAutoEnable = false; return;
    }
    if (this.attemptedAutoEnable || this.manuallyDisabled || this.native.snapshot.status !== 'ready' ||
      this.input.snapshot.busy || this.audio.snapshot.busy || this.input.snapshot.status?.enabled) return;
    this.attemptedAutoEnable = true;
    void this.input.configure(true, this.store.preferences.shortcut);
  }
  private async requestOnboardingPermission(fromHome = false) {
    if (this.snapshot.stage !== (fromHome ? 'ready' : 'onboarding') || !this.idle() || this.input.snapshot.busy || this.audio.snapshot.busy) return;
    const account = this.auth.accountKey;
    if (fromHome) {
      await Promise.all([this.audio.refresh(false), this.input.refresh()]);
      if (this.disposed || account !== this.auth.accountKey || !(this.auth.snapshot.signedIn || this.auth.snapshot.demo)) return;
    }
    const current = fromHome ? ['granted', 'systemManaged'].includes(this.audio.snapshot.status?.permission ?? '') ? 'accessibility' : 'microphone' : this.step;
    this.attemptedAutoEnable = false;
    if (current === 'microphone') {
      await this.audio.refresh(true);
      if (account !== this.auth.accountKey || this.disposed) return;
      if (['denied', 'restricted'].includes(this.audio.snapshot.status?.permission ?? ''))
        await this.command({ type: 'system-settings', capability: 'microphone' });
    } else if (current === 'accessibility') {
      const needsAccessibility = this.input.snapshot.status?.accessibility !== 'granted' && this.input.snapshot.status?.accessibility !== 'notRequired';
      if (needsAccessibility) {
        await this.input.permissions();
        if (account !== this.auth.accountKey || this.disposed) return;
        const status = this.input.snapshot.status;
        if (status?.accessibility !== 'granted' && status?.accessibility !== 'notRequired')
          await this.command({ type: 'system-settings', capability: 'accessibility' });
      } else await this.input.configure(true, this.store.preferences.shortcut);
    }
    this.synchronizeReadiness();
  }
  shortcutDisabled() { this.manuallyDisabled = true; }
  suspend() {
    void this.shortcutEditor.close(false);
    this.attemptedAutoEnable = true;
    this.controller.setAvailable(false); this.controller.setAvailable(this.native.snapshot.status === 'ready');
    this.voice = false; this.voiceResult = null; this.custom.cancelTest(); this.billing.suspend(); this.input.disable(); this.emit();
  }
  resume() { if (!this.preparingUpdate) this.auth.resumeRestoration(); this.attemptedAutoEnable = false; void this.audio.refresh(false); void this.input.refresh(); }
  createRecognition(): RecognitionPort {
    if (!this.canStart()) throw new Error('SESSION_NOT_READY');
    const preferences = this.store.preferences;
    const service = preferences.service === 'custom'
      ? new CustomAudioService(this.custom.runtime('asr'), preferences.mode === 'smart' ? this.custom.runtime('optimization') : null, this.transport, (error) => { this.recordDiagnosticFailure('custom_optimization', 'provider_response', error instanceof Error ? error.message : null); this.controller.markVerbatimFallback(); this.notice = 'OPTIMIZATION_FALLBACK'; this.emit(); })
      : preferences.service === 'local' ? new ProviderAudioService(new DemoRecognitionProvider())
      : this.recognitionProvider && this.recognitionProvider.configured !== false ? new ProviderAudioService(this.recognitionProvider, preferences.mode) : null;
    if (!service) { this.notice = 'RECOGNITION_NOT_CONFIGURED'; this.emit(); throw new Error('RECOGNITION_NOT_CONFIGURED'); }
    this.notice = preferences.service === 'local' ? 'LOCAL_FIXED_TRANSCRIPT' : null;
    const entries = structuredClone(this.dictionary.entries);
    const recognition = microphoneRecognition(this.native, service, (progress) => this.audio.productProgress(progress), (error) => {
      // The dictation snapshot owns this message; do not duplicate it as a global toast.
      if (error.message !== 'NO_SPEECH' && !this.auth.handleError(error)) { this.audio.productFailure(error.message); this.emit(); }
    });
    return { start: (...args) => recognition.start(...args), finish: async (organizing, signal) => {
      const text = await recognition.finish(organizing, signal);
      try { const prepared = replaceDictionary(text, entries); if (prepared.length > 32_768) throw new Error(); return prepared; }
      catch { this.notice = 'DICTIONARY_FALLBACK'; this.emit(); return text; }
    }, dispose: () => recognition.dispose() };
  }
  get voiceTestActive() { return this.voice; }
  createVoiceSession(): SessionPort {
    const recognition = this.createRecognition();
    return { ...recognition, insert: async (text, _operation, signal) => {
      if (signal.aborted || !this.voice) return 'notInserted'; this.voiceResult = text; this.emit(); return 'inserted';
    } };
  }
  async hotkey(): Promise<boolean> {
    if (this.voice || this.snapshot.stage === 'onboarding' && this.step === 'voice-test') {
      if (this.controller.snapshot.canStop) await this.controller.stop();
      else if (this.controller.snapshot.canStart) await this.startVoice(); return true;
    }
    if (this.snapshot.stage !== 'ready') return true;
    // Required updates gate the next task, never the shortcut that finishes one already listening.
    return this.controller.snapshot.canStop ? false : !this.canStart();
  }
  private async startVoice() {
    if (!(this.snapshot.stage === 'ready' || this.snapshot.stage === 'onboarding' && this.step === 'voice-test') || !this.canStart() || !this.controller.snapshot.canStart) return;
    this.voice = true; this.voiceResult = null; this.emit(); await this.controller.start();
  }
  private async nextOnboarding(skip = false) {
    if (!(this.auth.snapshot.signedIn || this.auth.snapshot.demo) || this.onboardingSaving) return;
    this.notice = null;
    if (this.step === 'voice-test') {
      if (!skip && (this.controller.snapshot.phase !== 'completed' || this.voiceResult === null)) return;
      this.onboardingSaving = true;
      if (skip) this.controller.cancel();
      const account = this.auth.accountKey;
      try { await this.store.updateSettings((s) => { s.voiceTestCompleted = true; }); }
      catch { throw new Error('VOICE_TEST_SAVE_FAILED'); }
      finally { this.onboardingSaving = false; }
      if (this.disposed || account !== this.auth.accountKey || !(this.auth.snapshot.signedIn || this.auth.snapshot.demo)) return;
      this.controller.dismiss(); this.voice = false; this.voiceResult = null; this.step = 'complete'; this.emit(); return;
    }
    if (!this.idle()) return;
    if (this.step === 'complete') {
      if (this.auth.snapshot.identityPending && !await this.auth.resolveIdentity()) return;
      const key = this.auth.accountKey; if (!key) return;
      this.onboardingSaving = true;
      try { await this.store.updateSettings((s) => { if (!s.onboarding.includes(key)) s.onboarding.push(key); }); }
      catch { throw new Error('ONBOARDING_SAVE_FAILED'); }
      finally { this.onboardingSaving = false; }
      if (this.disposed || !(this.auth.snapshot.signedIn || this.auth.snapshot.demo) || this.auth.accountKey !== key) return;
      this.voice = false; this.voiceResult = null;
      this.attemptedAutoEnable = true; await this.input.configure(true, this.store.preferences.shortcut); this.emit(); return;
    }
    if (this.step === 'microphone') {
      await this.audio.refresh(false);
      if (['granted', 'systemManaged'].includes(this.audio.snapshot.status?.permission ?? '')) this.step = 'accessibility';
    } else if (this.step === 'accessibility') {
      await this.input.refresh();
      if (['granted', 'notRequired'].includes(this.input.snapshot.status?.accessibility ?? '')) { this.step = 'voice-test'; this.attemptedAutoEnable = true; await this.input.configure(true, this.store.preferences.shortcut); }
    }
    this.emit();
  }
  command(command: ProductCommand): Promise<void> {
    if (this.snapshot.stage === 'setup-unavailable' && !setupUnavailableCommandAllowed(command)) return Promise.resolve();
    if (SOFTWARE_UPDATE_ACTIONS.includes(command.type as SoftwareUpdateAction)) return this.updates?.command(command.type as SoftwareUpdateAction) ?? Promise.resolve();
    if (this.preparingUpdate || this.updates?.snapshot.phase === 'installing') return Promise.resolve();
    const task = this.performCommand(command);
    this.commands.add(task);
    void task.finally(() => this.commands.delete(task)).catch(() => undefined);
    return task;
  }
  async prepareForUpdate() {
    this.preparingUpdate = true; this.auth.pauseRestoration();
    this.custom.cancelTest(); this.billing.suspend();
    await this.shortcutEditor.close(false);
    await Promise.allSettled([...this.commands]);
    // Finish rotating credentials before the updater exits; otherwise a durable
    // pending refresh could be left behind while its successful response is lost.
    await this.auth.settleSessionWrites();
    await this.store.flush();
  }
  recoverFromUpdate() { this.preparingUpdate = false; this.resume(); this.emit(); }
  private async showDocument(kind: DocumentKind) {
    this.documentKind = kind;
    const generation = ++this.documentGeneration;
    while (!this.disposed && generation === this.documentGeneration) {
      const language = this.store.preferences.language;
      try {
        const document = await this.loadDocument(kind, language);
        if (this.disposed || generation !== this.documentGeneration) return;
        if (language !== this.store.preferences.language) continue;
        this.document = document; this.emit(); return;
      } catch {
        if (this.disposed || generation !== this.documentGeneration) return;
        if (language !== this.store.preferences.language) continue;
        this.notice = 'DOCUMENT_UNAVAILABLE'; this.emit(); return;
      }
    }
  }
  private async performCommand(command: ProductCommand) {
    if (this.disposed) return;
    try {
      switch (command.type) {
        case 'shortcut-open':
          if (this.canStart() && this.idle() && !this.input.snapshot.busy && this.snapshot.stage === 'ready') await this.shortcutEditor.open(); break;
        case 'shortcut-capture': await this.shortcutEditor.capture(command.sessionId); break;
        case 'shortcut-save': await this.shortcutEditor.save(command.sessionId); break;
        case 'shortcut-cancel': if (this.shortcutEditor.snapshot?.sessionId === command.sessionId) await this.shortcutEditor.close(); break;
        case 'product-page': if (this.idle() && !this.custom.snapshot.busy && (this.auth.snapshot.signedIn || this.auth.snapshot.demo)) { this.page = command.page; this.emit(); if (command.page === 'membership') await this.billing.refreshMembership(); if (command.page === 'dictionary') await this.reloadDictionary(); } break;
        case 'preferences':
          if ((!this.idle() || this.custom.snapshot.busy) && (command.mode !== undefined || command.service !== undefined)) return;
          await this.store.updateSettings((s) => { for (const key of ['language', 'theme', 'mode', 'service'] as const) if (command[key] !== undefined) Object.assign(s.preferences, { [key]: command[key] }); });
          nativeTheme.themeSource = this.store.preferences.theme;
          if (command.language && this.documentKind && this.document?.language !== this.store.preferences.language) await this.showDocument(this.documentKind);
          this.emit(); break;
        case 'auth-send': await this.auth.send(command.phone, command.acceptedTerms); break;
        case 'auth-verify': await this.auth.verify(command.code, command.acceptedTerms, command.inviteCode); break;
        case 'auth-reauthenticate': this.auth.beginReauthentication(); break;
        case 'auth-phone-edited': this.auth.editPhone(command.phone); break;
        case 'auth-code-edited': this.auth.editCode(command.code); break;
        case 'auth-restore': await this.auth.restore(); break;
        case 'auth-logout': await this.auth.logout(); break;
        case 'demo-enter': await this.auth.enterDemo(); if (this.auth.snapshot.demo) { await this.store.updateSettings((s) => { s.preferences.service = 'local'; }); this.emit(); } break;
        case 'onboarding-permission': await this.requestOnboardingPermission(); break;
        case 'permissions-repair': await this.requestOnboardingPermission(true); break;
        case 'onboarding-next': await this.nextOnboarding(); break;
        case 'voice-test-skip': await this.nextOnboarding(true); break;
        case 'voice-test-start': await this.startVoice(); break;
        case 'voice-test-stop': await this.controller.stop(); break;
        case 'voice-test-close': this.controller.cancel(); this.controller.dismiss(); this.voice = false; this.voiceResult = null; this.emit(); break;
        case 'billing-refresh': await this.billing.refresh(); break;
        case 'payment-create': await this.billing.payment('create'); break;
        case 'payment-refresh': await this.billing.payment('refresh'); break;
        case 'payment-recover': await this.billing.payment('recover'); break;
        case 'payment-close': this.billing.close(); break;
        case 'dictionary-save':
          if (!this.idle() || this.dictionary.busy || !(this.auth.snapshot.signedIn || this.auth.snapshot.demo)) return;
          this.dictionary.busy = true; this.dictionary.error = null; this.dictionary.notice = null; this.emit();
          try { await this.store.saveDictionary(command.entries); this.dictionary.entries = structuredClone(command.entries); this.dictionary.skippedLines = 0; this.dictionary.revision = (this.dictionary.revision ?? 0) + 1; if (this.page === 'dictionary') this.page = 'status'; }
          catch (error) { this.dictionary.notice = 'saveFailed'; this.dictionary.error = publicError(error, 'DICTIONARY_WRITE_FAILED'); this.recordDiagnosticFailure('application', 'lifecycle', this.dictionary.error.code); }
          finally { this.dictionary.busy = false; this.emit(); } break;
        case 'dictionary-reload': await this.reloadDictionary('reloadFailed'); break;
        case 'dictionary-open':
          if (!this.idle() || this.dictionary.busy || !(this.auth.snapshot.signedIn || this.auth.snapshot.demo)) return;
          this.dictionary.busy = true; this.dictionary.error = null; this.dictionary.notice = null; this.emit();
          try { await this.store.ensureDictionaryFile(); shell.showItemInFolder(this.store.dictionaryPath); }
          catch (error) { this.dictionary.notice = 'openFileFailed'; this.dictionary.error = publicError(error, 'DICTIONARY_OPEN_FAILED'); }
          finally { this.dictionary.busy = false; this.emit(); } break;
        case 'custom-apply':
          if (!this.idle() || this.custom.snapshot.busy || !(this.auth.snapshot.signedIn || this.auth.snapshot.demo)) throw new Error('CUSTOM_AI_CONFIGURATION_BUSY');
          if (command.enabled) { this.custom.runtime('asr'); this.custom.runtime('optimization'); }
          await this.store.updateSettings((s) => { s.preferences.service = command.enabled ? 'custom' : this.auth.snapshot.demo ? 'local' : 'cloud'; });
          this.notice = null; this.emit(); break;
        case 'custom-save': await this.custom.save(command); break;
        case 'custom-select': await this.custom.select(command.category, command.providerId); break;
        case 'custom-test': await this.custom.runTest(command); break;
        case 'custom-test-cancel': this.custom.cancelTest(); break;
        case 'result-copy': if (this.controller.snapshot.phase === 'resultFallback') { clipboard.writeText(this.controller.snapshot.resultText); this.controller.dismiss(); } break;
        case 'system-settings': await shell.openExternal(process.platform === 'darwin' ? `x-apple.systempreferences:com.apple.preference.security?${command.capability === 'microphone' ? 'Privacy_Microphone' : 'Privacy_Accessibility'}` : command.capability === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:easeofaccess'); break;
        case 'document-open': await this.showDocument(command.document); break;
        case 'document-close': this.documentGeneration++; this.documentKind = null; this.document = null; this.emit(); break;
        case 'diagnostics-send': await this.diagnosticRuntime?.send(); break;
        case 'diagnostics-retry': await this.diagnosticRuntime?.retry(); break;
        case 'diagnostics-discard': await this.diagnosticRuntime?.discard(); break;
        case 'diagnostics-done': this.diagnosticRuntime?.done(); break;
      }
    } catch (error) {
      this.notice = publicError(error).code; this.recordDiagnosticFailure('application', 'lifecycle', this.notice); this.emit();
      // The page must only discard its enable/disable draft after a committed save.
      if (command.type === 'custom-apply') throw new Error(this.notice);
    }
  }
  async enableShortcut(binding: HotkeyBinding) {
    if (this.shortcutEditor.active || this.shortcutSaving) return;
    this.shortcutSaving = true; this.input.pauseForEditor(true);
    const previous = this.input.snapshot.status;
    try {
      const result = await this.input.configure(true, binding);
      if (!result.ok) throw new Error(result.reason);
      try { await this.store.updateSettings((s) => { s.preferences.shortcut = binding; delete s.preferences.shortcutLabel; }); }
      catch {
        const rollback = await this.input.configure(previous?.enabled === true && (this.auth.snapshot.signedIn || this.auth.snapshot.demo), previous?.binding ?? this.store.preferences.shortcut);
        if (!rollback.ok) this.input.disable();
        throw new Error('STORAGE_WRITE_FAILED');
      }
      this.manuallyDisabled = false; this.attemptedAutoEnable = true;
    } finally { this.shortcutSaving = false; this.input.pauseForEditor(false); this.emit(); }
  }
  dispose() { this.shortcutEditor.dispose(); this.disposed = true; this.unsubscribeDiagnostics?.(); this.auth.dispose(); this.custom.dispose(); this.billing.dispose(); this.voiceResult = null; }
}
