import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Command } from '../../shared/contracts';
import { diagnosticPresentation } from '../../domain/diagnostic-presentation';
import './product.css';
import './diagnostics.css';
export function DiagnosticWindow({ snapshot, command }: {
    snapshot: AppSnapshot | null;
    command: (command: Command) => Promise<void>;
}) {
    const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    const [busy, setBusy] = useState(false);
    const primary = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)'), change = () => setDark(media.matches);
        media.addEventListener('change', change);
        return () => media.removeEventListener('change', change);
    }, []);
    const state = snapshot?.product.diagnostics;
    useEffect(() => { if (!busy && state?.phase !== 'sending' && primary.current) {
        primary.current.setAttribute('data-auto-focus', '');
        primary.current.focus();
    } }, [state?.phase, state?.isAbnormalExit, busy]);
    if (!snapshot || !state)
        return null;
    const preferences = snapshot.product.preferences;
    const presentation = diagnosticPresentation(state, preferences.language, snapshot.platform ?? 'darwin');
    if (!presentation)
        return null;
    const configured = snapshot.product.environment.configured;
    const english = preferences.language === 'en';
    const view = configured ? presentation : {
        ...presentation,
        title: english ? 'Report service not configured' : '诊断报告服务尚未配置',
        body: english ? 'Connect your own diagnostic service adapter using the development documentation and rebuild before sending reports.' : '请按开发文档接入自有诊断服务适配器并重新构建，再发送报告。',
        caption: english ? 'No report is uploaded. You can dismiss this message and continue using local features.' : '不会上传诊断报告。你可以关闭此提示并继续使用本地功能。',
        hint: null,
        secondary: english ? 'Cancel' : '取消',
        primary: english ? 'Not configured' : '尚未配置',
        enabled: false,
        tone: 'primary'
    };
    const run = async (type: 'diagnostics-send' | 'diagnostics-retry' | 'diagnostics-discard' | 'diagnostics-done') => {
        if (busy)
            return;
        setBusy(true);
        try {
            await command({ type });
        }
        catch { }
        finally {
            setBusy(false);
        }
    };
    return <main className={`tx-product tx-diagnostic-window ${(preferences.theme === 'dark' || preferences.theme === 'system' && dark) ? 'tx-dark' : 'tx-light'}`} lang={preferences.language === 'zh' ? 'zh-CN' : 'en'}>
    <section className="tx-diagnostic" role="dialog" aria-labelledby="diagnostic-title" aria-describedby="diagnostic-body diagnostic-caption" data-state={state.phase === 'prompt' && state.isAbnormalExit ? 'abnormal-exit' : state.phase}>
      <h1 id="diagnostic-title" className={`is-${view.tone}`}>{configured && preferences.language === 'en' && state.phase === 'failed' ? <>Couldn<span className="tx-diagnostic-apostrophe">’</span>t send</> : view.title}</h1>
      <p id="diagnostic-body" className="tx-diagnostic-body">{view.body}</p>
      <p id="diagnostic-caption" className="tx-diagnostic-caption" aria-describedby={view.hint ? 'diagnostic-hint' : undefined}>{view.caption}</p>
      {view.hint && <span id="diagnostic-hint" className="tx-visually-hidden">{view.hint}</span>}
      <footer>{view.secondary && <button disabled={busy} onClick={() => void run('diagnostics-discard')}>{view.secondary}</button>}<button ref={primary} className={`tx-primary ${state.phase === 'sending' ? 'is-sending' : ''}`} disabled={busy || !view.enabled} onBlur={(event) => event.currentTarget.removeAttribute('data-auto-focus')} onClick={() => void run(view.action)}>{view.primary}</button></footer>
    </section>
  </main>;
}
