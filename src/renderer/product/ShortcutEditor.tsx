import type { ShortcutEditorSnapshot } from '../../shared/shortcut-editor';
import { shortcutDisplayName, type ShortcutPlatform } from '../../shared/shortcut-bindings';
import { Modal, type Dispatch, type Translate } from './ui';
import './shortcut-editor.css';
export function ShortcutEditor({ state, platform, command, t }: {
    state: ShortcutEditorSnapshot;
    platform: ShortcutPlatform;
    command: Dispatch;
    t: Translate;
}) {
    const run = (type: 'shortcut-capture' | 'shortcut-save' | 'shortcut-cancel') => { void command({ type, sessionId: state.sessionId }).catch(() => undefined); };
    const main = state.phase === 'current' ? t('按下新的快捷键', 'Press a new shortcut') : state.phase === 'waiting' ? t('请按下新的快捷键…', 'Press a new shortcut…') : state.display ?? shortcutDisplayName(state.candidate ?? state.current, platform, state.candidate ? state.candidateLabel : state.currentLabel);
    const errors: Record<string, string> = {
        BARE_KEY: t('裸键不安全', 'Bare keys are unsafe'), SHIFT_ONLY: t('Shift-only 不安全', 'Shift-only is unsafe'),
        FN_COMBINATION: t('Fn 组合暂不支持', 'Fn combinations are not supported'), TOO_MANY_KEYS: t('最多支持同时按下 3 个按键', 'Use no more than 3 keys at once'),
        CAPTURE_EXPIRED: t('录入已超时，点击重新录入', 'Recording timed out. Click to try again'),
        PERMISSION_REQUIRED: t('请先完成快捷键所需的系统授权', 'Allow the required system permissions first'),
        FN_CAPTURE_UNAVAILABLE: t('Fn 录入需要辅助功能授权；可录入普通组合键', 'Fn requires Accessibility; ordinary shortcuts are available'),
        SHORTCUT_ROLLBACK_FAILED: t('保存与恢复失败，快捷键已停用；请重新保存', 'Save and restore failed. Shortcut disabled; retry saving'),
        HOTKEY_UNAVAILABLE: t('快捷键暂不可用，请重新录入', 'Shortcut unavailable. Please record it again'),
    };
    const secondary = state.busy ? t('请稍候…', 'Please wait…') : state.phase === 'current' ? t('点击此处开始录入', 'Click here to start recording')
        : state.phase === 'waiting' ? errors[state.error ?? ''] ?? t('按 Esc 可取消', 'Press Esc to cancel')
            : state.phase === 'captured' ? t('保存成功后才会生效', 'Takes effect only after saving')
                : state.phase === 'conflict' ? t('已被占用，重新设置新的快捷键。', 'Already in use — please set a new shortcut.')
                    : state.phase === 'unsupported' ? t('暂不支持，重新设置新的快捷键。', 'Not supported — please set a new shortcut.')
                        : state.phase === 'saveFailed' ? errors[state.error ?? ''] ?? t('未能保存到本机，重新设置新的快捷键。', 'Failed to save locally — please set a new shortcut.')
                            : errors[state.error ?? ''] ?? t('不安全，重新设置新的快捷键。', 'Unsafe — please set a new shortcut.');
    return <Modal variant="shortcut" title={t('修改快捷键', 'Change Shortcut')} onClose={() => run('shortcut-cancel')} footer={<>
    <button className="tx-shortcut-cancel" onClick={() => run('shortcut-cancel')}>{t('取消', 'Cancel')}</button>
    <button className={`tx-primary tx-shortcut-save ${state.phase === 'saveFailed' ? 'is-retry' : ''}`} disabled={state.busy || !state.candidate || !['captured', 'saveFailed'].includes(state.phase)} onClick={() => run('shortcut-save')}>{state.phase === 'saveFailed' ? t('重试保存', 'Retry Save') : t('保存', 'Save')}</button>
  </>}>
    <div className="tx-shortcut-current"><span>{t('当前快捷键', 'Current Shortcut')}</span><kbd>{shortcutDisplayName(state.current, platform, state.currentLabel)}</kbd></div>
    <button className="tx-shortcut-capture" disabled={state.busy} onClick={() => run('shortcut-capture')} aria-label={t('录入新的快捷键', 'Record a new shortcut')}><span className="tx-shortcut-capture-inner"><strong>{main}</strong><span role="status" aria-live="polite">{secondary}</span></span></button>
    <p className="tx-shortcut-guidance">{platform === 'darwin' ? t('普通组合键最多同时按下 3 个按键，且需包含 Ctrl、Opt、Shift 或 Cmd。Fn 组合、裸键和 Shift-only 不可用。', 'Use at most 3 keys and include Ctrl, Opt, Shift, or Cmd. Fn combinations, bare keys, and Shift-only shortcuts are unavailable.') : t('支持单独按 F8；普通组合键最多同时按下 3 个按键，且需包含 Ctrl、Alt、Shift 或 Win。Fn、其他裸键和 Shift-only 不可用。', 'F8 can be used alone. Combinations support at most 3 keys and require Ctrl, Alt, Shift, or Win. Fn, other bare keys, and Shift-only shortcuts are unavailable.')}</p>
  </Modal>;
}
