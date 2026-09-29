import type { AppSnapshot } from '../../shared/contracts';
import { Brand, Modal, type Dispatch, type Translate } from './ui';
export function windowsSetupState(snapshot: AppSnapshot) {
    if (snapshot.helper.status !== 'ready')
        return snapshot.helper.status === 'starting' ? 'connecting' : 'disconnected';
    const audio = snapshot.audio.status;
    if (!audio || audio.permission === 'notDetermined')
        return 'microphone-unknown';
    if (audio.permission === 'denied' || audio.permission === 'restricted')
        return 'microphone-denied';
    if (audio.reason)
        return 'microphone-device';
    if (!snapshot.input.status)
        return 'input-unknown';
    if (!snapshot.input.status.enabled)
        return snapshot.input.error === 'HOTKEY_CONFLICT' || snapshot.input.status.reason === 'HOTKEY_CONFLICT' ? 'shortcut-conflict' : 'input-disabled';
    return 'ready';
}
export function windowsSetupText(snapshot: AppSnapshot, t: Translate) {
    switch (windowsSetupState(snapshot)) {
        case 'connecting': return { title: t('正在连接辅助程序…', 'Connecting to Helper…'), detail: t('正在准备麦克风和输入能力，请稍候。', 'Preparing microphone and input support. Please wait.'), action: t('正在连接…', 'Connecting…') };
        case 'disconnected': return { title: t('辅助程序连接已中断', 'Helper Connection Interrupted'), detail: t('重新连接后再检查麦克风和输入配置。', 'Reconnect, then check microphone and input settings.'), action: t('重新连接', 'Reconnect') };
        case 'microphone-denied': return { title: t('麦克风权限已关闭', 'Microphone Access Is Off'), detail: t('请在 Windows 麦克风隐私设置中允许桌面应用访问麦克风。', 'Allow desktop apps to access the microphone in Windows privacy settings.'), action: t('打开系统设置', 'Open Settings') };
        case 'microphone-unknown': return { title: t('麦克风状态待检查', 'Microphone Status Unknown'), detail: t('尚未确认麦克风是否可用，请先检查。', 'Check whether the microphone is available.'), action: t('检查麦克风', 'Check Microphone') };
        case 'microphone-device': return { title: t('麦克风设备需要检查', 'Check Microphone Device'), detail: t('请检查麦克风连接及 Windows 输入设备设置。', 'Check the microphone connection and Windows input device settings.'), action: t('重新检查', 'Check Again') };
        case 'shortcut-conflict': return { title: t('快捷键已被占用', 'Shortcut Is in Use'), detail: t('请选择其他快捷键，或在占用它的应用中释放后重新启用。', 'Choose another shortcut, or release it in the other app and enable it again.'), action: t('设置快捷键', 'Set Shortcut') };
        case 'input-unknown': return { title: t('输入配置待检查', 'Check Input Setup'), detail: t('尚未取得输入状态，请重新检查配置。', 'Input status is not available yet. Check again.'), action: t('检查配置', 'Check Configuration') };
        case 'input-disabled': return { title: t('快捷键尚未启用', 'Shortcut Is Not Enabled'), detail: t('启用快捷键后即可开始听写。Windows 无需单独授予辅助功能权限。', 'Enable the shortcut to start dictation. Windows requires no separate accessibility permission.'), action: t('启用快捷键', 'Enable Shortcut') };
        case 'ready': return { title: t('TxChat 已就绪', 'TxChat Ready'), detail: t('麦克风和输入配置已就绪。', 'Microphone and input are ready.'), action: t('完成', 'Done') };
    }
}
export function WindowsSetupRows({ snapshot, t, busy, open }: {
    snapshot: AppSnapshot;
    t: Translate;
    busy: boolean;
    open: () => void;
}) {
    const view = windowsSetupText(snapshot, t);
    return <><div className="tx-home-setup"><div className="tx-home-setup-row"><h3><span aria-hidden="true">ⓘ</span>{view.title}</h3><div><button className="tx-primary" disabled={busy || snapshot.helper.status === 'starting'} onClick={open}>{windowsSetupState(snapshot) === 'microphone-unknown' ? view.action : t('检查配置', 'Check Configuration')}</button><span style={{ whiteSpace: 'normal', maxWidth: 245, lineHeight: '20px' }}>{view.detail}</span></div></div></div></>;
}
export function WindowsSetupDialog({ snapshot, t, busy, close, reconnect, check, command }: {
    snapshot: AppSnapshot;
    t: Translate;
    busy: boolean;
    close: () => void;
    reconnect: () => Promise<void>;
    check: () => Promise<void>;
    command: Dispatch;
}) {
    const state = windowsSetupState(snapshot), view = windowsSetupText(snapshot, t);
    const act = async () => {
        if (state === 'disconnected')
            return reconnect();
        if (state === 'microphone-denied') {
            await command({ type: 'system-settings', capability: 'microphone' });
            return;
        }
        if (state === 'shortcut-conflict') {
            close();
            await command({ type: 'shortcut-open' });
            return;
        }
        if (state === 'input-disabled')
            await command({ type: 'permissions-repair' });
        if (state === 'ready') {
            close();
            return;
        }
        await check();
    };
    return <Modal variant="permission" title={view.title} onClose={close} closeLabel={t('取消', 'Cancel')} footer={<><button onClick={close}>{t('取消', 'Cancel')}</button>{state === 'microphone-denied' && <button disabled={busy} onClick={() => void check()}>{t('重新检查', 'Check Again')}</button>}<button className="tx-primary" disabled={busy || state === 'connecting'} onClick={() => void act().catch(() => undefined)}>{view.action}</button></>}><Brand symbol/><p>{view.detail}</p></Modal>;
}
type OnboardingView = {
    status: string;
    title: string;
    detail: string;
    cardTitle: string;
    cardDetail: string;
    action: string;
    footnote: string;
};
export function windowsOnboardingView(snapshot: AppSnapshot, t: Translate, base: OnboardingView): OnboardingView {
    if (snapshot.helper.status !== 'ready') {
        const view = windowsSetupText(snapshot, t);
        return { ...base, title: snapshot.helper.status === 'starting' ? t('正在连接…', 'Connecting…') : t('重新连接后继续', 'Reconnect to Continue'), detail: view.detail, cardTitle: view.title, cardDetail: t('连接成功后继续设置。', 'Setup continues after connecting.'), action: view.action, footnote: t('未连接不代表系统拒绝授权。', 'A disconnected helper does not mean permission was denied.') };
    }
    if (snapshot.product.onboarding.step === 'microphone') {
        const view = windowsSetupText(snapshot, t);
        return { ...base, title: t('设置麦克风', 'Set Up Microphone'), detail: t('检查麦克风，并按需在 Windows 设置中开启访问。', 'Check microphone access. If blocked, allow desktop apps in Windows settings.'), cardTitle: view.title, cardDetail: view.detail, action: view.action, footnote: t('仅在你主动听写时采集语音。', 'Audio is captured only when you start dictation.') };
    }
    if (snapshot.product.onboarding.step === 'accessibility')
        return { ...base,
            status: t('设置 2 / 4 · 输入配置', 'Setup 2 / 4 · Input Setup'), title: t('设置快捷键与文字输入', 'Set Up Text Input'),
            detail: t('Windows 无需单独授予辅助功能权限。', 'Windows requires no separate accessibility permission. Enable the shortcut to start dictation.'),
            cardTitle: t('输入配置', 'Input Setup'), cardDetail: snapshot.input.status?.enabled ? t('快捷键已启用', 'Shortcut enabled') : t('检查并启用当前快捷键', 'Check and enable the current shortcut'),
            action: t('启用快捷键', 'Enable Shortcut'), footnote: t('密码框、受保护窗口和管理员应用可能限制写入。', 'Password fields, protected windows and elevated apps may restrict input.') };
    return { ...base, ...(snapshot.product.onboarding.step === 'complete' ? { footnote: t('之后可从系统托盘打开状态与设置', 'Open status and settings from the system tray anytime') } : {}) };
}
