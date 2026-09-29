import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_RETENTION_MS, diagnosticObject, diagnosticUUID, parseDiagnosticEnvelope, parseDiagnosticEvent, type DiagnosticEnvelope, type DiagnosticEvent } from '../shared/diagnostics';

export interface DiagnosticStore {
  append(event: DiagnosticEvent): Promise<void>;
  recent(confirmedAt: number): Promise<DiagnosticEvent[]>;
  purgeOnLaunch(): Promise<void>;
  saveIfAbsent(envelope: DiagnosticEnvelope): Promise<void>;
  load(): Promise<DiagnosticEnvelope | null>;
  delete(): Promise<void>;
  beginRun(): Promise<boolean>;
  endRun(): Promise<void>;
}
export class DiagnosticStoreError extends Error {
  constructor(readonly operation: 'read' | 'write' | 'delete') { super(`DIAGNOSTIC_STORE_${operation.toUpperCase()}_FAILED`); }
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const unsafe = () => { throw new Error('DIAGNOSTIC_UNSAFE_FILE'); };
const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;

/** Node has no portable openat. Pin and recheck every ancestor and opened file;
 * final components use O_NOFOLLOW, atomic replacement and single-link regular files.
 * Profile parents must be owned/trusted by the desktop user (see development note). */
class SecureDiagnosticFiles {
  readonly directory: string;
  private directories: Array<{ name: string; stat: fs.Stats }> = [];
  constructor(profileDirectory: string, private readonly beforeDelete?: (name: string) => void, private readonly beforeDirectorySync?: (name: string) => void) {
    if (!path.isAbsolute(profileDirectory) || profileDirectory.includes('\0')) unsafe();
    this.directory = path.join(path.resolve(profileDirectory), 'Diagnostics');
  }
  private prepare() {
    const root = path.parse(this.directory).root;
    let cursor = root;
    const current: Array<{ name: string; stat: fs.Stats }> = [];
    for (const component of this.directory.slice(root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      try { fs.mkdirSync(cursor, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
      current.push({ name: cursor, stat });
    }
    if (this.directories.length && current.some((entry, index) => !sameFile(entry.stat, this.directories[index].stat))) unsafe();
    this.directories = current;
    if (process.platform !== 'win32') fs.chmodSync(this.directory, 0o700);
  }
  private checkParents() {
    for (const entry of this.directories) {
      const stat = fs.lstatSync(entry.name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFile(stat, entry.stat)) unsafe();
    }
  }
  private target(name: string) {
    if (!/^(?:events|consented-report|running|clean-exit)\.json$/.test(name)) unsafe();
    this.prepare();
    this.checkParents();
    return path.join(this.directory, name);
  }
  private regular(file: string): fs.Stats | null {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) unsafe();
      return stat;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  private syncDirectory(name: string) {
    this.checkParents();
    this.beforeDirectorySync?.(name);
    // Windows does not expose a syncable directory handle through Node's fs API.
    if (process.platform === 'win32') return;
    const fd = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { if (!sameFile(fs.fstatSync(fd), this.directories.at(-1)!.stat)) unsafe(); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  read(name: string, maximum: number): unknown | null {
    const file = this.target(name), before = this.regular(file);
    if (!before) return null;
    if (before.size > maximum) unsafe();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, before) || opened.size > maximum) unsafe();
      this.checkParents();
      const buffer = Buffer.alloc(maximum + 1);
      let count = 0;
      while (count < buffer.length) { const read = fs.readSync(fd, buffer, count, buffer.length - count, count); if (!read) break; count += read; }
      if (count > maximum) unsafe();
      const after = this.regular(file);
      if (!after || !sameFile(opened, after)) unsafe();
      this.checkParents();
      return JSON.parse(buffer.subarray(0, count).toString('utf8')) as unknown;
    } finally { fs.closeSync(fd); }
  }
  write(name: string, value: unknown, maximum: number) {
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > maximum) unsafe();
    const file = this.target(name);
    this.regular(file);
    const temporary = path.join(this.directory, `.${name}.${randomUUID()}`);
    let fd: number | undefined;
    let ownedTemporary: fs.Stats | null = null;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      const opened = fs.fstatSync(fd);
      ownedTemporary = opened;
      if (!opened.isFile() || opened.nlink !== 1) unsafe();
      fs.writeFileSync(fd, data); fs.fsyncSync(fd);
      this.checkParents(); this.regular(file);
      const actual = this.regular(temporary);
      if (!actual || !sameFile(actual, opened)) unsafe();
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
      this.syncDirectory(name);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      // Never follow/delete a substituted directory on failure.
      this.checkParents();
      if (ownedTemporary) {
        const leftover = this.regular(temporary);
        if (leftover && sameFile(leftover, ownedTemporary)) fs.unlinkSync(temporary);
        else if (leftover) unsafe();
      }
    }
  }
  purgeTemporaryFiles() {
    this.prepare(); this.checkParents();
    const directory = fs.opendirSync(this.directory);
    const names: string[] = [];
    try {
      for (let count = 0; ; count++) {
        const entry = directory.readSync();
        if (!entry) break;
        if (count >= 1024) unsafe();
        const match = /^\.((?:events|consented-report|running|clean-exit)\.json)\.(.+)$/.exec(entry.name);
        if (match && diagnosticUUID(match[2])) names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    for (const name of names) {
      this.checkParents();
      const file = path.join(this.directory, name), before = this.regular(file);
      if (!before) continue;
      this.beforeDelete?.(name);
      this.checkParents();
      const actual = this.regular(file);
      if (!actual || !sameFile(actual, before)) unsafe();
      fs.unlinkSync(file); this.syncDirectory(name);
    }
  }
  delete(name: string) {
    const file = this.target(name);
    if (!this.regular(file)) return;
    this.checkParents(); this.beforeDelete?.(name); fs.unlinkSync(file); this.syncDirectory(name);
  }
}

/** All mutations are synchronous inside a Promise operation: no await between read/replace. */
export class DiskDiagnosticStore implements DiagnosticStore {
  private readonly files: SecureDiagnosticFiles;
  private readonly now: () => number;
  private runId: string | null = null;
  private attemptedRunId: string | null = null;
  constructor(profileDirectory: string, options: { now?: () => number; beforeDelete?: (name: string) => void; beforeDirectorySync?: (name: string) => void } = {}) {
    this.files = new SecureDiagnosticFiles(profileDirectory, options.beforeDelete, options.beforeDirectorySync); this.now = options.now ?? Date.now;
  }
  private operation<T>(kind: 'read' | 'write' | 'delete', action: () => T): Promise<T> {
    try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error instanceof DiagnosticStoreError ? error : new DiagnosticStoreError(kind)); }
  }
  private events(): DiagnosticEvent[] {
    const raw = this.files.read('events.json', 1_048_576);
    if (raw === null) return [];
    if (!Array.isArray(raw) || raw.length > 200) unsafe();
    return (raw as unknown[]).map(parseDiagnosticEvent);
  }
  append(event: DiagnosticEvent): Promise<void> {
    return this.operation('write', () => {
      const validated = parseDiagnosticEvent(event), cutoff = this.now() - DIAGNOSTIC_RETENTION_MS;
      const events = [...this.events(), validated].filter((entry) => Date.parse(entry.occurredAt) >= cutoff).slice(-200);
      this.files.write('events.json', events, 1_048_576);
    });
  }
  recent(confirmedAt: number): Promise<DiagnosticEvent[]> {
    return this.operation('read', () => this.events().filter((event) => Date.parse(event.occurredAt) >= this.now() - DIAGNOSTIC_RETENTION_MS && Date.parse(event.occurredAt) <= confirmedAt).slice(-20));
  }
  purgeOnLaunch(): Promise<void> {
    return this.operation('delete', () => {
      this.files.delete('consented-report.json');
      this.files.purgeTemporaryFiles();
      const events = this.events().filter((event) => Date.parse(event.occurredAt) >= this.now() - DIAGNOSTIC_RETENTION_MS);
      this.files.write('events.json', events, 1_048_576);
    });
  }
  saveIfAbsent(envelope: DiagnosticEnvelope): Promise<void> {
    return this.operation('write', () => {
      const validated = parseDiagnosticEnvelope(envelope, this.now());
      const existing = this.files.read('consented-report.json', DIAGNOSTIC_MAX_BYTES);
      if (existing !== null) {
        const saved = parseDiagnosticEnvelope(existing, this.now(), false);
        if (JSON.stringify(saved) !== JSON.stringify(validated)) throw new Error('DIAGNOSTIC_CACHE_CONFLICT');
        return;
      }
      this.files.write('consented-report.json', validated, DIAGNOSTIC_MAX_BYTES);
    });
  }
  load(): Promise<DiagnosticEnvelope | null> {
    return this.operation('read', () => {
      const raw = this.files.read('consented-report.json', DIAGNOSTIC_MAX_BYTES);
      return raw === null ? null : parseDiagnosticEnvelope(raw, this.now(), false);
    });
  }
  delete(): Promise<void> { return this.operation('delete', () => this.files.delete('consented-report.json')); }
  private marker(name: 'running.json' | 'clean-exit.json'): string | null {
    const raw = this.files.read(name, 512); if (raw === null) return null;
    const row = diagnosticObject(raw, ['schemaVersion', 'runId']);
    if (row.schemaVersion !== 1 || !diagnosticUUID(row.runId)) unsafe();
    return row.runId as string;
  }
  beginRun(): Promise<boolean> {
    // No await between observing and replacing markers. An existing owner must
    // never resume or terminate over a newer run created by another store.
    return this.operation('write', () => {
      let previous: string | null, clean: string | null;
      try { previous = this.marker('running.json'); clean = this.marker('clean-exit.json'); }
      catch { throw new DiagnosticStoreError('read'); }
      if (this.runId || this.attemptedRunId) {
        if (previous !== null && previous !== this.runId && previous !== this.attemptedRunId) throw new DiagnosticStoreError('read');
        if (previous !== null && previous === this.attemptedRunId) { this.runId = previous; this.attemptedRunId = null; }
        if (previous !== null && previous === this.runId && clean !== this.runId) return false;
        // endRun may have written clean-exit then failed deleting/syncing running.
        // A resumed application needs a fresh identity, not this clean identity.
      }
      const runId = randomUUID();
      // rename may commit even if the following directory sync throws. Remember
      // the candidate before writing so clean termination can recognize ownership.
      this.attemptedRunId = runId;
      this.files.write('running.json', { schemaVersion: 1, runId }, 512);
      this.runId = runId; this.attemptedRunId = null;
      try { this.files.delete('clean-exit.json'); }
      catch { throw new DiagnosticStoreError('delete'); }
      return previous !== null && previous !== clean;
    });
  }
  endRun(): Promise<void> {
    return this.operation('delete', () => {
      if (!this.runId && !this.attemptedRunId) return;
      let owner: string | null;
      try { owner = this.marker('running.json'); }
      catch { throw new DiagnosticStoreError('read'); }
      if (owner !== null && owner !== this.runId && owner !== this.attemptedRunId) throw new DiagnosticStoreError('read');
      if (owner === null) {
        const clean = this.marker('clean-exit.json');
        if (clean !== null && (clean === this.runId || clean === this.attemptedRunId)) this.files.delete('clean-exit.json');
        this.runId = null; this.attemptedRunId = null; return;
      }
      const runId = owner;
      this.runId = runId; this.attemptedRunId = null;
      try { this.files.write('clean-exit.json', { schemaVersion: 1, runId }, 512); }
      catch {
        this.files.delete('running.json'); this.runId = null;
        throw new DiagnosticStoreError('write');
      }
      this.files.delete('running.json'); this.runId = null;
      this.files.delete('clean-exit.json');
    });
  }
}
