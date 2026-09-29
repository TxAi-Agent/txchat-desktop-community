/** Persisted physical-key shortcuts. Preset aliases are accepted alongside physical-key bindings. */
export const BINDINGS = ['fn', 'ctrl-alt-space', 'ctrl-shift-space'] as const;
export type HotkeyBinding = typeof BINDINGS[number] | `key:${string}:${string}`;
export const SHORTCUT_MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
export type ShortcutModifier = typeof SHORTCUT_MODIFIERS[number];
export type ShortcutPlatform = 'darwin' | 'win32';
export interface ShortcutDisplayLabel { binding: HotkeyBinding; key: string }
export const PHYSICAL_KEYS = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((key) => `Key${key}`),
  ...'0123456789'.split('').map((key) => `Digit${key}`),
  ...Array.from({ length: 20 }, (_, index) => `F${index + 1}`),
  'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'IntlBackslash',
  ...'0123456789'.split('').map((key) => `Numpad${key}`),
  'NumpadDecimal', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadEqual', 'NumpadEnter',
  'Insert', 'PrintScreen', 'ScrollLock', 'Pause', 'Clear', 'Help',
] as const;
const keys = new Set<string>(PHYSICAL_KEYS);
export type ParsedShortcut = { kind: 'fn'; modifiers: readonly []; code: 'Fn' } |
  { kind: 'standard'; modifiers: readonly ShortcutModifier[]; code: string };

export function parseShortcutBinding(value: unknown, platform?: ShortcutPlatform): ParsedShortcut | null {
  if (value === 'fn') return platform === 'win32' ? null : { kind: 'fn', modifiers: [], code: 'Fn' };
  // Windows has one bare default; ordinary bare keys remain invalid.
  if (value === 'key::F8') return platform === 'darwin' ? null : { kind: 'standard', modifiers: [], code: 'F8' };
  if (value === 'ctrl-alt-space') return { kind: 'standard', modifiers: ['ctrl', 'alt'], code: 'Space' };
  if (value === 'ctrl-shift-space') return { kind: 'standard', modifiers: ['ctrl', 'shift'], code: 'Space' };
  if (typeof value !== 'string' || value.length > 80) return null;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'key' || !keys.has(parts[2])) return null;
  const modifiers = parts[1].split('+');
  if (modifiers.length < 1 || modifiers.length > 2 || new Set(modifiers).size !== modifiers.length ||
      modifiers.some((modifier) => !SHORTCUT_MODIFIERS.includes(modifier as ShortcutModifier)) ||
      (modifiers.length === 1 && modifiers[0] === 'shift') ||
      SHORTCUT_MODIFIERS.filter((modifier) => modifiers.includes(modifier)).join('+') !== parts[1]) return null;
  if (platform === 'darwin' && ['Insert', 'PrintScreen', 'ScrollLock', 'Pause'].includes(parts[2])) return null;
  // Win32 RegisterHotKey cannot distinguish main Enter from keypad Enter.
  if (platform === 'win32' && ['NumpadEnter', 'NumpadEqual', 'Clear', 'Help'].includes(parts[2])) return null;
  return { kind: 'standard', modifiers: modifiers as ShortcutModifier[], code: parts[2] };
}
export function isHotkeyBinding(value: unknown): value is HotkeyBinding { return parseShortcutBinding(value) !== null; }
export function createShortcutBinding(code: string, modifiers: readonly string[], platform?: ShortcutPlatform): HotkeyBinding | null {
  if (new Set(modifiers).size !== modifiers.length || modifiers.some((modifier) => !SHORTCUT_MODIFIERS.includes(modifier as ShortcutModifier))) return null;
  const value = `key:${SHORTCUT_MODIFIERS.filter((modifier) => modifiers.includes(modifier)).join('+')}:${code}` as const;
  return parseShortcutBinding(value, platform) ? value : null;
}
export function shortcutDisplayName(value: unknown, platform: ShortcutPlatform = 'darwin', label?: ShortcutDisplayLabel): string {
  const shortcut = parseShortcutBinding(value);
  if (!shortcut) return '—';
  if (shortcut.kind === 'fn') return 'Fn';
  const names = { ctrl: 'Ctrl', alt: platform === 'darwin' ? 'Opt' : 'Alt', shift: 'Shift', meta: platform === 'darwin' ? 'Cmd' : 'Win' };
  const key = label?.binding === value && isShortcutDisplayLabel(label) ? label.key : shortcutKeyDisplayName(shortcut.code);
  return [...shortcut.modifiers.map((modifier) => names[modifier]), key].join(' + ');
}

export function shortcutKeyDisplayName(code: string): string {
  const keyNames: Record<string, string> = {
    Enter: 'Return', Backspace: 'Del', Escape: 'Esc', Delete: 'Fwd Del', PageUp: 'PgUp', PageDown: 'PgDn',
    ArrowLeft: 'Left Arrow', ArrowRight: 'Right Arrow', ArrowUp: 'Up Arrow', ArrowDown: 'Down Arrow', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
    Comma: ',', Period: '.', Slash: '/', IntlBackslash: 'Intl \\', NumpadEnter: 'Enter',
  };
  return keyNames[code] ?? code.replace(/^Key|^Digit/, '').replace(/^Numpad/, 'Num ');
}

const fixedDisplayCodes = new Set(['Fn', 'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'NumpadEnter', 'Insert', 'PrintScreen', 'ScrollLock', 'Pause', 'Clear', 'Help',
  ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`)]);
/** Only a printable keyboard key, never a transcript, markup fragment or control sequence. */
export function printableKeyLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8 || /[\p{C}]/u.test(value)) return null;
  const normalized = value.normalize('NFC').trim().toUpperCase();
  return normalized.length > 0 && normalized.length <= 4 && [...normalized].length <= 2 && !/[\p{C}\p{Z}]/u.test(normalized) ? normalized : null;
}
export function shortcutNeedsLayoutLabel(code: string): boolean { return keys.has(code) && !fixedDisplayCodes.has(code); }
export function capturedShortcutKeyLabel(code: string, key: unknown): string {
  // Named keys are authoritative by physical position, including display abbreviations.
  return fixedDisplayCodes.has(code) ? shortcutKeyDisplayName(code) : printableKeyLabel(key) ?? shortcutKeyDisplayName(code);
}
export function isShortcutDisplayLabel(value: unknown): value is ShortcutDisplayLabel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const label = value as Record<string, unknown>;
  if (Object.keys(label).sort().join(',') !== 'binding,key' || typeof label.key !== 'string' || label.key.length > 24) return false;
  const binding = parseShortcutBinding(label.binding);
  if (!binding) return false;
  const fallback = shortcutKeyDisplayName(binding.code);
  return fixedDisplayCodes.has(binding.code) ? label.key === fallback : label.key === fallback || printableKeyLabel(label.key) === label.key;
}
