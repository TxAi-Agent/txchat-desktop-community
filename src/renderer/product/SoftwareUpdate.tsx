import type { SoftwareUpdateSnapshot } from '../../shared/software-update';
import { softwareUpdatePresentation } from '../../domain/software-update-presentation';
import { Brand, Modal, type Dispatch } from './ui';
import './software-update.css';
export function SoftwareUpdate({ state, language, command }: {
    state: SoftwareUpdateSnapshot;
    language: 'zh' | 'en';
    command: Dispatch;
}) {
    const send = (type: Parameters<Dispatch>[0]['type']) => void command({ type } as Parameters<Dispatch>[0]).catch(() => undefined);
    if (!state.item) return <Modal variant="update" title={language === 'zh' ? '软件更新' : 'Software Update'} onClose={() => send('update-close')} footer={<button className="tx-primary" onClick={() => send('update-close')}>{language === 'zh' ? '关闭' : 'Close'}</button>}><Brand symbol /><p role="status">{state.phase === 'checking' ? language === 'zh' ? '正在检查更新…' : 'Checking for updates…' : state.phase === 'current' ? language === 'zh' ? '已是最新版本。' : 'The app is up to date.' : language === 'zh' ? '更新服务尚未配置或当前不可用。请按开发文档接入自有更新服务后重新构建。' : 'The update service is not configured or is unavailable. Connect your update service using the development documentation and rebuild.'}</p></Modal>;
    const view = softwareUpdatePresentation(state, language);
    return <Modal variant="update" title={view.heading} onClose={() => send('update-close')} footer={<>
    {view.secondary && <button disabled={!!state.pendingAction} onClick={() => send(view.secondaryAction)}>{view.secondary}</button>}
    <button className={`tx-primary ${view.primaryAction === 'update-install' ? 'tx-update-restart' : ''}`} disabled={!view.enabled} onClick={() => send(view.primaryAction)}>{view.primary}</button>
  </>}>
    <div className="tx-update-traffic" aria-hidden="true"><i /><i /><i /></div><div className="tx-update-brand"><Brand symbol/></div>
    <p className="tx-update-version">{view.versionLine}</p>
    <div className={`tx-update-card ${view.danger ? 'is-danger' : ''}`} role="status">
      <h3>{view.section}</h3>
      {view.progress !== null ? <><div className="tx-update-download"><span>{view.lines[0]}</span><span>{Math.round(view.progress * 100)}%</span></div><div className="tx-update-progress" role="progressbar" aria-label={view.section} aria-valuenow={Math.round(view.progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(view.progress * 100)}%` }}/></div></> :
            view.caption ? <><p className="tx-update-description">{view.lines[0]}</p><p className="tx-update-caption">{view.caption}</p></> : <div className="tx-update-notes">{view.lines.map((line, index) => <p key={index}>{line}</p>)}</div>}
    </div>
  </Modal>;
}
