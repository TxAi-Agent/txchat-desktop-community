import { isHotkeyBinding } from '../shared/native-input';
import { SCENARIOS, type Command } from '../shared/contracts';
import { FIXTURE_SCENARIOS } from '../shared/native-audio';
import { parseProductCommand } from './product-policy';
import { SOFTWARE_UPDATE_ACTIONS, type SoftwareUpdateAction } from '../shared/software-update';

function validateCommand(input: unknown): Command {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_COMMAND');
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys === 'type' && ['start', 'stop', 'cancel', 'dismiss', 'restart-helper', 'native-disable', 'native-status', 'native-permissions', 'native-accessibility-permission', 'audio-status', 'audio-permission', 'app-open', 'app-quit', 'menu-close'].includes(record.type as string)) return record as Command;
  if (keys === 'type,value' && record.type === 'scenario' && SCENARIOS.includes(record.value as typeof SCENARIOS[number])) return record as Command;
  if (keys === 'binding,type' && record.type === 'native-enable' && isHotkeyBinding(record.binding)) return record as Command;
  if (keys === 'type,value' && record.type === 'audio-source' && ['synthetic', 'microphone-local'].includes(record.value as string)) return record as Command;
  if (keys === 'type,value' && record.type === 'fixture-scenario' && FIXTURE_SCENARIOS.includes(record.value as typeof FIXTURE_SCENARIOS[number])) return record as Command;
  return parseProductCommand(input);
}
export interface Sender { id: number; url: string; mainFrame: boolean }
export interface TrustedWindow { id: number; url: string; role: 'main' | 'hud' | 'menu' | 'update' | 'diagnostics' | 'result' }
export function authorizeSender(sender: Sender, trusted: TrustedWindow | undefined, action: string): boolean {
  return !!trusted && sender.id === trusted.id && sender.mainFrame && sender.url === trusted.url &&
    (trusted.role === 'main' || action === 'read' || trusted.role === 'hud' && ['cancel', 'stop'].includes(action) ||
      trusted.role === 'menu' && ['app-open', 'app-quit', 'menu-close'].includes(action) ||
      trusted.role === 'update' && SOFTWARE_UPDATE_ACTIONS.includes(action as SoftwareUpdateAction) ||
      trusted.role === 'result' && ['dismiss', 'result-copy'].includes(action) ||
      trusted.role === 'diagnostics' && ['diagnostics-send', 'diagnostics-retry', 'diagnostics-discard', 'diagnostics-done'].includes(action));
}

export function parseCommand(input: unknown): Command { return structuredClone(validateCommand(input)); }
