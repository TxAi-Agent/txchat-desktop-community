import { cloudId } from '../adapters/cloud/client';
import { isShortcutDisplayLabel } from '../shared/shortcut-bindings';
import { parseUpdateVersion } from './update-configuration';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Preferences, DictionaryEntry } from '../shared/product';
import { isHotkeyBinding } from '../shared/native-input';
import { decodeDictionary, encodeDictionary } from '../domain/dictionary';

export interface StoredSession {
  origin: string; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number;
  deviceId: string; sessionId: string; accountId: string | null; maskedPhone: string;
  pendingRefresh: { id: string; startedAt: number } | null;
}
export interface StoredProvider { providerId: string; modelId: string; values: Record<string, string> }
export interface Vault {
  schema: 1; session: StoredSession | null;
  providers: { asr: Record<string, StoredProvider>; optimization: Record<string, StoredProvider> };
  selected: { asr: string; optimization: string };
}
interface Settings { schema: 1; installationId: string; preferences: Preferences; onboarding: string[]; skippedUpdateVersion?: string; voiceTestCompleted?: boolean; pendingBilling?: { account: string; key: string; orderId: string | null } }
export interface Cipher { available(): boolean; encrypt(text: string): Buffer; decrypt(bytes: Buffer): string }
const emptyVault = (): Vault => ({ schema: 1, session: null, providers: { asr: {}, optimization: {} }, selected: { asr: '', optimization: '' } });
const defaults = (): Settings => ({ schema: 1, installationId: randomUUID(), preferences: {
  language: 'zh', theme: 'system', mode: 'smart', service: 'cloud', shortcut: process.platform === 'darwin' ? 'fn' : 'key::F8',
}, onboarding: [] });
export class ProductStore {
  private settings = defaults(); private vault = emptyVault();
  private settingsWritable = true; private vaultWritable = true; private sessionWritable = true;
  private settingsQueue = Promise.resolve(); private vaultQueue = Promise.resolve(); private sessionQueue = Promise.resolve(); private dictionaryQueue = Promise.resolve();
  readonly dictionaryPath: string;
  constructor(private readonly root: string, private readonly cipher: Cipher) { this.dictionaryPath = path.join(root, 'dictionary.md'); }
  get preferences() { return structuredClone(this.settings.preferences); }
  get voiceTestCompleted() { return this.settings.voiceTestCompleted === true; }
  get installationId() { return this.settings.installationId; }
  get skippedUpdateVersion() { return this.settings.skippedUpdateVersion ?? null; }
  saveSkippedUpdateVersion(version: string) {
    if (!parseUpdateVersion(version)) return Promise.reject(new Error('INVALID_UPDATE_VERSION'));
    return this.updateSettings((settings) => { settings.skippedUpdateVersion = version; });
  }
  get pendingBilling() { return this.settings.pendingBilling ? { ...this.settings.pendingBilling } : null; }
  requireSecureStorage() { if (!this.cipher.available()) throw new Error('SECURE_STORAGE_UNAVAILABLE'); }
  get secrets(): Vault { return structuredClone(this.vault); }
  onboardingComplete(account: string) { return this.settings.onboarding.includes(account); }
  private async bytes(file: string, limit: number): Promise<Buffer | null> {
    try {
      const handle = await open(file, 'r');
      try {
        const buffer = Buffer.alloc(limit + 1); let offset = 0;
        while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
        if (offset > limit) { buffer.fill(0); throw new Error('STORAGE_TOO_LARGE'); }
        return buffer.subarray(0, offset);
      } finally { await handle.close(); }
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('STORAGE_READ_FAILED'); }
  }
  async load(): Promise<string[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const errors: string[] = [];
    try {
      const bytes = await this.bytes(path.join(this.root, 'settings.json'), 131_072);
      if (bytes) {
        const value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) as Settings;
        if (value.schema !== 1 || !/^[a-f\d-]{36}$/i.test(value.installationId) || !value.preferences ||
          !['zh', 'en'].includes(value.preferences.language) || !['system', 'light', 'dark'].includes(value.preferences.theme) ||
          !['smart', 'verbatim'].includes(value.preferences.mode) || !['cloud', 'custom', 'local'].includes(value.preferences.service) ||
          !isHotkeyBinding(value.preferences.shortcut) || !Array.isArray(value.onboarding) || value.onboarding.length > 1000 ||
          !value.onboarding.every((x) => typeof x === 'string' && x.length <= 300)) throw new Error();
        if (value.preferences.shortcutLabel !== undefined && (!isShortcutDisplayLabel(value.preferences.shortcutLabel) || value.preferences.shortcutLabel.binding !== value.preferences.shortcut)) throw new Error();
        if (value.voiceTestCompleted !== undefined && typeof value.voiceTestCompleted !== 'boolean') throw new Error();
        if (value.skippedUpdateVersion !== undefined && !parseUpdateVersion(value.skippedUpdateVersion)) throw new Error();
        if (value.pendingBilling && (typeof value.pendingBilling.account !== 'string' || value.pendingBilling.account.length > 300 ||
          !/^[a-f\d-]{36}$/i.test(value.pendingBilling.key) || (value.pendingBilling.orderId !== null && !cloudId(value.pendingBilling.orderId)))) throw new Error();
        this.settings = value;
      } else await this.atomic(path.join(this.root, 'settings.json'), JSON.stringify(this.settings));
    } catch { this.settingsWritable = false; errors.push('SETTINGS_READ_FAILED'); }
    try {
      const bytes = await this.bytes(path.join(this.root, 'credentials.enc'), 262_144);
      if (bytes) {
        if (!this.cipher.available()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
        const value = JSON.parse(this.cipher.decrypt(bytes)) as Vault;
        if (value.schema !== 1 || !value.providers || !value.providers.asr || !value.providers.optimization || !value.selected ||
          typeof value.selected.asr !== 'string' || typeof value.selected.optimization !== 'string') throw new Error();
        if (value.session !== null) throw new Error();
        for (const group of [value.providers.asr, value.providers.optimization]) {
          if (typeof group !== 'object' || Array.isArray(group) || Object.keys(group).length > 20) throw new Error();
          for (const [key, provider] of Object.entries(group)) {
            if (!provider || key !== provider.providerId || typeof provider.modelId !== 'string' || !provider.values ||
              Object.entries(provider.values).length > 8 || !Object.entries(provider.values).every(([k, v]) => /^[a-z-]{1,30}$/.test(k) && typeof v === 'string' && new TextEncoder().encode(v).length <= 16_384)) throw new Error();
          }
        }
        this.vault = value;
      }
    } catch { this.vaultWritable = false; errors.push('SECURE_STORAGE_READ_FAILED'); }
    try {
      const bytes = await this.bytes(path.join(this.root, 'session.enc'), 32_768);
      if (bytes) {
        if (!this.cipher.available()) throw new Error();
        const value = JSON.parse(this.cipher.decrypt(bytes)) as StoredSession;
        if (!value.origin || !value.refreshToken || (value.accountId !== null && !cloudId(value.accountId)) || typeof value.accessToken !== 'string' ||
          typeof value.maskedPhone !== 'string' || typeof value.deviceId !== 'string' || typeof value.sessionId !== 'string' ||
          !Number.isFinite(value.accessExpiresAt) || !Number.isFinite(value.refreshExpiresAt) ||
          (value.pendingRefresh && (!/^[a-f\d-]{36}$/i.test(value.pendingRefresh.id) || !Number.isFinite(value.pendingRefresh.startedAt)))) throw new Error();
        this.vault.session = value;
      }
    } catch { this.sessionWritable = false; errors.push('SESSION_STORAGE_READ_FAILED'); }
    return errors;
  }
  private async atomic(file: string, content: string | Buffer) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } catch { throw new Error('STORAGE_WRITE_FAILED'); }
    finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  updateSettings(change: (settings: Settings) => void): Promise<void> {
    const task = this.settingsQueue.then(async () => {
      if (!this.settingsWritable) throw new Error('SETTINGS_READ_FAILED');
      const candidate = structuredClone(this.settings); change(candidate);
      if (candidate.preferences.shortcutLabel !== undefined && (!isShortcutDisplayLabel(candidate.preferences.shortcutLabel) || candidate.preferences.shortcutLabel.binding !== candidate.preferences.shortcut)) throw new Error('INVALID_SHORTCUT_LABEL');
      await this.atomic(path.join(this.root, 'settings.json'), JSON.stringify(candidate)); this.settings = candidate;
    });
    this.settingsQueue = task.catch(() => undefined); return task;
  }
  updateVault(change: (vault: Vault) => void): Promise<void> {
    const task = this.vaultQueue.then(async () => {
      if (!this.vaultWritable || !this.cipher.available()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
      const candidate = structuredClone(this.vault); change(candidate); const text = JSON.stringify({ ...candidate, session: null });
      if (Buffer.byteLength(text) > 196_608) throw new Error('STORAGE_TOO_LARGE');
      await this.atomic(path.join(this.root, 'credentials.enc'), this.cipher.encrypt(text)); this.vault = { ...candidate, session: this.vault.session };
    });
    this.vaultQueue = task.catch(() => undefined); return task;
  }
  updateSession(value: StoredSession) {
    const candidate = structuredClone(value);
    const task = this.sessionQueue.then(async () => {
      if (!this.sessionWritable || !this.cipher.available()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
      await this.atomic(path.join(this.root, 'session.enc'), this.cipher.encrypt(JSON.stringify(candidate))); this.vault.session = candidate;
    });
    this.sessionQueue = task.catch(() => undefined); return task;
  }
  /** Logout deletes the isolated auth file even when decryption is unavailable; provider records remain intact. */
  clearSession() {
    const task = this.sessionQueue.then(async () => {
      await rm(path.join(this.root, 'session.enc'), { force: true }); this.vault.session = null; this.sessionWritable = true;
    });
    this.sessionQueue = task.catch(() => undefined); return task;
  }
  async loadDictionary() {
    await this.dictionaryQueue;
    const bytes = await this.bytes(this.dictionaryPath, 1_048_576);
    if (bytes === null) { await this.saveDictionary([]); return { entries: [], skippedLines: 0 }; }
    return decodeDictionary(bytes);
  }
  ensureDictionaryFile() {
    const task = this.dictionaryQueue.then(async () => {
      // Reveal must also work for malformed/oversized files so they can be
      // repaired externally. Exclusive creation never overwrites such a file.
      let handle;
      try { handle = await open(this.dictionaryPath, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
      try { await handle.writeFile(encodeDictionary([])); await handle.sync(); }
      finally { await handle.close(); }
    });
    this.dictionaryQueue = task.catch(() => undefined); return task;
  }
  saveDictionary(entries: DictionaryEntry[]) {
    const content = encodeDictionary(entries);
    const task = this.dictionaryQueue.then(() => this.atomic(this.dictionaryPath, content));
    this.dictionaryQueue = task.catch(() => undefined); return task;
  }
  async flush() { await Promise.all([this.settingsQueue, this.vaultQueue, this.sessionQueue, this.dictionaryQueue]); }
}
