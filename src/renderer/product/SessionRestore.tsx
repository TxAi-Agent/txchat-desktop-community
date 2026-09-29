import type { AuthSnapshot } from '../../shared/product';
import { Brand, type Dispatch, type Translate } from './ui';
export function SessionRestore({ auth, command, t }: {
    auth: AuthSnapshot;
    command: Dispatch;
    t: Translate;
}) {
    const automatic = ['NETWORK_UNAVAILABLE', 'REQUEST_TIMEOUT', 'SERVICE_UNAVAILABLE', 'TOO_MANY_REQUESTS'].includes(auth.error?.code ?? '');
    const run = (type: 'auth-restore' | 'auth-logout') => { void command({ type }).catch(() => undefined); };
    return <section className="tx-launching" aria-label={t('恢复登录', 'Restore Sign-in')} data-testid="login.restore">
    <Brand symbol/>
    <p role="status">{auth.busy ? t('正在恢复登录…', 'Restoring your sign-in…') : t('登录信息已保存', 'Your sign-in is saved')}</p>
    {!auth.busy && <p>{automatic ? t('暂时无法连接，将自动重试。', 'Connection unavailable. Retrying automatically.') : t('暂时无法恢复登录，请重试。', 'Unable to restore your sign-in. Please try again.')}</p>}
    <button className="tx-primary" disabled={auth.busy} onClick={() => run('auth-restore')}>{t('重新连接', 'Reconnect')}</button>
    <button onClick={() => run('auth-logout')}>{t('使用其他账号', 'Use another account')}</button>
  </section>;
}
