import { exactObject } from './native-protocol';

import { isHotkeyBinding, type HotkeyBinding } from './shortcut-bindings';
export { BINDINGS, isHotkeyBinding, parseShortcutBinding, createShortcutBinding, shortcutDisplayName } from './shortcut-bindings';
export type { HotkeyBinding } from './shortcut-bindings';
export const INPUT_REASONS = ['INVALID_ARGUMENTS', 'PERMISSION_REQUIRED', 'HOTKEY_CONFLICT', 'HOTKEY_UNAVAILABLE',
  'UNSUPPORTED_BINDING', 'TARGET_UNAVAILABLE', 'TARGET_CHANGED', 'PROTECTED_TARGET', 'OWN_APPLICATION',
  'CAPACITY_EXCEEDED', 'INPUT_BUSY', 'SECURE_INPUT', 'SELECTION_CHANGED', 'TEXT_TOO_LONG', 'MODIFIERS_HELD',
  'CLIPBOARD_CHANGED', 'DELIVERY_UNCONFIRMED', 'TARGET_EXPIRED', 'OPERATION_CONFLICT', 'CANCELLED',
  'INSERTION_TRANSACTION_BUSY', 'PASTEBOARD_SNAPSHOT_FAILED', 'PASTEBOARD_WRITE_FAILED', 'PASTEBOARD_RESTORE_FAILED', 'PASTE_EVENT_FAILED'] as const;
export type InputReason = typeof INPUT_REASONS[number];
export type Permission = 'granted' | 'denied' | 'notRequired';
export interface NativeInputStatus {
  accessibility: Permission; inputMonitoring: Permission; enabled: boolean;
  binding: HotkeyBinding; generation: number; reason: InputReason | null;
}
export interface NativeHotkeyEvent {
  v: 1; event: 'hotkey'; instanceId: string; sequence: number; generation: number;
  /** Physical edges carry no target; only activated requests a dictation toggle. */
  phase: 'pressed' | 'released' | 'activated'; targetId: string | null; reason: InputReason | null;
}
export interface NativeTarget { targetId: string; applicationName: string }
/** submitted acknowledges one foreground paste, without claiming editor text proof. */
export interface NativeInsertion {
  outcome: 'inserted' | 'submitted' | 'notInserted' | 'partialOrUnknown'; reason: InputReason | null;
  /** A clipboard cleanup warning must not turn an already delivered result into a retry. */
  warning?: 'PASTEBOARD_RESTORE_FAILED';
}
export interface ConfigureInput { enabled: boolean; binding: HotkeyBinding; generation: number; excludedPids: number[] }
export interface InsertText { targetId: string; sessionId: string; operationId: string; text: string }
export interface InputSnapshot { status: NativeInputStatus | null; busy: boolean; notice: string | null; error?: InputReason | null }
export const isToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
const isReason = (value: unknown) => value === null || INPUT_REASONS.includes(value as InputReason);
const isPermission = (value: unknown) => ['granted', 'denied', 'notRequired'].includes(value as string);
export function parseInputStatus(value: unknown): NativeInputStatus {
  if (!exactObject(value, ['accessibility', 'inputMonitoring', 'enabled', 'binding', 'generation', 'reason']) ||
      !isPermission(value.accessibility) || !isPermission(value.inputMonitoring) || typeof value.enabled !== 'boolean' ||
      !isHotkeyBinding(value.binding) || !isGeneration(value.generation) || !isReason(value.reason) ||
      (value.enabled && (value.generation === 0 || value.accessibility === 'denied'))) throw new Error('INVALID_INPUT_STATUS');
  return value as unknown as NativeInputStatus;
}
export function parseHotkeyEvent(value: unknown): NativeHotkeyEvent {
  if (!exactObject(value, ['v', 'event', 'instanceId', 'sequence', 'generation', 'phase', 'targetId', 'reason']) ||
      value.v !== 1 || value.event !== 'hotkey' || !isToken(value.instanceId) || !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1 || !isGeneration(value.generation) || value.generation < 1 ||
      !['pressed', 'released', 'activated'].includes(value.phase as string) || (value.targetId !== null && !isToken(value.targetId)) ||
      !isReason(value.reason) || (value.phase !== 'activated' && (value.targetId !== null || value.reason !== null)) ||
      (value.phase === 'activated' && (value.targetId === null) === (value.reason === null))) throw new Error('INVALID_HOTKEY_EVENT');
  return value as unknown as NativeHotkeyEvent;
}
export function parseTarget(value: unknown): NativeTarget {
  if (!exactObject(value, ['targetId', 'applicationName']) || !isToken(value.targetId) ||
      typeof value.applicationName !== 'string' || value.applicationName.length > 128) throw new Error('INVALID_TARGET');
  return value as unknown as NativeTarget;
}
export function parseInsertion(value: unknown): NativeInsertion {
  if (!(exactObject(value, ['outcome', 'reason']) || exactObject(value, ['outcome', 'reason', 'warning'])) ||
      (Object.hasOwn(value, 'warning') && value.warning !== 'PASTEBOARD_RESTORE_FAILED') ||
      !['inserted', 'submitted', 'notInserted', 'partialOrUnknown'].includes(value.outcome as string) ||
      !isReason(value.reason) || (['inserted', 'submitted'].includes(value.outcome as string) && value.reason !== null)) throw new Error('INVALID_INSERTION_RESULT');
  return value as unknown as NativeInsertion;
}

export function parseConfigureInput(value: unknown): ConfigureInput {
  if (!exactObject(value, ['enabled', 'binding', 'generation', 'excludedPids']) || typeof value.enabled !== 'boolean' ||
      !isHotkeyBinding(value.binding) || !isGeneration(value.generation) || value.generation < 1 ||
      !Array.isArray(value.excludedPids) || value.excludedPids.length < 1 || value.excludedPids.length > 64 ||
      !value.excludedPids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647)) throw new Error('INVALID_ARGUMENTS');
  return value as unknown as ConfigureInput;
}
