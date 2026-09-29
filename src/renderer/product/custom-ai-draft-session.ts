export interface CustomAIDraftSessionStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export const CUSTOM_AI_DRAFT_ENABLED_KEY = 'txchat.custom-ai.draft-enabled';
export function readCustomAIDraftEnabled(storage: CustomAIDraftSessionStorage | null, savedEnabled: boolean) {
    if (!storage)
        return savedEnabled;
    try {
        const value = storage.getItem(CUSTOM_AI_DRAFT_ENABLED_KEY);
        if (value === '1')
            return true;
        if (value === '0')
            return false;
    }
    catch { }
    return savedEnabled;
}
export function writeCustomAIDraftEnabled(storage: CustomAIDraftSessionStorage | null, enabled: boolean) {
    if (!storage)
        return;
    try {
        storage.setItem(CUSTOM_AI_DRAFT_ENABLED_KEY, enabled ? '1' : '0');
    }
    catch { }
}
export function clearCustomAIDraftEnabled(storage: CustomAIDraftSessionStorage | null) {
    if (!storage)
        return;
    try {
        storage.removeItem(CUSTOM_AI_DRAFT_ENABLED_KEY);
    }
    catch { }
}
