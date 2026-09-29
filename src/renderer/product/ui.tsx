import { shortcutDisplayName } from '../../shared/shortcut-bindings';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Command } from '../../shared/contracts';
import type { Language, ProductCommand, ProductError } from '../../shared/product';
export type Dispatch = (command: Command | ProductCommand) => Promise<void>;
export type Translate = (zh: string, en: string) => string;
export const translate = (language: Language): Translate => (zh, en) => language === 'en' ? en : zh;
export const shortcutName = shortcutDisplayName;
export function useNow() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return Date.now();
}
export const remainingSeconds = (deadline: number, now: number) => Math.max(0, Math.ceil((deadline - now) / 1000));
export const duration = (milliseconds: number, t: Translate) => {
    if (milliseconds > 0 && milliseconds < 60000) {
        const seconds = Math.ceil(milliseconds / 1000);
        return t(`${seconds} 秒`, `${seconds} sec`);
    }
    const minutes = Math.max(0, Math.floor(milliseconds / 60000));
    return minutes >= 60 ? t(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`, `${Math.floor(minutes / 60)} h ${minutes % 60} min`) : t(`${minutes} 分钟`, `${minutes} min`);
};
export const money = (fen: number) => `¥${(fen / 100).toFixed(fen % 100 ? 2 : 0)}`;
export function dateLabel(value: string | null, language: Language) {
    if (!value || !Number.isFinite(Date.parse(value)))
        return '—';
    return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value));
}
const ERRORS: Record<string, [
    string,
    string
]> = {
    HELPER_NOT_BUILT: ['原生辅助程序尚未构建，请运行 npm run build:native 后重新连接。', 'The native helper has not been built. Run npm run build:native, then reconnect.'],
    RECOGNITION_NOT_CONFIGURED: ['识别适配器尚未配置。请选择并配置自定义 AI，或显式启用本地示例。', 'No recognition adapter is configured. Configure and select Custom AI, or explicitly enable the local example.'],
    UPDATE_NOT_CONFIGURED: ['更新服务尚未配置。请接入自有更新服务后重新构建。', 'The update service is not configured. Connect your update service and rebuild.'],
    DOCUMENT_NOT_CONFIGURED: ['此说明文档尚未配置。请由服务维护者提供。', 'This document is not configured. Ask your service maintainer to provide it.'],
    SERVICE_NOT_CONFIGURED: ['服务适配器尚未配置。请按开发文档接入自有服务后重新构建。', 'No service adapter is configured. Connect your own service following the development documentation and rebuild.'],
    ACCOUNT_IDENTITY_PENDING: ['暂时无法确认账号信息，请稍后点击“开始使用”重试', "We couldn't confirm your account. Select Get Started to retry."],
    NETWORK_ERROR: ['网络连接失败，请检查网络后重试。', 'Could not connect. Check your connection and try again.'],
    NETWORK_UNAVAILABLE: ['网络连接失败，请检查网络后重试。', 'Could not connect. Check your connection and try again.'],
    ENVIRONMENT_UNAVAILABLE: ['服务适配器尚未配置。请接入自有服务后重新构建，或使用本地功能。', 'The service adapter is not configured. Connect your own service and rebuild, or use local features.'],
    SERVICE_UNAVAILABLE: ['服务暂时不可用，请稍后重试。', 'The service is unavailable. Please try again later.'],
    INVALID_PHONE: ['请输入 11 位中国大陆手机号码。', 'Enter an 11-digit mainland China mobile number.'],
    INVALID_CODE: ['验证码不正确，请检查后重试。', 'The verification code is incorrect. Try again.'],
    VERIFICATION_FAILED: ['验证码不正确或已过期，请重新获取。', 'The code is incorrect or expired. Request a new one.'],
    CODE_EXPIRED: ['验证码已过期，请重新获取。', 'The verification code expired. Request a new one.'],
    CHALLENGE_EXPIRED: ['验证码已过期，请重新获取。', 'The verification code expired. Request a new one.'],
    VERIFICATION_LOCKED: ['验证暂时锁定，请等待倒计时结束。', 'Verification is temporarily locked. Wait for the countdown.'],
    RATE_LIMITED: ['操作过于频繁，请稍后重试。', 'Too many requests. Please wait and try again.'],
    TERMS_REQUIRED: ['请先阅读并同意用户协议与隐私政策。', 'Read and accept the Terms and Privacy Policy first.'],
    AUTH_REQUIRED: ['登录已失效，请重新登录。', 'Your session has expired. Sign in again.'],
    SESSION_EXPIRED: ['登录已失效，请重新登录。', 'Your session has expired. Sign in again.'],
    PERMISSION_REQUIRED: ['请先授权辅助功能，再检查配置。', 'Allow accessibility access, then check again.'],
    AUDIO_PERMISSION_REQUIRED: ['请先授权麦克风，再检查配置。', 'Allow microphone access, then check again.'],
    AUDIO_DEVICE_UNAVAILABLE: ['麦克风不可用，请检查设备连接。', 'Microphone unavailable. Check your input device.'],
    AUDIO_INTERRUPTED: ['录音已中断，请检查麦克风。', 'Recording was interrupted. Check your microphone.'],
    HOTKEY_CONFLICT: ['快捷键已被占用，请选择另一组快捷键。', 'This shortcut is in use. Choose another shortcut.'],
    HOTKEY_UNAVAILABLE: ['无法启用快捷键，请检查系统权限。', 'Could not enable the shortcut. Check system permissions.'],
    SECURE_INPUT: ['当前处于安全输入模式，请更换输入位置。', 'Secure input is active. Choose another text field.'],
    CUSTOM_AI_INVALID_CONFIGURATION: ['请检查模型及必填配置。', 'Check the model and required settings.'],
    CUSTOM_AI_NOT_CONFIGURED: ['请配置并选择所需的 AI 服务。', 'Configure and select the required AI services.'],
    CUSTOM_AI_NETWORK: ['无法连接模型服务，请检查网络。', 'Could not connect to the model provider.'],
    CUSTOM_AI_AUTHENTICATION: ['认证失败，请检查 API Key。', 'Authentication failed. Check the API key.'],
    CUSTOM_AI_PERMISSION_OR_MODEL: ['模型或服务权限不可用，请检查配置。', 'The model or required permissions are unavailable.'],
    CUSTOM_AI_RATE_LIMIT: ['服务请求过于频繁，请稍后重试。', 'The provider rate limit was reached. Try again later.'],
    CUSTOM_AI_INCOMPATIBLE_RESPONSE: ['模型响应不兼容，请检查服务配置。', 'The provider response is incompatible. Check its settings.'],
    CUSTOM_AI_INVALID_REQUEST: ['模型请求配置无效，请检查参数。', 'The provider request is invalid. Check your settings.'],
    CUSTOM_AI_STORAGE_FAILED: ['配置未保存，请检查系统凭据存储后重试。', 'Settings were not saved. Check the system credential store.'],
    CREDENTIAL_STORAGE_UNAVAILABLE: ['系统凭据存储不可用，配置未保存。', 'The system credential store is unavailable. Settings were not saved.'],
    DICTIONARY_INVALID: ['词条格式不正确，请检查后保存。', 'Check the dictionary entries before saving.'],
    DICTIONARY_SAVE_FAILED: ['词典保存失败，原文件保持不变。', 'Could not save the dictionary. The original file is unchanged.'],
    DICTIONARY_LOAD_FAILED: ['无法读取词典，继续使用上次有效内容。', 'Could not read the dictionary. The last valid entries remain active.'],
    PAYMENT_UNAVAILABLE: ['当前无法购买，请稍后刷新。', 'Purchasing is unavailable. Refresh and try again later.'],
    PAYMENT_EXPIRED: ['二维码已过期，请关闭后重新发起。', 'The payment code expired. Close it and start again.'],
    PAYMENT_UNCONFIRMED: ['尚未确认付款，请稍后再次检查。', 'Payment has not been confirmed. Check again shortly.'],
    NO_CURRENT_ORDER: ['当前没有已有订单，可返回会员页选择套餐。', 'No existing order. Return to Membership to choose a plan.'],
    MEMBERSHIP_SYNC_PENDING: ['已确认付款，会员状态仍在同步。', 'Payment is confirmed. Membership is still synchronizing.'],
    STORAGE_ERROR: ['本地设置无法安全读取或保存，请重试。', 'Local settings could not be read or saved safely. Try again.'],
    DIAGNOSTICS_UNAVAILABLE: ['诊断报告暂时无法发送，请稍后重试。', 'The report could not be sent. Try again later.'],
    NO_DIAGNOSTIC_EVENT: ['目前没有可发送的故障记录。遇到问题后可再次发送诊断。', 'There is no diagnostic event to send. Try again after a problem occurs.'],
    CLOUD_NOT_CONFIGURED: ['云服务尚未配置，可先使用自定义 AI。', 'Cloud service is not configured. You can use Custom AI.'],
    DEMO_NO_BILLING: ['本机示例不提供云端套餐或付款。', 'The local demo does not include cloud plans or payments.'],
    INVALID_PHONE_NUMBER: ['请输入正确的中国大陆手机号码。', 'Enter a valid mainland China mobile number.'],
    PHONE_INVALID: ['手机号码不可用，请检查后重试。', 'This phone number is invalid. Check it and try again.'],
    PHONE_NOT_ALLOWED: ['该手机号码暂不支持登录。', 'Sign-in is not available for this phone number.'],
    SMS_PROVIDER_UNAVAILABLE: ['短信服务暂不可用，请稍后重试。', 'SMS delivery is unavailable. Try again later.'],
    INVALID_VERIFICATION_CODE: ['请输入 6 位数字验证码。', 'Enter the six-digit verification code.'],
    VERIFICATION_CODE_INVALID_OR_EXPIRED: ['验证码不正确或已过期，请检查或重新获取。', 'The code is incorrect or expired. Check it or request a new one.'],
    TOO_MANY_REQUESTS: ['操作过于频繁，请等待倒计时后重试。', 'Too many requests. Wait for the countdown and try again.'],
    ACCOUNT_DISABLED: ['账户暂不可用，请联系支持。', 'Your account is unavailable. Contact support.'],
    SESSION_REPLACED: ['账户已在其他设备登录，请重新登录。', 'Your account signed in on another device. Sign in again.'],
    SESSION_REPLAYED: ['登录状态已失效，请重新登录。', 'Your session is no longer valid. Sign in again.'],
    REQUEST_TIMEOUT: ['请求超时，请检查网络后重试。', 'The request timed out. Check your connection and try again.'],
    PROXY_AUTH_REQUIRED: ['网络代理需要认证，请检查系统代理设置。', 'Your network proxy requires authentication. Check system proxy settings.'],
    PROTOCOL_ERROR: ['服务响应无法验证，请稍后重试。', 'The service response could not be verified. Try again later.'],
    SECURE_STORAGE_UNAVAILABLE: ['系统凭据存储不可用，请检查系统设置。', 'The system credential store is unavailable. Check system settings.'],
    SECURE_STORAGE_READ_FAILED: ['无法安全读取已保存的凭据，请重试。', 'Saved credentials could not be read safely. Try again.'],
    VOICE_TEST_SAVE_FAILED: ['无法保存语音测试设置，请稍后重试', "We couldn't save the voice test. Please try again."],
    ONBOARDING_SAVE_FAILED: ['无法保存引导完成状态，请稍后重试', "We couldn't save onboarding completion. Please try again."],
    STORAGE_WRITE_FAILED: ['本地设置保存失败，请重试。', 'Local settings could not be saved. Try again.'],
    STORAGE_READ_FAILED: ['本地设置读取失败，请重试。', 'Local settings could not be read. Try again.'],
    SETTINGS_READ_FAILED: ['本地设置读取失败，请重试。', 'Local settings could not be read. Try again.'],
    STORAGE_DELETE_FAILED: ['无法清除本地登录凭据，请重试退出。', 'Saved sign-in credentials could not be cleared. Try signing out again.'],
    DICTIONARY_READ_FAILED: ['词典读取失败，继续使用上次有效内容。', 'Could not read the dictionary. The last valid entries remain active.'],
    DICTIONARY_WRITE_FAILED: ['词典保存失败，原文件保持不变。', 'Could not save the dictionary. The original file is unchanged.'],
    DICTIONARY_OPEN_FAILED: ['无法打开词典文件，请检查文件访问权限。', 'Could not open the dictionary. Check file access permissions.'],
    DICTIONARY_LIMIT: ['词典最多可保存 1000 条词条。', 'The dictionary can contain up to 1,000 entries.'],
    DICTIONARY_INVALID_ENTRY: ['词条格式不正确，请检查后保存。', 'An entry is invalid. Check the terms before saving.'],
    DICTIONARY_DUPLICATE: ['错误词重复，请编辑原词条。', 'An incorrect term appears more than once. Edit the existing entry.'],
    DICTIONARY_FALLBACK: ['词典暂不可用，本次保留原始识别文字。', 'The dictionary is unavailable. The original recognized text was retained.'],
    BILLING_NOT_CONFIGURED: ['云端付费服务尚未配置。', 'Cloud billing has not been configured.'],
    BILLING_SALES_PAUSED: ['会员购买暂时暂停，请稍后再试。', 'Membership sales are paused. Please try again later.'],
    BILLING_ORDER_PENDING: ['还有待支付订单，请先检查原订单。', 'A payment is already pending. Check the existing order.'],
    BILLING_MEMBERSHIP_ACTIVE: ['当前会员仍有效，请刷新账户状态。', 'Your membership is active. Refresh the account status.'],
    BILLING_PAYMENT_EXCEPTION: ['支付状态异常，请联系支持核对订单。', 'There is a payment issue. Contact support to review the order.'],
    BILLING_SERVICE_UNAVAILABLE: ['付费服务暂不可用，请稍后再试。', 'Billing is unavailable. Try again later.'],
    BILLING_QUOTA_EXHAUSTED: ['云服务用量已用完，可查看会员套餐。', 'Your cloud allowance is used up. View membership plans.'],
    CUSTOM_AI_INVALID_RESPONSE: ['模型服务返回了无法识别的响应，请检查配置。', 'The model response is incompatible. Check provider settings.'],
    CUSTOM_AI_RESPONSE_TOO_LARGE: ['模型响应超出可处理范围，请稍后重试。', 'The model response exceeded the supported size. Try again.'],
    CUSTOM_AI_TIMEOUT: ['模型服务响应超时，请稍后重试。', 'The model provider timed out. Try again later.'],
    CUSTOM_AI_AUDIO_SAMPLE: ['未检测到有效语音，请重新说话。', 'No speech was detected. Try speaking again.'],
    CUSTOM_AI_EMPTY_RESULT: ['模型没有返回文字，请重新说话。', 'The model returned no text. Try speaking again.'],
    CUSTOM_AI_INVALID_AUDIO: ['音频无法处理，请检查麦克风后重试。', 'The audio could not be processed. Check your microphone.'],
    CUSTOM_AI_AUDIO_LIMIT: ['已达到本次录音上限，请分段说话。', 'The recording limit was reached. Speak in shorter sections.'],
    CUSTOM_AI_UNSUPPORTED_PROVIDER: ['此服务不再支持，请选择其他模型。', 'This provider is unsupported. Choose another model.'],
    NO_SPEECH: ['未检测到语音，可以重新开始。', 'No speech detected. You can try again.'],
    UPSTREAM_UNAVAILABLE: ['语音识别服务暂时不可用，请稍后重试。', 'Speech recognition is temporarily unavailable. Try again shortly.'],
    FINAL_TIMEOUT: ['等待识别结果超时，请重试。', 'Speech recognition timed out. Please try again.'],
    DICTATION_FAILED: ['本次语音输入未完成，请重试。', 'This dictation could not complete. Please try again.'],
    CANCELLED: ['操作已取消。', 'The action was cancelled.'],
    LOCAL_FIXED_TRANSCRIPT: ['本机示例只返回固定文字，不是语音识别结果。', 'The local demo returns fixed sample text, not a speech recognition result.'],
    OPTIMIZATION_FALLBACK: ['智能整理未完成，已保留原始识别文字。', 'Formatting could not complete. The original recognized text was retained.'],
};
export function errorText(error: ProductError | string | null | undefined, t: Translate): string {
    if (!error)
        return '';
    const code = typeof error === 'string' ? error : error.code;
    if (typeof error !== 'string' && error.reason === 'verification_locked')
        return t('验证暂时锁定，请等待倒计时结束。', 'Verification is temporarily locked. Wait for the countdown.');
    const entry = ERRORS[code];
    return entry ? t(...entry) : t('操作未完成，请检查当前状态后重试。', 'The action could not be completed. Check the current status and try again.');
}
export function Icon({ name, className = '' }: {
    name: string;
    className?: string;
}) { const initials: Record<string, string> = { 'alibaba-bailian': 'AB', volcengine: 'V', deepseek: 'DS', kimi: 'K', glm: 'GLM' }; if (initials[name])
    return <span aria-hidden="true" className={`tx-icon tx-provider-initial ${className}`}>{initials[name]}</span>; return <span aria-hidden="true" className={`tx-icon tx-icon-${name} ${className}`}/>; }
export function Brand({ symbol = false }: {
    symbol?: boolean;
}) { return <span role="img" aria-label="TxChat" className={symbol ? 'tx-brand-symbol' : 'tx-brand'}/>; }
export function Notice({ children, error = false }: {
    children: ReactNode;
    error?: boolean;
}) {
    return children ? <p className={`tx-notice ${error ? 'tx-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</p> : null;
}
export function Toggle({ checked, onChange, disabled, label }: {
    checked: boolean;
    onChange: () => void;
    disabled?: boolean;
    label: string;
}) {
    return <button className={`tx-toggle ${checked ? 'is-on' : ''}`} type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}><span /></button>;
}
const inertLeases = new WeakMap<HTMLElement, {
    count: number;
    original: boolean;
}>();
function acquireInert(element: HTMLElement): () => void {
    const existing = inertLeases.get(element);
    if (existing)
        existing.count++;
    else
        inertLeases.set(element, { count: 1, original: element.inert });
    element.inert = true;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const lease = inertLeases.get(element);
        if (!lease)
            return;
        lease.count--;
        if (lease.count === 0) {
            element.inert = lease.original;
            inertLeases.delete(element);
        }
    };
}
const modalLayers = new Map<HTMLElement, HTMLElement | null>();
let modalInertReleases: Array<() => void> = [];
function focusInitialModalControl(target: HTMLElement) {
    if (target instanceof HTMLButtonElement) {
        target.setAttribute('data-initial-programmatic-focus', '');
        target.addEventListener('blur', () => target.removeAttribute('data-initial-programmatic-focus'), { once: true });
    }
    target.focus();
}
function topModal(): HTMLElement | undefined {
    return [...modalLayers.keys()].filter((node) => node.isConnected).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).at(-1);
}
function updateModalLayers(preferredFocus?: HTMLElement | null) {
    modalInertReleases.splice(0).forEach((release) => release());
    const top = topModal();
    let branch = top?.parentElement;
    while (branch?.parentElement && branch.closest('.tx-product')) {
        const parent = branch.parentElement;
        for (const sibling of Array.from(parent.children)) {
            if (sibling instanceof HTMLElement && sibling !== branch)
                modalInertReleases.push(acquireInert(sibling));
        }
        if (parent.classList.contains('tx-product'))
            break;
        branch = parent;
    }
    queueMicrotask(() => {
        if (top !== topModal())
            return;
        if (preferredFocus?.isConnected && !preferredFocus.closest('[inert]') && (!top || top.contains(preferredFocus))) {
            preferredFocus.focus();
            return;
        }
        if (top && !top.contains(document.activeElement)) {
            const initial = top.querySelector<HTMLElement>('[data-initial-focus]');
            focusInitialModalControl(initial ? initial.matches(':disabled') ? top : initial : top.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? top);
        }
    });
}
export function Modal({ title, children, footer, onClose, wide = false, closeLabel = 'Close', variant = 'default', focusReady = true }: {
    title: string;
    children: ReactNode;
    footer?: ReactNode;
    onClose: () => void;
    wide?: boolean;
    closeLabel?: string;
    focusReady?: boolean;
    variant?: 'default' | 'permission' | 'shortcut' | 'payment' | 'update' | 'reader' | 'custom-provider' | 'custom-alert' | 'dictionary-editor' | 'dictionary-delete';
}) {
    const id = useId();
    const ref = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const modal = ref.current;
        if (!modal)
            return;
        modalLayers.set(modal, previous);
        updateModalLayers();
        const focusables = () => Array.from(modal.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter((item) => item.tabIndex >= 0);
        const key = (event: KeyboardEvent) => {
            if (topModal() !== modal || event.defaultPrevented || event.isComposing || event.keyCode === 229)
                return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                if (variant !== 'payment')
                    closeRef.current();
            }
            if (event.key === 'Tab') {
                const targets = focusables();
                const first = targets[0], last = targets[targets.length - 1];
                if (!first) {
                    event.preventDefault();
                    modal.focus();
                    return;
                }
                if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
                    event.preventDefault();
                    last.focus();
                }
                else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };
        document.addEventListener('keydown', key);
        return () => {
            document.removeEventListener('keydown', key);
            modalLayers.delete(modal);
            updateModalLayers(previous);
        };
    }, []);
    useEffect(() => {
        const modal = ref.current;
        if (focusReady && modal && topModal() === modal && document.activeElement === modal && !modal.closest('[inert]'))
            modal.querySelector<HTMLElement>('[data-initial-focus]:not(:disabled)')?.focus();
    }, [focusReady]);
    return <div className="tx-modal-layer"><div className={`tx-modal tx-modal-${variant} ${wide ? 'tx-modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
    <div className="tx-modal-heading">{variant === 'shortcut' && <Brand symbol/>}<h2 id={id}>{title}</h2>{variant === 'default' && <button className="tx-icon-button tx-close" aria-label={closeLabel} onClick={onClose}>×</button>}</div>
    <div className="tx-modal-body">{children}</div>{footer && <div className="tx-modal-footer">{footer}</div>}
  </div></div>;
}
export function UnsavedDialog({ t, onKeep, onDiscard }: {
    t: Translate;
    onKeep: () => void;
    onDiscard: () => void;
}) {
    return <Modal title={t('有未保存的更改', 'You have unsaved changes')} onClose={onKeep} closeLabel={t('继续编辑', 'Keep Editing')} footer={<><button onClick={onDiscard}>{t('不保存', 'Don’t Save')}</button><button className="tx-primary" onClick={onKeep}>{t('继续编辑', 'Keep Editing')}</button></>}>
    <p>{t('本次更改尚未保存。离开后，更改将不会生效。', 'Your changes have not been saved. They will not take effect if you leave.')}</p>
  </Modal>;
}
