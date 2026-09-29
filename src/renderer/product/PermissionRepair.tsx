import { Brand, Modal, type Translate } from './ui';
export function PermissionRepair({ microphoneMissing, t, busy, cancel, recheck, openSettings }: {
    microphoneMissing: boolean;
    t: Translate;
    busy: boolean;
    cancel: () => void;
    recheck: () => void;
    openSettings: () => void;
}) {
    return <Modal variant="permission" title={microphoneMissing ? t('麦克风权限已关闭', 'Microphone Access Is Off') : t('需要恢复辅助功能权限', 'Accessibility Access Required')} onClose={cancel} closeLabel={t('取消', 'Cancel')} footer={<><button onClick={cancel}>{t('取消', 'Cancel')}</button><button disabled={busy} onClick={recheck}>{t('重新检查授权', 'Recheck')}</button><button className="tx-primary" disabled={busy} onClick={openSettings}>{t('打开系统设置', 'Open Settings')}</button></>}>
    <Brand symbol/><p>{microphoneMissing ? t('在系统设置中允许 TxChat 使用麦克风，才能继续听写。', 'Allow TxChat to use the microphone in System Settings to continue dictation.') : t('在系统设置中允许 TxChat 控制电脑，才能响应快捷键并写入文字。', 'Allow TxChat in System Settings so it can use the shortcut and insert text.')}</p>
  </Modal>;
}
