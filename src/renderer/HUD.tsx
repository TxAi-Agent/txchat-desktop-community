import { shortcutDisplayName } from '../shared/shortcut-bindings';
import { useEffect, useState, type CSSProperties } from 'react';
import type { AppSnapshot, Command } from '../shared/contracts';
import { hudPresentation, hudWaveform } from '../domain/hud';
import './hud.css';
export function HUD({ snapshot, command }: {
    snapshot: AppSnapshot | null;
    command: (command: Command) => Promise<void>;
}) {
    const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const changed = () => setReducedMotion(media.matches);
        media.addEventListener('change', changed);
        return () => media.removeEventListener('change', changed);
    }, []);
    if (!snapshot)
        return null;
    const p = hudPresentation(snapshot.dictation, snapshot.product.preferences.language, shortcutDisplayName(snapshot.product.preferences.shortcut, snapshot.helper.platform === 'win32' ? 'win32' : 'darwin', snapshot.product.preferences.shortcutLabel));
    return <HUDView presentation={p} level={snapshot.audio.progress.level} reducedMotion={reducedMotion} command={command}/>;
}
export function HUDView({ presentation: p, level, reducedMotion, command, action }: {
    presentation: ReturnType<typeof hudPresentation>;
    level: number;
    reducedMotion: boolean;
    command: (command: Command) => Promise<void>;
    action?: {
        label: string;
        run: () => void;
    };
}) {
    const wave = hudWaveform(p.visual, level, reducedMotion, p.canCancel);
    const terminal = ['completed', 'failed', 'unavailable', 'no-speech'].includes(p.visual);
    return <div className={`tx-hud tx-hud-${p.visual}${action ? ' tx-hud-has-action' : ''}`} data-reduced-motion={reducedMotion ? 'true' : 'false'} style={{ '--hud-status': p.color } as CSSProperties} role="status" aria-live="polite">
    <span className="tx-hud-logo" aria-hidden="true"/>
    <span className="tx-hud-dot" aria-hidden="true"/>
    <div className="tx-hud-copy"><strong>{p.title}</strong><small title={p.detail}>{p.detail}</small></div>
    {action ? <button className="tx-hud-action" onClick={action.run}>{action.label}</button>
            : terminal ? <span className="tx-hud-badge" aria-hidden="true">{p.visual === 'completed'
                    ? <svg viewBox="0 0 12 12"><path d="m2 6 2.5 2.5L10 3"/></svg> : <i />}</span>
                : p.visual !== 'cancelled' && <div className={`tx-hud-wave ${p.canCancel ? 'tx-hud-wave-compact' : ''}`} style={{ opacity: wave.opacity }} aria-hidden="true">
        {wave.heights.map((height, i) => <i key={i} style={{ height }}/>)}
      </div>}
    {p.canCancel && <button className="tx-hud-cancel" aria-label={p.cancelLabel} onClick={() => void command({ type: 'cancel' }).catch(() => undefined)}><span>×</span></button>}
  </div>;
}
