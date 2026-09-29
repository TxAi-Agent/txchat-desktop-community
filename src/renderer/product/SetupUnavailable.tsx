import { Brand, type Translate } from './ui';
export function SetupUnavailable({ t, enterLocal, showLogin }: {
    t: Translate;
    enterLocal: () => void;
    showLogin: () => void;
}) {
    return <section className="tx-setup-unavailable" aria-label={t('服务尚未配置', 'Service Not Configured')} data-testid="setup.unavailable">
    <Brand symbol/>
    <h1>{t('服务尚未配置', 'Service Not Configured')}</h1>
    <p>{t('尚未配置服务适配器。请按开发文档接入自有服务后重新构建，或使用本地功能。', 'No service adapter is configured. Follow the development documentation to connect your own service and rebuild, or use local features.')}</p>
    <p>{t('登录、会员、支付和云端识别需要相应服务；本地开发会话不会创建账号或购买权益。', 'Sign-in, membership, payments and cloud recognition require their service integrations. A local development session does not create an account or purchase access.')}</p>
    <div className="tx-setup-actions"><button className="tx-primary" onClick={enterLocal}>{t('进入本地开发界面', 'Open Local Development')}</button><button onClick={showLogin}>{t('查看登录界面', 'View Login')}</button></div>
  </section>;
}
