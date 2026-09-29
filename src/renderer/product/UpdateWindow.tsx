import { useEffect, useState } from 'react';
import type { AppSnapshot, Command } from '../../shared/contracts';
import { SoftwareUpdate } from './SoftwareUpdate';
import './product.css';
export function UpdateWindow({ snapshot, command }: {
    snapshot: AppSnapshot | null;
    command: (command: Command) => Promise<void>;
}) {
    const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)'), change = () => setDark(media.matches);
        media.addEventListener('change', change);
        return () => media.removeEventListener('change', change);
    }, []);
    if (!snapshot)
        return null;
    const preferences = snapshot.product.preferences;
    return <main className={`tx-product tx-update-window ${(preferences.theme === 'dark' || preferences.theme === 'system' && dark) ? 'tx-dark' : 'tx-light'}`} lang={preferences.language === 'zh' ? 'zh-CN' : 'en'}>
    <SoftwareUpdate state={snapshot.product.update} language={preferences.language} command={command}/>
  </main>;
}
