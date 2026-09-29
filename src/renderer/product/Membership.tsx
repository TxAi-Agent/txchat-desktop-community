import { membershipPresentation } from '../../domain/membership-presentation';
import type { ProductSnapshot } from '../../shared/product';
import { type Dispatch, type Translate } from './ui';
import { FittedText } from './FittedText';
import './membership.css';
export function Membership({ product, t, command, disabled, onBack }: {
    product: ProductSnapshot;
    t: Translate;
    command: Dispatch;
    disabled: boolean;
    onBack: () => void;
}) {
    const view = membershipPresentation(product.billing, product.preferences.language);
    const current = view.state === 'active' || view.state === 'exhausted';
    return <section className="tx-membership-screen" aria-label={view.title} data-state={view.state}>
    <h1><FittedText size={17} minimumScale={0.8}>{view.title}</FittedText></h1><p className="tx-membership-subtitle"><FittedText size={12} minimumScale={0.72}>{view.subtitle}</FittedText></p>
    {!product.environment.configured && <p className="tx-membership-service-note" role="status">{t('会员与支付服务尚未配置。请接入自有服务适配器后重新构建；此处不会创建订单。', 'Membership and payment services are not configured. Connect your service adapter and rebuild. No order will be created here.')}</p>}
    <div className="tx-membership-divider" aria-hidden="true"/>
    <div className="tx-membership-column tx-membership-free">
      <h2><FittedText size={22} minimumScale={0.64}>{view.freeTitle}</FittedText></h2><div className="tx-membership-price" aria-label="¥0"><span>¥</span><strong>0</strong></div>
      <button className="tx-membership-action" disabled>{product.environment.configured ? view.freeAction : t('尚未配置', 'Not configured')}</button>
      <ul>{view.freeBenefits.map((benefit) => <li key={benefit}>{benefit}</li>)}</ul>
    </div>
    <div className={`tx-membership-column tx-membership-paid ${current ? 'is-current' : ''}`}>
      <h2 title={view.productName}><FittedText size={22} minimumScale={0.64}>{view.productName}</FittedText></h2>
      <div className="tx-membership-price" aria-label={`${view.price.prefix}${view.price.value}${view.period}`}>
        <span>{view.price.prefix}</span><strong className={view.price.value.length > 12 ? 'tx-membership-price-unavailable' : ''}>{view.price.value}</strong><small>{view.period}</small>
      </div>
      <button className="tx-membership-action" disabled={disabled || product.billing.loading || (product.billing.payment.busy && view.command !== 'payment-refresh') || !view.enabled || product.auth.demo || !product.environment.configured} onClick={() => { if (view.command)
        void command({ type: view.command }).catch(() => undefined); }}>
        {current && <span className="tx-membership-current-icon" aria-hidden="true"/>}{product.environment.configured ? view.action : t('尚未配置', 'Not configured')}
      </button>
      <ul>{view.benefits.map((benefit) => <li key={benefit}>{benefit}</li>)}</ul>
    </div>
    {current && view.expiration && <p className="tx-membership-expiration" title={view.expiration}><FittedText size={14} minimumScale={0.72}>{view.expiration}</FittedText></p>}
    <button className="tx-membership-back" onClick={onBack}>{t('返回', 'Back')}</button>
  </section>;
}
