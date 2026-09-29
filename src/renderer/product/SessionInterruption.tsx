import type { ProductSnapshot } from '../../shared/product';
import { sessionInterruption } from '../../domain/session-interruption';
import { FittedText } from './FittedText';
import { Brand, Icon, type Dispatch, type Translate } from './ui';
import './session-interruption.css';
export function SessionInterruption({ product, command, t }: {
    product: ProductSnapshot;
    command: Dispatch;
    t: Translate;
}) {
    if (!product.auth.interruption)
        return null;
    const view = sessionInterruption(product.auth.interruption, product.preferences.language);
    return <section className="tx-session-interruption" aria-label={view.title}>
    <div className="tx-session-language"><Icon name="globe"/>{t('English', '中文')}</div>
    <div className="tx-session-brand"><Brand symbol/></div><span className="tx-session-account">{t('未登录', 'Not Logged In')}</span>
    <div className="tx-session-status"><i aria-hidden="true"/>{view.status}</div>
    <h1><FittedText size={36} minimumScale={.78}>{view.title}</FittedText></h1>
    <p className="tx-session-detail">{view.detail}</p>
    <div className={`tx-session-illustration is-${view.illustration}`} aria-hidden="true"/>
    <button className="tx-primary tx-session-login" disabled={product.auth.busy} onClick={() => void command({ type: 'auth-reauthenticate' }).catch(() => undefined)}>{view.action}</button>

    <div className="tx-session-menu">
      <button><Icon name="sparkles"/>{t('AI 识别服务', 'AI Services')}</button><button><Icon name="keyboard"/>{t('快捷键', 'Shortcut')}</button><button><Icon name="dictionary"/>{t('词典', 'Dictionary')}</button><button><Icon name="info"/>{t('关于 TxChat', 'About TxChat')}</button>
    </div>
  </section>;
}
