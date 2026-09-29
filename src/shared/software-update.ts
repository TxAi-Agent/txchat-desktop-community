export type SoftwareUpdatePhase = 'idle' | 'checking' | 'current' | 'unavailable' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed';
export type SoftwareUpdateFailure = 'configuration' | 'metadata' | 'signature' | 'download' | 'installation' | 'restart-required' | 'storage' | 'unavailable';
export interface SoftwareUpdateItem {
  version: string;
  releaseNotes: string[];
  size: number | null;
  required: boolean;
  minimumSupportedVersion: string;
}
/** Public IPC data only: never includes feed URLs, download paths, raw errors or credentials. */
export interface SoftwareUpdateSnapshot {
  phase: SoftwareUpdatePhase;
  version: string;
  item: SoftwareUpdateItem | null;
  downloadedBytes: number;
  totalBytes: number;
  progress: number;
  failure: SoftwareUpdateFailure | null;
  pendingAction: 'install' | 'quit' | null;
  blocksNewDictation: boolean;
  visible: boolean;
}
export type SoftwareUpdateAction = 'update-check' | 'update-download' | 'update-skip' | 'update-cancel' | 'update-retry' |
  'update-install' | 'update-later' | 'update-quit' | 'update-close';
export const SOFTWARE_UPDATE_ACTIONS: readonly SoftwareUpdateAction[] = ['update-check', 'update-download', 'update-skip', 'update-cancel',
  'update-retry', 'update-install', 'update-later', 'update-quit', 'update-close'];
