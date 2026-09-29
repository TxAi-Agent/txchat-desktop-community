import { contextBridge, ipcRenderer } from 'electron';
import { parseCustomDraftRequest, parseCustomDraftRead } from '../shared/custom-ai-editor';
import { CHANNELS, type AppSnapshot, type Command, type DesktopAPI } from '../shared/contracts';

const api: DesktopAPI = {
  onCustomDraftInvalidated(callback) {
    const listener = () => callback();
    ipcRenderer.on(CHANNELS.customDraftInvalidated, listener);
    return () => { ipcRenderer.removeListener(CHANNELS.customDraftInvalidated, listener); };
  },
  read: () => ipcRenderer.invoke(CHANNELS.read),
  async readCustomDraft(category, providerId) {
    try {
      const request = parseCustomDraftRequest({ category, providerId });
      return parseCustomDraftRead(await ipcRenderer.invoke(CHANNELS.readCustomDraft, request), request);
    } catch { throw new Error('CUSTOM_AI_DRAFT_READ_FAILED'); }
  },
  command: (command: Command) => ipcRenderer.invoke(CHANNELS.command, command),
  subscribe(callback) {
    const listener = (_event: unknown, snapshot: AppSnapshot) => callback(snapshot);
    ipcRenderer.on(CHANNELS.snapshot, listener);
    return () => { ipcRenderer.removeListener(CHANNELS.snapshot, listener); };
  },
};
contextBridge.exposeInMainWorld('txchat', api);
