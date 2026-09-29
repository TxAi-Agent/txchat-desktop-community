import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Command } from '../../shared/contracts';
import { Brand } from './ui';
import { FittedText } from './FittedText';
import './product.css';
import './result-fallback.css';
export function ResultFallback({ snapshot, command, initiallyCopied = false }: {
    snapshot: AppSnapshot | null;
    command: (command: Command) => Promise<void>;
    initiallyCopied?: boolean;
}) {
    const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(initiallyCopied);
    const close = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)'), change = () => setDark(media.matches);
        media.addEventListener('change', change);
        return () => media.removeEventListener('change', change);
    }, []);
    useEffect(() => { if (!busy && close.current) {
        close.current.setAttribute('data-auto-focus', '');
        close.current.focus();
    } }, [snapshot?.dictation.generation, snapshot?.dictation.phase, busy]);
    if (!snapshot || snapshot.dictation.phase !== 'resultFallback')
        return null;
    const preferences = snapshot.product.preferences;
    const english = preferences.language === 'en';
    const run = async (type: 'dismiss' | 'result-copy') => {
        if (busy)
            return;
        setBusy(true);
        try {
            await command({ type });
            if (type === 'result-copy')
                setCopied(true);
        }
        catch { }
        finally {
            setBusy(false);
        }
    };
    return <main className={`tx-product tx-fallback-window ${(preferences.theme === 'dark' || preferences.theme === 'system' && dark) ? 'tx-dark' : 'tx-light'}`} lang={english ? 'en' : 'zh-CN'}>
    <section role="dialog" aria-labelledby="fallback-title" className="tx-fallback">
      <div className="tx-fallback-brand"><Brand symbol/></div>
      <h1 id="fallback-title"><FittedText size={23} minimumScale={.8}>{english ? 'Your text is still here' : '文字还在，你可以重新写入。'}</FittedText></h1>
      <div className="tx-fallback-text" tabIndex={0} aria-label={english ? 'Recognized text' : '识别结果'}>{snapshot.dictation.resultText}</div>
      <button ref={close} className="tx-fallback-close" disabled={busy} onBlur={(event) => event.currentTarget.removeAttribute('data-auto-focus')} onClick={() => void run('dismiss')}>{english ? 'Close' : '关闭'}</button>
      <button className="tx-primary tx-fallback-copy" disabled={busy} onClick={() => void run('result-copy')}>{copied ? english ? 'Copied & Closed' : '已复制并关闭' : english ? 'Copy & Close' : '复制并关闭'}</button>
    </section>
  </main>;
}
