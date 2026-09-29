import { useEffect, useState } from 'react';
import type { AppSnapshot, Command } from '../../shared/contracts';
import { menuPresentation } from '../../domain/menu-panel';
import { Brand } from './ui';
import './product.css';
import './menu-panel.css';
export function MenuPanel({ snapshot, command }: {
    snapshot: AppSnapshot | null;
    command: (command: Command) => Promise<void>;
}) {
    const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)'), change = () => setSystemDark(media.matches);
        media.addEventListener('change', change);
        return () => media.removeEventListener('change', change);
    }, []);
    useEffect(() => {
        const close = (event: KeyboardEvent) => { if (event.key === 'Escape') {
            event.preventDefault();
            void command({ type: 'menu-close' }).catch(() => undefined);
        } };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [command]);
    if (!snapshot)
        return null;
    const view = menuPresentation(snapshot), preferences = snapshot.product.preferences;
    const dark = preferences.theme === 'dark' || preferences.theme === 'system' && systemDark;
    return <main className={`tx-product tx-menu-panel ${dark ? 'tx-dark' : 'tx-light'}`} lang={preferences.language === 'zh' ? 'zh-CN' : 'en'}>
    <div className="tx-menu-brand"><Brand symbol/></div>
    <div className="tx-menu-status" role="status"><h1><span className={`tx-menu-dot is-${view.kind}`}/>{view.title}</h1><p>{view.detail}</p></div>
    <div className="tx-menu-separator first" aria-hidden="true"/>
    <button className="tx-menu-action tx-menu-open" onClick={() => void command({ type: 'app-open' }).catch(() => undefined)}>{view.open}</button>
    <div className="tx-menu-separator second" aria-hidden="true"/>
    <button className="tx-menu-action tx-menu-quit" onClick={() => void command({ type: 'app-quit' }).catch(() => undefined)}>{view.quit}<span>{(snapshot.platform ?? snapshot.helper.platform) === 'darwin' ? '⌘Q' : 'Ctrl+Q'}</span></button>
  </main>;
}
