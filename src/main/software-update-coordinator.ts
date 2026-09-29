import type { Phase } from '../shared/contracts';
import type { SoftwareUpdateAction, SoftwareUpdateFailure, SoftwareUpdateItem, SoftwareUpdateSnapshot } from '../shared/software-update';
import { compareUpdateVersions } from './update-configuration';

export interface SoftwareUpdateBackend {
  check(): Promise<SoftwareUpdateItem | null>;
  download(signal: AbortSignal, progress: (received: number, total: number) => void): Promise<void>;
  /** Failure can arrive after dispatch (notably native macOS staging). beforeQuit must run immediately before the official installer exits. */
  install(failed: (failure: SoftwareUpdateFailure) => void, beforeQuit: () => Promise<void>): Promise<void>;
  dispose(): void;
}
/** A valid mandatory release that this OS cannot install must not be reported as "current". */
export class SoftwareUpdateCheckError extends Error {
  constructor(code: string, readonly requiredItem: SoftwareUpdateItem | null = null) { super(code); }
}
export interface SoftwareUpdateOptions {
  currentVersion: string;
  backend: SoftwareUpdateBackend | null;
  configurationFailure?: boolean;
  publish: () => void;
  dictationPhase: () => Phase;
  loadSkippedVersion: () => string | null;
  saveSkippedVersion: (version: string) => Promise<void>;
  /** Flush state and stop helper at this point. Do not set the app's quitting flag before native staging succeeds. */
  prepareForInstall: () => Promise<void>;
  quit: () => Promise<void>;
  recordFailure?: (failure: SoftwareUpdateFailure, stage: 'update_check' | 'update_download' | 'update_install') => void;
}
export function isSoftwareUpdateSafeNode(phase: Phase) { return ['unavailable', 'idle', 'completed', 'failed'].includes(phase); }
export function softwareUpdateFailure(error: unknown, fallback: SoftwareUpdateFailure): SoftwareUpdateFailure {
  const code = error instanceof Error ? `${(error as Error & { code?: string }).code ?? ''} ${error.message}` : '';
  if (/UPDATE_INSTALL_STAGING_TIMEOUT|UPDATE_INSTALL_RESTART_REQUIRED/.test(code)) return 'restart-required';
  if (/UPDATE_CONFIGURATION|publisherName/i.test(code)) return 'configuration';
  if (/INVALID_SIGNATURE|signature|CodeSignature|ERR_UPDATER_INVALID.*HASH|checksum/i.test(code)) return 'signature';
  if (/UPDATE_METADATA|INVALID_VERSION|INVALID_UPDATE_INFO|NO_FILES_PROVIDED|CHANNEL_FILE_NOT_FOUND|ZIP_FILE_NOT_FOUND|UNSUPPORTED/i.test(code)) return 'metadata';
  return fallback;
}
export class SoftwareUpdateCoordinator {
  private state: SoftwareUpdateSnapshot;
  private requiredItem: SoftwareUpdateItem | null = null;
  private generation = 0;
  private disposed = false;
  private busy = false;
  private downloadAbort: AbortController | null = null;
  private skipped: string | null;
  constructor(private readonly options: SoftwareUpdateOptions) {
    this.skipped = options.loadSkippedVersion();
    this.state = { phase: options.backend ? 'idle' : 'unavailable', version: options.currentVersion, item: null,
      downloadedBytes: 0, totalBytes: 0, progress: 0, failure: options.configurationFailure ? 'configuration' : null,
      pendingAction: null, blocksNewDictation: false, visible: false };
  }
  get blocksNewDictation() { return !!this.requiredItem || this.state.phase === 'installing' || this.state.pendingAction !== null; }
  get snapshot(): SoftwareUpdateSnapshot { return structuredClone({ ...this.state, blocksNewDictation: this.blocksNewDictation }); }
  private emit(change: Partial<SoftwareUpdateSnapshot>) { if (!this.disposed) { this.state = { ...this.state, ...change }; this.options.publish(); } }
  private current(generation: number) { return !this.disposed && generation === this.generation; }
  private fail(failure: SoftwareUpdateFailure, visible = true) {
    const stage = this.state.phase === 'installing' ? 'update_install' : this.state.phase === 'downloading' ? 'update_download' : 'update_check';
    this.emit({ phase: 'failed', failure, pendingAction: null, visible, item: this.requiredItem ?? this.state.item });
    try { this.options.recordFailure?.(failure, stage); } catch { /* Diagnostics must not prevent installation recovery. */ }
  }
  async check(_manual = true): Promise<void> {
    if (this.disposed || this.busy || this.state.phase === 'installing' || this.state.pendingAction) return;
    if (!this.options.backend) { this.emit({ phase: 'unavailable', visible: _manual }); return; }
    const generation = ++this.generation; this.busy = true;
    this.emit({ phase: 'checking', failure: null, visible: !!this.requiredItem, item: this.requiredItem });
    try {
      const item = await this.options.backend.check();
      if (!this.current(generation)) return;
      if (!item || compareUpdateVersions(item.version, this.options.currentVersion) <= 0) {
        if (this.requiredItem) this.fail('metadata');
        else this.emit({ phase: 'current', item: null, visible: false });
        return;
      }
      if (this.requiredItem && compareUpdateVersions(item.version, this.requiredItem.version) < 0) { this.fail('metadata'); return; }
      // A transient feed failure, retry, or metadata retreat cannot unlock a discovered mandatory update.
      if (item.required || this.requiredItem) this.requiredItem = { ...item, required: true };
      const presented = this.requiredItem ?? item;
      if (!presented.required && item.version === this.skipped) { this.emit({ phase: 'current', item: null, visible: false }); return; }
      this.emit({ phase: 'available', item: presented, downloadedBytes: 0, totalBytes: presented.size ?? 0, progress: 0, visible: true });
    } catch (error) {
      if (this.current(generation)) {
        if (error instanceof SoftwareUpdateCheckError && error.requiredItem?.required &&
          compareUpdateVersions(error.requiredItem.version, this.options.currentVersion) > 0 &&
          (!this.requiredItem || compareUpdateVersions(error.requiredItem.version, this.requiredItem.version) >= 0)) this.requiredItem = error.requiredItem;
        this.fail(softwareUpdateFailure(error, 'unavailable'), !!this.requiredItem);
      }
    }
    finally { this.busy = false; }
  }
  async download(): Promise<void> {
    if (this.disposed || this.busy || this.state.phase !== 'available' || !this.options.backend) return;
    const generation = ++this.generation; const abort = new AbortController(); this.downloadAbort = abort; this.busy = true;
    this.emit({ phase: 'downloading', failure: null, downloadedBytes: 0, progress: 0, visible: true });
    try {
      await this.options.backend.download(abort.signal, (received, total) => {
        if (!this.current(generation) || abort.signal.aborted || !Number.isFinite(received) || !Number.isFinite(total) || received < 0 || total < 0) return;
        this.emit({ downloadedBytes: Math.floor(received), totalBytes: Math.floor(total), progress: total > 0 ? Math.min(1, received / total) : 0 });
      });
      if (this.current(generation) && !abort.signal.aborted) this.emit({ phase: 'ready', progress: 1 });
    } catch (error) { if (this.current(generation) && !abort.signal.aborted) this.fail(softwareUpdateFailure(error, 'download')); }
    finally { if (this.downloadAbort === abort) this.downloadAbort = null; this.busy = false; }
  }
  cancelDownload() {
    if (this.disposed || this.requiredItem || this.state.phase !== 'downloading') return;
    ++this.generation; this.downloadAbort?.abort(); this.emit({ phase: 'idle', item: null, failure: null, visible: false, progress: 0, downloadedBytes: 0 });
  }
  async skip() {
    if (this.disposed || this.busy || this.requiredItem || this.state.phase !== 'available' || !this.state.item) return;
    this.busy = true; const generation = this.generation; const version = this.state.item.version;
    try {
      await this.options.saveSkippedVersion(version);
      if (this.current(generation)) { this.skipped = version; this.emit({ phase: 'idle', item: null, visible: false }); }
    } catch { if (this.current(generation)) this.fail('storage'); }
    finally { this.busy = false; }
  }
  close() {
    if (this.disposed || this.busy || this.requiredItem || this.state.pendingAction || ['downloading', 'installing'].includes(this.state.phase)) return;
    // Preserve a downloaded package for another explicit install request in this process.
    this.emit(this.state.phase === 'ready' ? { visible: false } : { phase: 'idle', item: null, failure: null, visible: false });
  }
  installLater() { if (this.state.phase === 'ready') this.close(); }
  async retry() { if (this.state.phase === 'failed') await this.check(); }
  async installAndRestart() {
    if (this.disposed || this.busy || this.state.phase !== 'ready' || this.state.pendingAction) return;
    this.emit({ pendingAction: 'install' }); await this.performPending();
  }
  async quitRequired() {
    if (this.disposed || !this.requiredItem && this.state.failure !== 'restart-required' || this.state.phase === 'installing' || this.state.pendingAction) return;
    this.emit({ pendingAction: 'quit' }); await this.performPending();
  }
  observeDictation(_phase: Phase) { void this.performPending(); }
  private async performPending() {
    if (this.disposed || !this.state.pendingAction || !isSoftwareUpdateSafeNode(this.options.dictationPhase())) return;
    const action = this.state.pendingAction;
    if (action === 'install' && this.busy) return;
    const generation = ++this.generation;
    this.emit({ pendingAction: null, phase: 'installing', failure: null });
    try {
      if (action === 'quit') {
        this.downloadAbort?.abort(); await this.options.quit();
      } else if (this.options.backend) {
        await this.options.backend.install((failure) => { if (this.current(generation)) this.fail(failure); }, async () => {
          if (!this.current(generation) || this.state.phase !== 'installing' || !isSoftwareUpdateSafeNode(this.options.dictationPhase())) throw new Error('UPDATE_INSTALL_NOT_SAFE');
          await this.options.prepareForInstall();
          if (!this.current(generation) || this.state.phase !== 'installing' || !isSoftwareUpdateSafeNode(this.options.dictationPhase())) throw new Error('UPDATE_INSTALL_NOT_SAFE');
        });
      }
    } catch (error) { if (this.current(generation)) this.fail(softwareUpdateFailure(error, 'installation')); }
  }
  async command(action: SoftwareUpdateAction) {
    switch (action) {
      case 'update-check': await this.check(); break;
      case 'update-download': await this.download(); break;
      case 'update-skip': await this.skip(); break;
      case 'update-cancel': this.cancelDownload(); break;
      case 'update-retry': await this.retry(); break;
      case 'update-install': await this.installAndRestart(); break;
      case 'update-later': this.installLater(); break;
      case 'update-quit': await this.quitRequired(); break;
      case 'update-close': this.close(); break;
    }
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.generation++; this.downloadAbort?.abort(); this.options.backend?.dispose(); }
}
