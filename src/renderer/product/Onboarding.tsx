import { windowsOnboardingView } from './WindowsSetup';
import { useState } from 'react';
import type { AppSnapshot } from '../../shared/contracts';
import { Brand, Icon, shortcutName, type Dispatch, type Translate } from './ui';
import './onboarding.css';
type OnboardingStep = AppSnapshot['product']['onboarding']['step'];
const steps: OnboardingStep[] = ['microphone', 'accessibility', 'voice-test', 'complete'];
function presentation(snapshot: AppSnapshot, t: Translate) {
    const microphoneReady = ['granted', 'systemManaged'].includes(snapshot.audio.status?.permission ?? '');
    const accessibilityReady = ['granted', 'notRequired'].includes(snapshot.input.status?.accessibility ?? '');
    const shortcut = shortcutName(snapshot.product.preferences.shortcut, snapshot.helper.platform === 'win32' ? 'win32' : 'darwin', snapshot.product.preferences.shortcutLabel);
    switch (snapshot.product.onboarding.step) {
        case 'microphone': return {
            status: t('设置 1 / 4 · 麦克风', 'Setup 1 / 4 · Microphone'),
            title: t('允许使用麦克风', 'Allow Microphone Access'),
            detail: t('TxChat 需要使用麦克风来收听语音，请在系统弹窗中点击"允许"。', 'TxChat needs microphone access to listen to your voice. Please click "Allow" in the system dialog.'),
            cardTitle: t('麦克风权限', 'Microphone Permission'),
            cardDetail: microphoneReady ? t('已授权 · 仅在主动听写时使用', 'Authorized · Used only during dictation') : t('未授权 · 点击进入系统设置', 'Not authorized · Click to open System Settings'),
            action: t('打开系统设置', 'Open Settings'),
            footnote: t('权限可随时在系统设置中关闭', 'Permissions can be revoked in System Settings anytime'),
        };
        case 'accessibility': return {
            status: t('设置 2 / 4 · 辅助功能', 'Setup 2 / 4 · Accessibility'),
            title: t('允许写入当前光标', 'Allow Writing at Cursor'),
            detail: t('TxChat 需要辅助功能权限，才能把识别结果写入正确位置。', 'TxChat needs Accessibility permission to insert recognized text at the correct position.'),
            cardTitle: t('辅助功能权限', 'Accessibility Permission'),
            cardDetail: accessibilityReady ? t('已授权 · 仅用于写入识别结果', 'Authorized · Only used for inserting text') : t('未授权 · 仅用于写入识别结果', 'Not authorized · Only used for inserting text'),
            action: t('打开系统设置', 'Open Settings'),
            footnote: t('不会读取屏幕内容，也不会记录键盘输入', 'Does not read screen content or record keystrokes'),
        };
        case 'voice-test': return {
            status: t('设置 3 / 4 · 语音测试', 'Setup 3 / 4 · Voice Test'),
            title: t('说一句，试试看', 'Try Speaking Now'),
            detail: t(`按一次 ${shortcut} 开始，再按一次结束，测试会通过悬浮窗反馈。`, `Press ${shortcut} once to start, press again to stop. Test results will be shown in the floating window.`),
            cardTitle: t('通过悬浮窗测试', 'Test via Floating Window'),
            cardDetail: t('快捷键可在正式使用时变更', 'Shortcut can be changed later'),
            action: snapshot.dictation.phase === 'completed' && snapshot.dictation.completion !== 'no-speech' ? t('下一步', 'Next') : t('跳过此步', 'Skip This Step'),
            footnote: t('测试完成后即可开始使用 TxChat', 'You can start using TxChat after testing'),
        };
        case 'complete': return {
            status: t('设置 4 / 4 · 开始使用', 'Setup 4 / 4 · Get Started'),
            title: t('一切就绪', 'All Set'),
            detail: t('TxChat 已配置完成，可以开始使用了。', 'TxChat is configured and ready to use.'),
            cardTitle: t('TxChat 已准备好', 'TxChat Is Ready'),
            cardDetail: t('更多内容进入状态中心查看', 'See more details in Status Center'),
            action: t('进入状态中心', 'Status Center'),
            footnote: t('之后可从菜单栏随时打开状态与设置', 'You can access status and settings from the menu bar anytime'),
        };
    }
}
function voiceStatus(snapshot: AppSnapshot, fallback: string, t: Translate) {
    switch (snapshot.dictation.phase) {
        case 'starting': return t('正在准备语音测试…', 'Preparing voice test…');
        case 'listening': return snapshot.dictation.partialText || t('正在聆听…', 'Listening…');
        case 'finalizing': return t('正在完成最后一段…', 'Finishing the last segment…');
        case 'organizing': return t('正在整理表达…', 'Refining your words…');
        case 'inserting':
        case 'resultFallback': return snapshot.dictation.resultText;
        case 'completed': return snapshot.dictation.completion === 'no-speech' ? t('未检测到语音，可以重新测试', 'No speech detected. You can try again') : snapshot.product.voiceTestResult || t('测试成功', 'Test succeeded');
        case 'failed': return t('可以重新测试', 'You can try again');
        case 'unavailable': return t('语音服务暂不可用', 'Voice service is unavailable');
        default: return fallback;
    }
}
export function Onboarding({ snapshot, command, t, message }: {
    snapshot: AppSnapshot;
    command: Dispatch;
    t: Translate;
    message: string;
}) {
    const { product } = snapshot;
    const step = product.onboarding.step;
    const view = snapshot.platform === 'win32' ? windowsOnboardingView(snapshot, t, presentation(snapshot, t)) : presentation(snapshot, t);
    const index = steps.indexOf(step);
    const permissionStep = step === 'microphone' || step === 'accessibility';
    const voiceStep = step === 'voice-test';
    const [reconnecting, setReconnecting] = useState(false);
    const helperUnavailable = snapshot.helper.status !== 'ready';
    const busy = snapshot.input.busy || snapshot.audio.busy || reconnecting || snapshot.helper.status === 'starting';
    const run = (value: Parameters<Dispatch>[0]) => { void command(value).catch(() => undefined); };
    const act = () => {
        if (helperUnavailable) {
            if (busy || snapshot.dictation.phase === 'resultFallback')
                return;
            setReconnecting(true);
            void command({ type: 'restart-helper' }).catch(() => undefined).finally(() => setReconnecting(false));
            return;
        }
        if (permissionStep) {
            run({ type: 'onboarding-permission' });
        }
        else if (voiceStep && (snapshot.dictation.phase !== 'completed' || snapshot.dictation.completion === 'no-speech'))
            run({ type: 'voice-test-skip' });
        else
            run({ type: 'onboarding-next' });
    };
    const labels = [t('麦克风', 'Microphone'), snapshot.platform === 'win32' ? t('输入配置', 'Input Setup') : t('辅助功能', 'Accessibility'), t('语音测试', 'Voice Test'), t('开始使用', 'Get Started')];
    const keycap = shortcutName(product.preferences.shortcut, snapshot.helper.platform === 'win32' ? 'win32' : 'darwin', product.preferences.shortcutLabel);
    return <section className="tx-onboarding" data-step={step} data-testid={`onboarding.${step === 'complete' ? 'get-started' : step}`} aria-labelledby="tx-onboarding-title">
    <div className="tx-ob-brand"><Brand /></div>
    <button className="tx-ob-language" onClick={() => run({ type: 'preferences', language: product.preferences.language === 'zh' ? 'en' : 'zh' })} data-testid="onboarding.language"><Icon name="globe"/>{t('English', '中文')}</button>
    <button className="tx-ob-account" onClick={() => run({ type: 'auth-logout' })} data-testid="onboarding.logout"><span>{product.auth.demo ? t('本机示例', 'Local demo') : product.auth.maskedPhone ?? t('已登录', 'Signed in')}</span><Icon name="logout"/></button>
    <div className="tx-ob-spine">
      <svg width="132" height="340" viewBox="0 0 132 340" aria-hidden="true"><path d="M12 17 C33 47 3 78 12 112 C-3 143 30 176 12 207 C29 239 0 271 12 302"/></svg>
      <ol aria-label={t('设置进度', 'Setup progress')}>{labels.map((label, i) => {
            const state = step === 'complete' || i < index ? 'complete' : i === index ? 'current' : 'upcoming';
            return <li key={steps[i]} style={{ top: 17 + i * 95 }} className={`is-${state}`} aria-current={i === index ? 'step' : undefined}><span className="tx-ob-node" aria-hidden="true">{state === 'complete' ? <svg viewBox="0 0 12 12"><path d="m2 6 2.5 2.5L10 3"/></svg> : <span />}</span><span className="tx-ob-step-label">{label}</span></li>;
        })}</ol>
    </div>
    <span className="tx-ob-status-dot" aria-hidden="true"/>
    <p className="tx-ob-status">{view.status}</p>
    <h1 id="tx-onboarding-title">{view.title}</h1>
    <p className="tx-ob-detail">{view.detail}</p>
    <div className={`tx-ob-card ${permissionStep ? 'tx-ob-permission-card' : 'tx-ob-action-card'}`}>
      {!permissionStep && <div className={`tx-ob-keycap ${keycap === 'Fn' ? '' : 'tx-ob-keycap-wide-label'}`} aria-label={t(`快捷键 ${keycap}`, `Shortcut ${keycap}`)}><span>{keycap}</span></div>}
      <h2>{view.cardTitle}</h2><p>{view.cardDetail}</p>
      <button className="tx-ob-primary" disabled={busy || helperUnavailable && snapshot.dictation.phase === 'resultFallback'} onClick={act} data-testid={voiceStep ? 'onboarding.voice-test-action' : step === 'complete' ? 'onboarding.get-started' : `onboarding.${step}.action`}>{helperUnavailable ? busy ? t('正在连接…', 'Connecting…') : t('重新连接', 'Reconnect') : view.action}</button>
      {voiceStep && <span className="tx-visually-hidden" role="status" data-testid="onboarding.voice-test-result">{voiceStatus(snapshot, view.cardDetail, t)}</span>}
    </div>
    <p className="tx-ob-footnote">{view.footnote}</p>
    {message && <p className="tx-ob-message" role="alert" data-testid="onboarding.message">{message}</p>}
  </section>;
}
