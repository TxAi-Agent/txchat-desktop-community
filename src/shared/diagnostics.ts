/** Cloud diagnostic schema v1. Every persisted/uploaded field is allowlisted. */
export const diagnosticCategories = ['application', 'authentication', 'dictation', 'insertion', 'update', 'custom_asr', 'custom_optimization'] as const;
export const diagnosticStages = ['lifecycle', 'session_restore', 'session_install', 'session_delete', 'capture_preflight', 'capture_start', 'stream_start', 'audio_pump', 'stream_finish', 'final_preparation', 'target_capture', 'clipboard_transaction', 'event_delivery', 'update_check', 'update_download', 'update_install', 'provider_configuration', 'provider_test', 'provider_request', 'provider_response'] as const;
export const diagnosticCodes = ['ABNORMAL_EXIT', 'LOCAL_STATE_READ_FAILED', 'LOCAL_STATE_WRITE_FAILED', 'LOCAL_STATE_DELETE_FAILED', 'PROTOCOL_VIOLATION', 'AUDIO_CONVERSION_FAILED', 'AUDIO_BUFFER_OVERFLOW', 'CAPTURE_INTERNAL_FAILURE', 'INSERTION_TRANSACTION_BUSY', 'PASTEBOARD_SNAPSHOT_FAILED', 'PASTEBOARD_WRITE_FAILED', 'PASTE_EVENT_FAILED', 'UPDATE_METADATA_INVALID', 'UPDATE_SIGNATURE_INVALID', 'UPDATE_INSTALL_FAILED', 'PROVIDER_CONFIGURATION_INVALID', 'PROVIDER_PROTOCOL_VIOLATION', 'INTERNAL_ERROR'] as const;
export type DiagnosticCategory = typeof diagnosticCategories[number];
export type DiagnosticStage = typeof diagnosticStages[number];
export type DiagnosticCode = typeof diagnosticCodes[number];
export type DiagnosticPermission = 'authorized' | 'denied' | 'not_determined' | 'restricted' | 'unknown';
export interface DiagnosticIncident { category: DiagnosticCategory; stage: DiagnosticStage; code: DiagnosticCode; taskId?: string }
export interface DiagnosticEvent extends DiagnosticIncident { occurredAt: string; durationMs?: number; httpStatus?: number }
export interface DiagnosticEnvironment {
  installationId: string;
  app: { version: string; build: string; locale: 'zh-Hans' | 'en'; architecture: 'arm64' | 'x86_64' | 'unknown' };
  system: { platform: 'macos' | 'windows'; osVersion: string; microphone: DiagnosticPermission; accessibility: DiagnosticPermission };
  service: { mode: 'custom' | 'txchat_cloud' };
}
export interface DiagnosticEnvelope extends DiagnosticEnvironment {
  schemaVersion: 1; reportId: string; consent: { promptVersion: 1; confirmedAt: string };
  occurredAt: string; incident: DiagnosticIncident; events: DiagnosticEvent[];
}
export interface DiagnosticReceipt { reportId: string; diagnosticNumber: string; receivedAt: string }
export interface DiagnosticState {
  phase: 'idle' | 'prompt' | 'sending' | 'sent' | 'failed';
  isAbnormalExit: boolean;
  reportId: string | null;
  diagnosticNumber: string | null;
}
export const DIAGNOSTIC_RETENTION_MS = 7 * 86_400_000;
export const DIAGNOSTIC_MAX_BYTES = 65_536;
export const diagnosticUUID = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function fail(): never { throw new Error('DIAGNOSTIC_INVALID'); }
export function diagnosticObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (!required.every((key) => Object.hasOwn(row, key)) || !Object.keys(row).every((key) => required.includes(key) || optional.includes(key))) return fail();
  return row;
}
export function diagnosticTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return fail();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return fail();
  return time;
}
function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return fail();
  return value as T;
}
export function parseDiagnosticIncident(value: unknown): DiagnosticIncident {
  const row = diagnosticObject(value, ['category', 'stage', 'code'], ['taskId']);
  if (row.taskId !== undefined && !diagnosticUUID(row.taskId)) return fail();
  return { category: member(row.category, diagnosticCategories), stage: member(row.stage, diagnosticStages), code: member(row.code, diagnosticCodes), ...(row.taskId === undefined ? {} : { taskId: (row.taskId as string).toLowerCase() }) };
}
export function parseDiagnosticEvent(value: unknown): DiagnosticEvent {
  const row = diagnosticObject(value, ['category', 'stage', 'code', 'occurredAt'], ['taskId', 'durationMs', 'httpStatus']);
  diagnosticTimestamp(row.occurredAt);
  const { occurredAt, durationMs, httpStatus, ...incident } = row;
  for (const [number, min, max] of [[durationMs, 0, 3_600_000], [httpStatus, 100, 599]] as const) {
    if (number !== undefined && (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max)) return fail();
  }
  return { ...parseDiagnosticIncident(incident), occurredAt: occurredAt as string, ...(durationMs === undefined ? {} : { durationMs: durationMs as number }), ...(httpStatus === undefined ? {} : { httpStatus: httpStatus as number }) };
}
export function parseDiagnosticEnvironment(value: unknown): DiagnosticEnvironment {
  const row = diagnosticObject(value, ['installationId', 'app', 'system', 'service']);
  if (!diagnosticUUID(row.installationId)) return fail();
  const app = diagnosticObject(row.app, ['version', 'build', 'locale', 'architecture']);
  const system = diagnosticObject(row.system, ['platform', 'osVersion', 'microphone', 'accessibility']);
  const service = diagnosticObject(row.service, ['mode']);
  for (const version of [app.version, system.osVersion]) if (typeof version !== 'string' || version.length > 64 || !/^\d+(?:\.\d+){1,3}$/.test(version)) return fail();
  if (typeof app.build !== 'string' || !/^\d{1,18}$/.test(app.build)) return fail();
  const permissions = ['authorized', 'denied', 'not_determined', 'restricted', 'unknown'] as const;
  return { installationId: row.installationId.toLowerCase(), app: { version: app.version as string, build: app.build, locale: member(app.locale, ['zh-Hans', 'en']), architecture: member(app.architecture, ['arm64', 'x86_64', 'unknown']) }, system: { platform: member(system.platform, ['macos', 'windows']), osVersion: system.osVersion as string, microphone: member(system.microphone, permissions), accessibility: member(system.accessibility, permissions) }, service: { mode: member(service.mode, ['custom', 'txchat_cloud']) } };
}
export function parseDiagnosticEnvelope(value: unknown, now = Date.now(), enforceAge = true): DiagnosticEnvelope {
  const row = diagnosticObject(value, ['schemaVersion', 'reportId', 'installationId', 'consent', 'occurredAt', 'app', 'system', 'service', 'incident', 'events']);
  if (row.schemaVersion !== 1 || !diagnosticUUID(row.reportId)) return fail();
  const consent = diagnosticObject(row.consent, ['promptVersion', 'confirmedAt']);
  const confirmed = diagnosticTimestamp(consent.confirmedAt), occurred = diagnosticTimestamp(row.occurredAt);
  if (consent.promptVersion !== 1 || occurred > confirmed || confirmed > now + 300_000 || (enforceAge && occurred < now - DIAGNOSTIC_RETENTION_MS)) return fail();
  if (!Array.isArray(row.events) || row.events.length > 20) return fail();
  const events = row.events.map(parseDiagnosticEvent);
  if (events.some((event) => diagnosticTimestamp(event.occurredAt) > confirmed)) return fail();
  const environment = parseDiagnosticEnvironment({ installationId: row.installationId, app: row.app, system: row.system, service: row.service });
  const result: DiagnosticEnvelope = { ...environment, schemaVersion: 1, reportId: row.reportId.toLowerCase(), consent: { promptVersion: 1, confirmedAt: consent.confirmedAt as string }, occurredAt: row.occurredAt as string, incident: parseDiagnosticIncident(row.incident), events };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > DIAGNOSTIC_MAX_BYTES) return fail();
  return result;
}
export function parseDiagnosticReceipt(value: unknown, reportId: string): DiagnosticReceipt {
  const row = diagnosticObject(value, ['reportId', 'diagnosticNumber', 'receivedAt']);
  if (!diagnosticUUID(row.reportId) || row.reportId.toLowerCase() !== reportId.toLowerCase() || typeof row.diagnosticNumber !== 'string' || !(/^[A-Za-z0-9_-]{1,100}$/).test(row.diagnosticNumber)) return fail();
  diagnosticTimestamp(row.receivedAt);
  return { reportId: row.reportId.toLowerCase(), diagnosticNumber: row.diagnosticNumber, receivedAt: row.receivedAt as string };
}
