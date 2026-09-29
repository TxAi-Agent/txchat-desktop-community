import { useEffect, useId, useRef, useState } from 'react';
import { allowanceText, currentMembership, usageProgress } from '../../domain/billing-presentation';
import type { ProductSnapshot } from '../../shared/product';
import { Icon, type Translate } from './ui';
import './billing-usage.css';
export function BillingUsage({ product, t, onOpen }: {
    product: ProductSnapshot;
    t: Translate;
    onOpen: () => void;
}) {
    const [help, setHelp] = useState(false), id = useId();
    const root = useRef<HTMLElement>(null), button = useRef<HTMLButtonElement>(null);
    const { status: cachedStatus, offer, statusDisplayError: error } = product.billing;
    const status = error ? null : cachedStatus;
    const percent = usageProgress(status, offer, !!error);
    useEffect(() => {
        if (!help)
            return;
        const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target))
            setHelp(false); };
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !root.current?.closest('[inert]')) {
            event.preventDefault();
            event.stopPropagation();
            setHelp(false);
            button.current?.focus();
        } };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape, true);
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
    }, [help]);
    const rows = [
        [t('用量从哪里来', 'Where usage comes from'), t('新账号试用时长与会员套餐时长。', 'Trial time and membership time.'), 'clock'],
        [t('如何消耗', 'How it is used'), t('使用 TxChat 云端语音服务时按实际时长消耗。', 'TxChat Cloud voice usage consumes available time.'), 'wave'],
        [t('用完怎么办', 'When time runs out'), t('可进入会员套餐获取更多用量；自定义模型不受影响。', 'Get more usage from Membership. Custom models remain available.'), 'plus'],
        [t('什么时候刷新', 'When it refreshes'), t('免费额度一次性发放，不自动恢复；会员额度按服务端周期刷新，未用完不结转。', 'Free usage is granted once and does not reset. Membership usage refreshes each server period and does not roll over.'), 'refresh'],
    ];
    return <aside ref={root} className="tx-billing-usage">
    <span className="tx-billing-allowance" title={allowanceText(status, !!error, product.preferences.language)}>{allowanceText(status, !!error, product.preferences.language)}</span>
    <button ref={button} className="tx-billing-help" aria-label={t('用量说明', 'Usage help')} aria-expanded={help} aria-controls={help ? id : undefined} onClick={() => setHelp(!help)}><Icon name="quota-help"/></button>
    <div className="tx-billing-progress" role="progressbar" aria-label={t('剩余用量', 'Usage remaining')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.trunc(percent)}>
      {percent > 0 && <span style={{ width: Math.max(6, 150 * percent / 100) }}/>}
    </div>
    <button className="tx-primary tx-billing-action" onClick={() => { setHelp(false); onOpen(); }}>{currentMembership(status) ? t('使用情况', 'Usage Details') : <><Icon name="membership"/>{t('获取更多用量', 'Get More Usage')}</>}</button>
    {help && <div className="tx-billing-popover" id={id} role="dialog" aria-label={t('用量说明', 'About Usage')}><h2>{t('用量说明', 'About Usage')}</h2>{rows.map(([title, detail, icon]) => <div className="tx-billing-help-row" key={title}>
      <svg viewBox="0 0 20 20" aria-hidden="true">{icon === 'clock' ? <><circle cx="9" cy="9" r="6"/><path d="M9 5v4l3 2m0 4 2 2 4-5"/></> : icon === 'wave' ? <path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4"/> : icon === 'plus' ? <><circle cx="10" cy="10" r="7"/><path d="M10 6v8m-4-4h8"/></> : <><path d="M15 6a6 6 0 1 0 1 6M15 2v5h-5"/></>}</svg>
      <div><h3>{title}</h3><p>{detail}</p></div>
    </div>)}</div>}
  </aside>;
}
