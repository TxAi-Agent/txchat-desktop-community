import { createShortcutBinding, shortcutDisplayName, capturedShortcutKeyLabel, type ShortcutDisplayLabel, type HotkeyBinding, type ShortcutPlatform } from './shortcut-bindings';
import { exactObject } from './native-protocol';
import { isToken } from './native-input';
export type ShortcutEditorPhase = 'current' | 'waiting' | 'captured' | 'conflict' | 'unavailable' | 'unsupported' | 'saveFailed';
export interface ShortcutEditorSnapshot {
  sessionId: string; phase: ShortcutEditorPhase; current: HotkeyBinding; candidate: HotkeyBinding | null;
  currentLabel?: ShortcutDisplayLabel; candidateLabel?: ShortcutDisplayLabel;
  display: string | null; error: string | null; busy: boolean; captureId: string | null;
}
export interface ShortcutKeyInput {
  type: string; code: string; key?: string; isAutoRepeat: boolean; control: boolean; alt: boolean; shift: boolean; meta: boolean; modifiers?: string[];
}
export interface ShortcutCandidate { phase: 'captured' | 'unavailable' | 'unsupported'; candidate: HotkeyBinding | null; candidateLabel?: ShortcutDisplayLabel; display: string; error: string | null }
export function shortcutFromKey(input: ShortcutKeyInput, platform: ShortcutPlatform, physicalCount = 0): ShortcutCandidate | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null;
  if (input.code === 'Fn') {
    if (input.control || input.alt || input.shift || input.meta) return { phase: 'unavailable', candidate: null, display: 'Fn', error: 'FN_COMBINATION' };
    return platform === 'darwin' ? { phase: 'captured', candidate: 'fn', display: 'Fn', error: null } : { phase: 'unsupported', candidate: null, display: 'Fn', error: 'UNSUPPORTED_BINDING' };
  }
  if (input.code === 'AltRight' && platform === 'darwin') return { phase: 'unsupported', candidate: null, display: 'Right Opt', error: 'UNSUPPORTED_BINDING' };
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(input.code)) return null;
  const modifiers = [input.control && 'ctrl', input.alt && 'alt', input.shift && 'shift', input.meta && 'meta'].filter((v): v is string => !!v);
  const name = capturedShortcutKeyLabel(input.code, input.key) || '—';
  const generic = createShortcutBinding(input.code, modifiers);
  const names: Record<string, string> = { ctrl: 'Ctrl', alt: platform === 'darwin' ? 'Opt' : 'Alt', shift: 'Shift', meta: platform === 'darwin' ? 'Cmd' : 'Win' };
  const display = generic ? shortcutDisplayName(generic, platform, { binding: generic, key: name }) : [...modifiers.map((m) => names[m]), name].join(' + ');
  const windowsDefault = platform === 'win32' && input.code === 'F8';
  const invalid = input.modifiers?.includes('fn') ? 'FN_COMBINATION' : physicalCount > 3 || modifiers.length > 2 ? 'TOO_MANY_KEYS' : modifiers.length === 0 && !windowsDefault ? 'BARE_KEY' : modifiers.length === 1 && modifiers[0] === 'shift' ? 'SHIFT_ONLY' : null;
  if (invalid) return { phase: 'unavailable', candidate: null, display, error: invalid };
  const candidate = createShortcutBinding(input.code, modifiers, platform);
  return candidate ? { phase: 'captured', candidate, candidateLabel: { binding: candidate, key: name }, display, error: null } : { phase: 'unsupported', candidate: null, display, error: 'UNSUPPORTED_BINDING' };
}
export interface NativeShortcutCaptureEvent {
  v: 1; event: 'shortcutCapture'; instanceId: string; sequence: number; captureId: string;
  key: 'fn' | 'right-option' | 'fn-combination' | 'unavailable';
}
export function parseShortcutCaptureEvent(value: unknown): NativeShortcutCaptureEvent {
  if (!exactObject(value, ['v', 'event', 'instanceId', 'sequence', 'captureId', 'key']) || value.v !== 1 || value.event !== 'shortcutCapture' ||
    !isToken(value.instanceId) || !isToken(value.captureId) || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 ||
    !['fn', 'right-option', 'fn-combination', 'unavailable'].includes(value.key as string)) throw new Error('INVALID_CAPTURE_EVENT');
  return value as unknown as NativeShortcutCaptureEvent;
}
