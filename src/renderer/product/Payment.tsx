import { useMemo, useState } from 'react';
import { paymentCountdownKey, paymentPresentation } from '../../domain/payment-presentation';
import type { ProductSnapshot } from '../../shared/product';
import { Modal, useNow, type Dispatch, type Translate } from './ui';
import { FittedText } from './FittedText';
import './payment.css';
export function Payment({ product, command, t }: {
    product: ProductSnapshot;
    command: Dispatch;
    t: Translate;
}) {
    const { billing } = product, key = paymentCountdownKey(billing), now = useNow();
    const observedAt = useMemo(() => Date.now(), [key]);
    const [failedQR, setFailedQR] = useState<string | null>(null);
    const view = paymentPresentation(billing, product.preferences.language, (now - observedAt) / 1000, !!billing.payment.order?.codeUrl && (!billing.payment.qrDataUrl || failedQR === billing.payment.qrDataUrl));
    const close = () => { void command({ type: 'payment-close' }).catch(() => undefined); };
    const refresh = () => { setFailedQR(null); void command({ type: 'payment-recover' }).catch(() => undefined); };
    const action = view.inlineAction && <button className="tx-payment-inline" disabled={billing.payment.busy} onClick={refresh}>{view.inlineAction}</button>;
    return <Modal variant="payment" title={view.screenTitle} onClose={close} closeLabel={t('关闭', 'Close')}>
    <div className="tx-payment-divider" aria-hidden="true"/>
    <h3 className="tx-payment-product">{view.productName}</h3>
    <p className={`tx-payment-description ${view.scanWarning ? 'has-warning' : ''}`}>{view.scanWarning ? view.detail : <FittedText size={12} minimumScale={0.8}>{view.productDescription}</FittedText>}</p>
    <div className="tx-payment-amount" aria-label={`${view.prefix}${view.amount}`}><span>{view.prefix}</span><strong>{view.amount}</strong></div>
    <div className={`tx-payment-graphic ${view.state === 'success' ? 'is-success' : ''}`}>
      {view.state === 'scan' && view.qr ? <img src={view.qr} width={200} height={200} alt={t('微信支付二维码', 'WeChat payment QR code')} title={view.detail} onError={() => setFailedQR(view.qr)}/>
            : <span key={view.state} className={`tx-payment-glyph ${view.busy ? 'is-busy' : 'is-terminal'}`} aria-hidden="true"><svg viewBox="0 0 40 40">
          {view.state === 'success' ? <path d="m9 21 7 7L31 12"/> : view.state === 'uncertain' || view.state === 'unconfirmed' ? <><path d="M13 13c0-9 16-9 16 0 0 6-9 6-9 12"/><path d="M20 31v1"/></>
                    : view.state === 'incomplete' ? <path d="M20 8v16m0 7v1"/>
                        : view.state === 'expired' ? <><path d="M21 32A13 13 0 1 1 33 18M19 11v9l-6 3"/><circle cx="30" cy="29" r="8"/><path d="M30 24v5m0 4v.2"/></>
                            : view.busy ? <><path d="M31 15A12 12 0 0 0 10 11M31 7v9h-9M9 25a12 12 0 0 0 21 4M9 33v-9h9"/></>
                                : <><path d="M31 14A13 13 0 1 0 32 26M31 6v9h-9"/><path d="M19 12v9l5 3"/></>}
        </svg></span>}
    </div>
    {view.state !== 'scan' ? <div className="tx-payment-feedback" role="status"><h4>{view.title}</h4><p>{view.detail}</p>{action}</div> : action && <div className="tx-payment-scan-action">{action}</div>}
    <p className={`tx-payment-countdown ${view.orderReference ? 'tx-payment-order-reference' : ''}`}>{view.orderReference ?? view.countdown}</p>
    <button className="tx-payment-close" onClick={close}>{t('关闭', 'Close')}</button>
  </Modal>;
}
