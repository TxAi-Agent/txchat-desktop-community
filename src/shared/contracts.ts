import type { DictationFailureCode } from './dictation-failure';
import type { HotkeyBinding, InputSnapshot } from './native-input';
import type { AudioSnapshot, AudioSource, FixtureScenario } from './native-audio';
import type { CustomDraftRead } from './custom-ai-editor';
import type { CustomCategory } from './product';
import type { ProductCommand, ProductSnapshot } from './product';
export const SCENARIOS = ['success', 'service-failure', 'insertion-rejected', 'insertion-unknown'] as const;
export type Scenario = typeof SCENARIOS[number];
export type Phase = 'idle' | 'starting' | 'listening' | 'finalizing' | 'organizing' | 'inserting' |
  'completed' | 'resultFallback' | 'failed' | 'unavailable';
export interface DictationSnapshot {
  revision: number;
  phase: Phase;
  generation: number;
  sessionId: string | null;
  partialText: string;
  resultText: string;
  notice: string | null;
  scenario: Scenario;
  canStart: boolean;
  canStop: boolean;
  canCancel: boolean;
  cancelled: boolean;
  usedVerbatimFallback: boolean;
  completion?: 'no-speech' | null;
  failure?: DictationFailureCode | null;
}
export type Command = ProductCommand | { type: 'start' | 'stop' | 'cancel' | 'dismiss' | 'restart-helper' | 'app-open' | 'app-quit' | 'menu-close' } |
  { type: 'scenario'; value: Scenario } |
  { type: 'native-enable'; binding: HotkeyBinding } | { type: 'native-disable' | 'native-status' | 'native-permissions' | 'native-accessibility-permission' } |
  { type: 'audio-source'; value: AudioSource } | { type: 'fixture-scenario'; value: FixtureScenario } |
  { type: 'audio-status' | 'audio-permission' };
export interface HelperSnapshot {
  status: 'starting' | 'ready' | 'unavailable' | 'stopped';
  platform: string | null;
  arch: string | null;
  version: string | null;
  reason: string | null;
}
export interface AppSnapshot {
  sequence: number;
  platform?: 'darwin' | 'win32';
  dictation: DictationSnapshot;
  helper: HelperSnapshot;
  mode: 'simulation' | 'native';
  input: InputSnapshot;
  audio: AudioSnapshot;
  product: ProductSnapshot;
}
export interface DesktopAPI {
  onCustomDraftInvalidated(callback: () => void): () => void;
  read(): Promise<AppSnapshot>;
  readCustomDraft(category: CustomCategory, providerId: string): Promise<CustomDraftRead>;
  command(command: Command): Promise<void>;
  subscribe(callback: (snapshot: AppSnapshot) => void): () => void;
}
export const CHANNELS = { read: 'txchat:read', command: 'txchat:command', snapshot: 'txchat:snapshot', readCustomDraft: 'txchat:custom-draft-read', customDraftInvalidated: 'txchat:custom-draft-invalidated' } as const;

export type { DictionaryEntry } from './product';
