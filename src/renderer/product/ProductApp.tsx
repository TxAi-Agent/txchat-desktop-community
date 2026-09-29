import { SessionRestore } from './SessionRestore';
import { WindowsSetupDialog, WindowsSetupRows, windowsSetupText } from './WindowsSetup';
import { Login } from './Login';
import { SessionInterruption } from './SessionInterruption';
import { TextReader } from './TextReader';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, Command, Phase } from '../../shared/contracts';
import { ShortcutEditor } from './ShortcutEditor';
import type { ProductPage } from '../../shared/product';
import { CustomAI } from './CustomAI';
import { Dictionary } from './Dictionary';
import { Onboarding } from './Onboarding';
import { BillingUsage } from './BillingUsage';
import { Membership } from './Membership';
import { Payment } from './Payment';
import { SetupUnavailable } from './SetupUnavailable';
import { PermissionRepair } from './PermissionRepair';
import { Brand, Icon, Modal, Notice, errorText, shortcutName, translate, type Dispatch, type Translate } from './ui';
import './product.css';
import './home.css';
type Dialog = 'permissions' | 'voice' | 'logout' | null;
const ACTIVE_PHASES: Phase[] = ['starting', 'listening', 'finalizing', 'organizing', 'inserting'];
const isMicrophoneReady = (snapshot: AppSnapshot) => snapshot.audio.status?.permission === 'granted' || snapshot.audio.status?.permission === 'systemManaged';
const isInputReady = (snapshot: AppSnapshot) => snapshot.input.status?.accessibility === 'granted' || snapshot.input.status?.accessibility === 'notRequired';
export function ProductApp({ snapshot, command }: {
    snapshot: AppSnapshot;
    command: (command: Command) => Promise<void>;
}) {
    const product = snapshot.product;
    const t = translate(product.preferences.language);
    const [modal, setModal] = useState<Dialog>(null);
    const [showSetupLogin, setShowSetupLogin] = useState(false);
    const [loginPhone, setLoginPhone] = useState('');
    const [loginTermsAccepted, setLoginTermsAccepted] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [permissionCheck, setPermissionCheck] = useState<'unchecked' | 'checking' | 'checked'>('unchecked');
    const permissionEpoch = useRef(0);
    const [localError, setLocalError] = useState('');
    const [dismissedNotice, setDismissedNotice] = useState('');
    const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
    const leaveGuard = useRef<((leave: () => void) => void) | null>(null);
    const registerLeave = useCallback((guard: ((leave: () => void) => void) | null) => { leaveGuard.current = guard; }, []);
    const active = ACTIVE_PHASES.includes(snapshot.dictation.phase) || snapshot.dictation.phase === 'resultFallback' || product.voiceTest;
    const settingsDisabled = !!product.shortcutEditor || active || snapshot.input.busy || snapshot.audio.busy;
    const dispatch: Dispatch = useCallback(async (value) => {
        setLocalError('');
        setDismissedNotice('');
        try {
            await command(value);
        }
        catch {
            setLocalError('ACTION_FAILED');
            throw new Error('ACTION_FAILED');
        }
        finally {
            setDismissedNotice('');
        }
    }, [command]);
    const run = (value: Parameters<Dispatch>[0]) => { void dispatch(value).catch(() => undefined); };
    const guarded = (action: () => void) => leaveGuard.current ? leaveGuard.current(action) : action();
    const navigate = (page: ProductPage) => guarded(() => { setModal(null); run({ type: 'product-page', page }); });
    useEffect(() => { const media = window.matchMedia('(prefers-color-scheme: dark)'); const listener = () => setSystemDark(media.matches); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener); }, []);
    useEffect(() => { setModal(null); setLocalError(''); }, [product.stage]);
    useEffect(() => { setDismissedNotice(''); }, [product.stage, snapshot.dictation.generation, product.notice, product.storageError?.code]);
    const dark = product.preferences.theme === 'dark' || product.preferences.theme === 'system' && systemDark;
    const refreshPermissions = async (proveMicrophoneAccess = false) => {
        const epoch = ++permissionEpoch.current;
        setPermissionCheck('checking');
        try {
            await dispatch({ type: proveMicrophoneAccess && snapshot.helper.platform === 'win32' ? 'audio-permission' : 'audio-status' });
            await dispatch({ type: 'native-status' });
            if (epoch === permissionEpoch.current)
                setPermissionCheck('checked');
        }
        catch {
            if (epoch === permissionEpoch.current)
                setPermissionCheck('unchecked');
        }
    };
    const openPermissions = () => { setPermissionCheck('unchecked'); setModal('permissions'); if (snapshot.helper.status === 'ready')
        void refreshPermissions(); };
    const reconnectHelper = async () => {
        if (reconnecting || settingsDisabled || snapshot.helper.status === 'starting')
            return;
        setReconnecting(true);
        try {
            await dispatch({ type: 'restart-helper' });
        }
        catch { }
        finally {
            setReconnecting(false);
            setPermissionCheck('unchecked');
        }
    };
    useEffect(() => {
        if (modal !== 'permissions') {
            permissionEpoch.current++;
            setPermissionCheck('unchecked');
        }
    }, [modal]);
    useEffect(() => () => { permissionEpoch.current++; }, []);
    const localDemo = product.preferences.service === 'local' && product.auth.demo;
    const ready = isMicrophoneReady(snapshot) && isInputReady(snapshot) && snapshot.helper.status === 'ready' && snapshot.input.status?.enabled;
    const windowsSetup = snapshot.platform === 'win32' && !ready ? windowsSetupText(snapshot, t) : null;
    const headline = ready ? t('随时说 直接写', 'Speak to Write') : t('还差一步 就能开始', 'One Step to Go');
    useEffect(() => { if (modal === 'permissions' && permissionCheck === 'checked' && !snapshot.audio.busy && !snapshot.input.busy && ready)
        setModal(null); }, [modal, ready, permissionCheck, snapshot.audio.busy, snapshot.input.busy]);
    const closeVoice = () => { run({ type: 'voice-test-close' }); setModal(null); };
    const noticeCode = localError || product.storageError?.code || product.notice || '';
    const inputIssue = snapshot.input.error ?? snapshot.input.status?.reason;
    const onboardingMessage = noticeCode ? errorText(noticeCode, t) : product.auth.error ? errorText(product.auth.error, t) : snapshot.dictation.phase === 'failed' ? errorText(snapshot.dictation.failure ?? 'DICTATION_FAILED', t) : inputIssue === 'HOTKEY_CONFLICT'
        ? t('快捷键已被其他应用占用，请在该应用中释放快捷键后重试。', 'Another app is using this shortcut. Release it in that app, then try again.')
        : errorText(inputIssue, t);
    return <main className={`tx-product ${dark ? 'tx-dark' : 'tx-light'}`} lang={product.preferences.language === 'zh' ? 'zh-CN' : 'en'}>
    <div className="tx-titlebar" aria-hidden="true"/>
    {(product.stage === 'setup-unavailable' || product.stage === 'signed-out' || product.stage === 'ready' && product.page === 'status') && <div className="tx-window-options"><button className="tx-language" onClick={() => guarded(() => run({ type: 'preferences', language: product.preferences.language === 'zh' ? 'en' : 'zh' }))}><Icon name="globe"/>{t('English', '中文')}</button></div>}
    {product.stage === 'launching' ? <div className="tx-launching"><Brand symbol/><p>{t('正在准备 TxChat…', 'Getting TxChat ready…')}</p></div> : product.stage === 'setup-unavailable' ? showSetupLogin ? <Login platform={snapshot.platform} product={product} command={dispatch} t={t} phone={loginPhone} setPhone={setLoginPhone} accepted={loginTermsAccepted} setAccepted={setLoginTermsAccepted} onBackToSetup={() => setShowSetupLogin(false)}/> : <SetupUnavailable t={t} enterLocal={() => run({ type: 'demo-enter' })} showLogin={() => setShowSetupLogin(true)}/> : product.stage === 'interrupted' ? <SessionInterruption product={product} command={dispatch} t={t}/> : product.stage === 'signed-out' && product.auth.restorePending ? <SessionRestore auth={product.auth} command={dispatch} t={t}/> : product.stage === 'signed-out' ? <Login platform={snapshot.platform} product={product} command={dispatch} t={t} phone={loginPhone} setPhone={setLoginPhone} accepted={loginTermsAccepted} setAccepted={setLoginTermsAccepted}/> : product.stage === 'onboarding' ? <Onboarding snapshot={snapshot} command={dispatch} t={t} message={onboardingMessage}/> : <>
      {product.page === 'status' && <section className="tx-home" aria-label={t('状态中心', 'Status')}>
        <div className="tx-home-brand"><Brand /></div><button className="tx-account" onClick={() => run({ type: 'auth-logout' })}>{product.auth.demo ? t('本地开发会话', 'Local development') : product.auth.maskedPhone ?? t('已登录', 'Signed in')}<Icon name="logout"/></button>
        <div className={`tx-home-status ${ready ? 'tx-success' : 'tx-error'}`}><span className="tx-status-dot"/>{ready && snapshot.dictation.phase !== 'unavailable' ? t('TxChat 已就绪', 'TxChat Ready') : t('TxChat 需要设置', 'TxChat Needs Setup')}</div>
        <h1 className="tx-home-headline">{headline}</h1><p className="tx-home-instruction">{windowsSetup ? t('检查连接和设备配置后即可开始。', 'Check the connection and device settings.') : ready ? t('在任意输入框按下快捷键开始说话', 'Press the shortcut in any text field to start speaking') : t('请完成以下授权设置，即可正常使用。', 'Please complete the following permissions to get started.')}</p>
        {ready ? <div className="tx-home-key"><span className="tx-keycap" aria-label={`${t('快捷键', 'Shortcut')} ${shortcutName(product.preferences.shortcut, snapshot.helper.platform === 'win32' ? 'win32' : 'darwin', product.preferences.shortcutLabel)}`}><span>{shortcutName(product.preferences.shortcut, snapshot.helper.platform === 'win32' ? 'win32' : 'darwin', product.preferences.shortcutLabel)}</span></span></div> : windowsSetup ? <WindowsSetupRows snapshot={snapshot} t={t} busy={settingsDisabled} open={openPermissions}/> : <><div className="tx-home-setup">
          {!isMicrophoneReady(snapshot) && <div className="tx-home-setup-row"><h3><span aria-hidden="true">ⓘ</span>{t('麦克风配置', 'Microphone Setup')}</h3><div><button className="tx-primary" disabled={settingsDisabled} onClick={openPermissions}>{t('授权麦克风', 'Allow Microphone')}</button><span>{t('麦克风权限用来收听语音', 'For voice recognition')}</span></div></div>}
          {(!isInputReady(snapshot) || !snapshot.input.status?.enabled) && <div className="tx-home-setup-row"><h3><span aria-hidden="true">ⓘ</span>{t('辅助功能配置', 'Accessibility Setup')}</h3><div><button className="tx-primary" disabled={settingsDisabled} onClick={openPermissions}>{t('授权辅助功能', 'Allow Accessibility')}</button><span>{t('辅助功能权限用来输入文字', 'For inserting recognized text')}</span></div></div>}
        </div><div className="tx-home-setup-footer"><div>{t('如果已配置可点击', 'If already configured, click')} <button className="tx-link" disabled={settingsDisabled} onClick={openPermissions}>{t('检查配置', 'Check Configuration')}</button></div><span>{t(' 获取最新配置信息。', ' for the latest status.')}</span></div></>}
        <div className="tx-home-menu"><button disabled={settingsDisabled} onClick={() => navigate('custom-ai')}><Icon name="sparkles"/>{t('AI 识别服务', 'AI Services')}</button><button disabled={settingsDisabled} onClick={() => run({ type: 'shortcut-open' })}><Icon name="keyboard"/>{t('快捷键', 'Shortcut')}</button><button disabled={settingsDisabled} onClick={() => navigate('dictionary')}><Icon name="dictionary"/>{t('词典', 'Dictionary')}</button><button onClick={() => run({ type: 'document-open', document: 'about' })}><Icon name="info"/>{t('关于 TxChat', 'About TxChat')}</button></div>
        {ready && <><div className="tx-home-mode" role="group" aria-label={t('听写模式', 'Dictation mode')}><button className={product.preferences.mode === 'smart' ? 'is-selected' : ''} disabled={settingsDisabled} aria-pressed={product.preferences.mode === 'smart'} onClick={() => run({ type: 'preferences', mode: 'smart' })}>{t('智能整理', 'Formatted')}</button><button className={product.preferences.mode === 'verbatim' ? 'is-selected' : ''} disabled={settingsDisabled} aria-pressed={product.preferences.mode === 'verbatim'} onClick={() => run({ type: 'preferences', mode: 'verbatim' })}>{t('逐字记录', 'Verbatim')}</button></div>
        <p className="tx-home-mode-description">{t('智能整理可通过大模型将所说内容根据语境将文字内容进行适当调整', 'Smart Format uses AI to refine spoken content based on context')}</p></>}
        <BillingUsage product={product} t={t} onOpen={() => navigate('membership')}/>
        {(localDemo || !product.environment.configured) && <div className="tx-environment-note">{localDemo ? t('本机示例 · 音频仅发送至本机 · 固定示例文字', 'Local demo · Audio stays on this device · Fixed sample text') : t('服务适配器尚未配置 · 可配置自定义 AI', 'Service adapter not configured · Configure Custom AI to continue')}</div>}
      </section>}
      {product.page === 'membership' && <Membership product={product} t={t} command={dispatch} disabled={settingsDisabled} onBack={() => navigate('status')}/>}
      {product.page === 'custom-ai' && <CustomAI storageError={product.storageError} snapshot={product.custom} service={product.preferences.service} demo={product.auth.demo} command={dispatch} t={t} disabled={settingsDisabled} onBack={() => navigate('status')} registerLeave={registerLeave}/>}
      {product.page === 'dictionary' && <Dictionary snapshot={product.dictionary} command={dispatch} t={t} disabled={settingsDisabled} onBack={() => navigate('status')} registerLeave={registerLeave}/>}
    </>}
    {product.stage !== 'onboarding' && noticeCode && noticeCode !== dismissedNotice && <div className={`tx-global-notice ${['LOCAL_FIXED_TRANSCRIPT', 'OPTIMIZATION_FALLBACK', 'DICTIONARY_FALLBACK'].includes(noticeCode) ? 'tx-global-info' : ''}`} role={['LOCAL_FIXED_TRANSCRIPT', 'OPTIMIZATION_FALLBACK', 'DICTIONARY_FALLBACK'].includes(noticeCode) ? 'status' : 'alert'}><span>{errorText(noticeCode, t)}</span><button className="tx-icon-button" aria-label={t('关闭提示', 'Dismiss message')} onClick={() => { setLocalError(''); setDismissedNotice(noticeCode); }}>×</button></div>}
    {modal === 'permissions' && snapshot.platform === 'win32' ? <WindowsSetupDialog snapshot={snapshot} t={t} busy={settingsDisabled || reconnecting} close={() => setModal(null)} reconnect={reconnectHelper} check={() => refreshPermissions(true)} command={dispatch}/> : modal === 'permissions' && snapshot.helper.status !== 'ready' ? <Modal variant="permission" title={t('辅助程序连接已中断', 'Helper Connection Interrupted')} onClose={() => setModal(null)} footer={<><button onClick={() => setModal(null)}>{t('取消', 'Cancel')}</button><button className="tx-primary" disabled={settingsDisabled || reconnecting || snapshot.helper.status === 'starting'} onClick={() => void reconnectHelper()}>{reconnecting || snapshot.helper.status === 'starting' ? t('正在连接…', 'Connecting…') : t('重新连接', 'Reconnect')}</button></>}><Brand symbol/><p>{t('重新连接辅助程序后，再检查系统权限。中断的听写不会自动继续。', 'Reconnect the helper, then check system permissions. Interrupted dictation will not resume automatically.')}</p></Modal> : modal === 'permissions' && <PermissionRepair microphoneMissing={!isMicrophoneReady(snapshot)} t={t} busy={settingsDisabled} cancel={() => setModal(null)} recheck={() => void refreshPermissions(true)} openSettings={() => { setPermissionCheck('checking'); void dispatch({ type: 'permissions-repair' }).then(() => refreshPermissions()).catch(() => setPermissionCheck('unchecked')); }}/>}
    {product.shortcutEditor && <ShortcutEditor state={product.shortcutEditor} platform={snapshot.helper.platform === 'win32' ? 'win32' : 'darwin'} command={dispatch} t={t}/>}
    {modal === 'voice' && <Modal title={t('测试语音输入', 'Try Voice Input')} onClose={closeVoice} closeLabel={t('关闭', 'Close')} footer={<><button onClick={closeVoice}>{t('关闭', 'Close')}</button><button className="tx-primary" disabled={snapshot.dictation.phase !== 'listening' && ACTIVE_PHASES.includes(snapshot.dictation.phase)} onClick={() => run({ type: snapshot.dictation.phase === 'listening' ? 'voice-test-stop' : 'voice-test-start' })}>{snapshot.dictation.phase === 'listening' ? t('结束说话', 'Finish Speaking') : t('开始说话', 'Start Speaking')}</button></>}>
      <p>{localDemo ? t('本机示例使用真实麦克风，但仅返回固定示例文字；结果只显示在这里。', 'This local demo uses the microphone but returns fixed sample text, shown only here.') : t('试着说一句话，识别结果仅显示在这里。', 'Say a short sentence. Your recognized text appears here.')}</p><div className={`tx-voice-visual ${snapshot.dictation.phase === 'listening' ? 'is-listening' : ''}`} aria-hidden="true"><span /><span /><span /><span /><span /></div><p className="tx-center" role="status">{snapshot.dictation.completion === 'no-speech' ? errorText('NO_SPEECH', t) : phaseLabel(snapshot.dictation.phase, t)}</p><div className="tx-voice-result">{product.voiceTestResult || snapshot.dictation.partialText || t('点击“开始说话”进行测试', 'Click “Start Speaking” to try it')}</div><Notice error>{snapshot.dictation.phase === 'failed' ? errorText(snapshot.dictation.failure ?? 'DICTATION_FAILED', t) : ''}</Notice>
    </Modal>}
    {modal === 'logout' && <Modal title={product.auth.demo ? t('退出本机示例？', 'Leave the local demo?') : t('退出登录？', 'Sign out?')} onClose={() => setModal(null)} closeLabel={t('取消', 'Cancel')} footer={<><button onClick={() => setModal(null)}>{t('取消', 'Cancel')}</button><button className="tx-primary" onClick={() => guarded(() => run({ type: 'auth-logout' }))}>{t('退出', 'Sign Out')}</button></>}><p>{t('退出后将停止使用当前账户的云服务。', 'Signing out ends access to cloud services for this account.')}</p></Modal>}
    {product.billing.payment.phase !== 'closed' && <Payment product={product} command={dispatch} t={t}/>}

    {product.document && <TextReader key={`${product.document.kind}-${product.document.language}`} document={product.document} close={() => run({ type: 'document-close' })}/>}
  </main>;
}
function phaseLabel(phase: Phase, t: Translate) {
    const labels: Record<Phase, [
        string,
        string
    ]> = { idle: ['准备就绪', 'Ready'], unavailable: ['等待辅助程序', 'Waiting for helper'], starting: ['正在开始…', 'Starting…'], listening: ['正在聆听…', 'Listening…'], finalizing: ['正在识别…', 'Recognizing…'], organizing: ['正在整理…', 'Formatting…'], inserting: ['正在写入…', 'Inserting…'], completed: ['已完成', 'Completed'], resultFallback: ['文字已保留', 'Text retained'], failed: ['任务未完成', 'Could not complete'] };
    return t(...labels[phase]);
}
