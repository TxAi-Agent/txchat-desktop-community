import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { AppSnapshot, Command, DesktopAPI } from '../shared/contracts';
import { ProductApp } from './product/ProductApp';
import './shell.css';
import { HUD } from './HUD';
import { MenuPanel } from './product/MenuPanel';
import { ResultFallback } from './product/ResultFallback';
import { DiagnosticWindow } from './product/DiagnosticWindow';
import { UpdateWindow } from './product/UpdateWindow';
declare global {
    interface Window {
        txchat: DesktopAPI;
    }
}
export function App() {
    const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
    const [error, setError] = useState(false);
    useEffect(() => {
        let active = true;
        const receive = (next: AppSnapshot) => { if (active)
            setSnapshot((old) => !old || next.sequence >= old.sequence ? next : old); };
        const unsubscribe = window.txchat.subscribe(receive);
        void window.txchat.read().then(receive).catch(() => { if (active)
            setError(true); });
        return () => { active = false; unsubscribe(); };
    }, []);
    const command = useCallback((command: Command) => window.txchat.command(command), []);
    if (window.location.hash === '#hud')
        return <HUD snapshot={snapshot} command={command}/>;
    if (window.location.hash === '#menu')
        return <MenuPanel snapshot={snapshot} command={command}/>;
    if (window.location.hash === '#result')
        return <ResultFallback snapshot={snapshot} command={command}/>;
    if (window.location.hash === '#diagnostics')
        return <DiagnosticWindow snapshot={snapshot} command={command}/>;
    if (window.location.hash === '#update')
        return <UpdateWindow snapshot={snapshot} command={command}/>;
    if (!snapshot)
        return <div className="tx-loading">{error ? '启动未完成，请重新打开 TxChat。 / Please reopen TxChat.' : '正在准备 TxChat…'}</div>;
    return <ProductApp snapshot={snapshot} command={command}/>;
}
export function Root() {
    const hash = useSyncExternalStore((changed) => { window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, () => window.location.hash, () => window.location.hash);
    return <App key={hash}/>;
}
