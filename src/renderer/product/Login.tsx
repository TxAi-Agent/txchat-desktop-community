import { useEffect, useRef, useState } from 'react';
import { pastedVerificationCode } from '../../domain/windows-login-code-paste';
import type { AppSnapshot } from '../../shared/contracts';
import type { ProductSnapshot } from '../../shared/product';
import { formatLoginPhone, formatLoginCode, loginDigits, loginPhoneDigits, loginPresentation } from '../../domain/login-presentation';
import { Brand, Icon, shortcutName, useNow, type Dispatch, type Translate } from './ui';
import './login.css';
export function Login({ platform = 'darwin', product, command, t, phone, setPhone, accepted, setAccepted, onBackToSetup }: {
    platform?: AppSnapshot['platform'];
    product: ProductSnapshot;
    command: Dispatch;
    t: Translate;
    phone: string;
    setPhone: (phone: string) => void;
    accepted: boolean;
    setAccepted: (accepted: boolean) => void;
    onBackToSetup?: () => void;
}) {
    const [code, setCode] = useState('');
    const [localError, setLocalError] = useState<'send' | 'verify' | null>(null);
    const [pasteError, setPasteError] = useState(false);
    const [pending, setPending] = useState<'send' | 'verify' | null>(null);
    const codeRef = useRef<HTMLInputElement>(null);
    const codeGeneration = useRef(product.auth.codeResetGeneration);
    const focusGeneration = useRef(product.auth.codeFocusGeneration);
    const requestedPhone = useRef('');
    const operationGeneration = useRef(0);
    const now = useNow();
    const auth = localError ? { ...product.auth, error: { code: 'OPERATION_FAILED' }, loginErrorSource: localError } : product.auth;
    const presentation = loginPresentation({ auth, phone, code, accepted, language: product.preferences.language, now });
    const canVerify = presentation.canVerify && requestedPhone.current === loginPhoneDigits(phone) && pending === null;
    const canRequest = presentation.canRequestCode && pending !== 'send';
    useEffect(() => {
        if (codeGeneration.current !== product.auth.codeResetGeneration) {
            codeGeneration.current = product.auth.codeResetGeneration;
            setCode('');
            setPasteError(false);
        }
    }, [product.auth.codeResetGeneration]);
    useEffect(() => {
        if (focusGeneration.current !== product.auth.codeFocusGeneration) {
            focusGeneration.current = product.auth.codeFocusGeneration;
            codeRef.current?.focus();
        }
    }, [product.auth.codeFocusGeneration]);
    const run = (value: Parameters<Dispatch>[0]) => { void command(value).catch(() => setLocalError('verify')); };
    const submit = async (operation: 'send' | 'verify') => {
        if (operation === 'send' ? !canRequest : !canVerify)
            return;
        const generation = ++operationGeneration.current;
        setLocalError(null);
        setPasteError(false);
        setPending(operation);
        if (operation === 'send') {
            requestedPhone.current = loginPhoneDigits(phone);
            setCode('');
        }
        try {
            await command(operation === 'send' ? { type: 'auth-send', phone: loginPhoneDigits(phone), acceptedTerms: accepted } : { type: 'auth-verify', code: loginDigits(code), acceptedTerms: accepted });
        }
        catch {
            if (operationGeneration.current === generation)
                setLocalError(operation);
        }
        finally {
            if (operationGeneration.current === generation)
                setPending(null);
        }
    };
    const requesting = auth.requestingSMS || pending === 'send';
    const verifying = auth.verifyingSMS || pending === 'verify';
    const credentialError = ['invalidCredential', 'verificationLocked'].includes(presentation.visualState);
    return <section className="tx-login tx-login-parity" aria-label={t('登录', 'Log In')} data-testid="login.screen">
    {!product.environment.configured && <div className="tx-login-configuration-note" role="status"><p>{t('登录服务适配器尚未配置。请接入自有服务后重新构建，或进入本地开发界面。', 'The sign-in service adapter is not configured. Connect your own service and rebuild, or open local development.')}</p><div className="tx-setup-actions">{onBackToSetup && <button type="button" onClick={onBackToSetup}>{t('返回', 'Back')}</button>}<button type="button" onClick={() => run({ type: 'demo-enter' })}>{t('进入本地开发界面', 'Open Local Development')}</button></div></div>}
    <div className="tx-login-symbol"><Brand symbol/></div>
    <p className="tx-login-welcome">{t('欢迎使用 ', 'Welcome to ')}<span>TxChat</span></p>
    <h1 className="tx-login-title">{t('有想法就要\n说出来', 'Just say it\nout loud')}</h1>
    <span className="tx-login-privacy" aria-label={t(`说话，比打字更快。快捷键 ${shortcutName(product.preferences.shortcut)}`, `Talk faster than typing. Shortcut ${shortcutName(product.preferences.shortcut)}`)}><span />{t('说话，比打字更快', 'Talk — faster than typing')}</span>
    <form className="tx-login-controls" onSubmit={(event) => { event.preventDefault(); void submit('verify'); }}>
      <label className="tx-visually-hidden" htmlFor="tx-login-phone">{t('手机号码', 'Phone number')}</label>
      <div className={`tx-login-phone${phone ? ' tx-login-phone-entered' : ''}`}>
        <span>+86</span><input id="tx-login-phone" inputMode="tel" autoComplete="tel-national" placeholder={t('请输入手机号', 'Enter phone number')} value={phone} onChange={(event) => { const value = formatLoginPhone(event.target.value); setPhone(value); setCode(''); setLocalError(null); setPasteError(false); operationGeneration.current++; setPending(null); run({ type: 'auth-phone-edited', phone: loginPhoneDigits(value) }); }}/>
      </div>
      <label className="tx-visually-hidden" htmlFor="tx-login-code">{t('验证码', 'Verification code')}</label>
      <div className={`tx-login-credential${credentialError ? ' tx-login-credential-error' : ''}`}>
        <input id="tx-login-code" ref={codeRef} inputMode="numeric" autoComplete="one-time-code" placeholder={t('输入 6 位验证码', 'Enter 6-digit code')} value={code} aria-invalid={credentialError} aria-label={t('请输入短信中的 6 位验证码', 'Enter the six-digit code from the text message')} onPaste={platform === 'win32' ? (event) => {
            event.preventDefault();
            const value = pastedVerificationCode(event.clipboardData.getData('text/plain'));
            if (value === null) {
                setPasteError(true);
                return;
            }
            setCode(formatLoginCode(value));
            setLocalError(null);
            setPasteError(false);
            run({ type: 'auth-code-edited', code: value });
        } : undefined} onChange={(event) => { const value = formatLoginCode(event.target.value); setCode(value); setLocalError(null); setPasteError(false); run({ type: 'auth-code-edited', code: loginDigits(value) }); }}/>
        <button type="button" className={`${canRequest || presentation.locked ? 'tx-login-request-active' : ''}${presentation.visualState === 'invalidCredential' ? ' tx-login-request-invalid' : ''}`} disabled={!canRequest} onClick={() => void submit('send')}>
          {requesting ? t('获取中…', 'Getting…') : presentation.requestTitle}
        </button>
      </div>
      <div className="tx-login-agreement"><input id="tx-login-terms" type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)}/><label htmlFor="tx-login-terms">{t('同意', 'Agree to')}</label>
        <button type="button" onClick={() => run({ type: 'document-open', document: 'terms' })}>{t('《服务条款》', 'Terms of Service')}</button><span>{t('和', 'and')}</span>
        <button type="button" onClick={() => run({ type: 'document-open', document: 'privacy' })}>{t('《隐私说明》', 'Privacy Policy')}</button>
      </div>
      <button className={`tx-login-primary${canVerify || presentation.locked ? ' tx-login-primary-enabled' : ''}`} type="submit" disabled={!canVerify}>{verifying ? t('正在登录…', 'Signing in…') : t('登录', 'Log In')}</button>
    </form>
    {pasteError ? <div role="status" aria-live="polite" className="tx-login-compact-toast">
      <span className="tx-login-warning" aria-hidden="true">!</span><span>{t('请仅复制一个 6 位验证码后粘贴', 'Copy one six-digit verification code and paste again')}</span>
    </div> : presentation.message && <div role="status" aria-live="polite" className={presentation.placement === 'topSMS' ? 'tx-login-sms-pill' : 'tx-login-compact-toast'} style={presentation.pillWidth ? { width: presentation.pillWidth } : undefined}>
      {presentation.placement === 'topSMS' ? <Icon name="info"/> : <span className="tx-login-warning" aria-hidden="true">!</span>}<span>{presentation.message}</span>
    </div>}
  </section>;
}
