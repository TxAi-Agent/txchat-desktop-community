import type { DocumentKind, ProductDocument } from '../shared/documents';

// Developer-build text, separate from any hosted service's legal documents.
const copy = {
  en: {
    privacy: ['Privacy', 'This developer build stores preferences and a replacement dictionary on this device. Credentials entered by you are encrypted with supported operating-system storage. No service is configured by default.', 'Microphone capture and input permissions are controlled by the operating system. A provider you configure may receive audio or text; review its implementation and privacy policy before use. Diagnostic reports require your confirmation.'],
    terms: ['Terms', 'This source project is provided under the Apache License 2.0, without warranties. See LICENSE in the repository for the complete terms. TxChat brand rights are reserved separately.', 'Developers are responsible for the services, accounts, payments and update channels they configure. This developer build does not supply those services.'],
    cloud: ['Service configuration', 'A service adapter is required for account login, SMS verification, membership and payment. Implement the ServiceAdapter interface and connect your own backend.', 'Speech recognition and software updates have separate integration factories. Missing integrations remain unavailable and do not connect to a built-in service.'],
    guide: ['Getting started', 'Use local mode to explore the full interface without an account. Build the native helper to use microphone capture and global shortcuts; grant permissions only when you want to test those functions.', 'Local simulation returns demonstration text. For real transcription, configure a custom provider endpoint and your own credentials, or implement a recognition provider. Native input can paste into another application.'],
    about: ['About TxChat', 'An open-source desktop client for macOS and Windows, with configurable service integrations.', 'Read README, CONTRIBUTING and SECURITY in the repository for build, development and vulnerability-reporting information.'],
  },
  zh: {
    privacy: ['隐私说明', '开发版在本机保存偏好设置和替换词典。你填写的凭据通过受支持的操作系统存储加密，默认不配置任何服务。', '麦克风采集和输入权限由操作系统控制。自行配置的识别服务可能接收音频或文本，使用前请审查其实现及隐私政策。诊断报告须经你确认才发送。'],
    terms: ['使用说明', '本项目源码按 Apache License 2.0 提供，不附带保证，完整条款见仓库 LICENSE。TxChat 品牌权利单独保留。', '开发者负责自己配置的服务、账号、支付和更新渠道。本开发版不提供这些服务。'],
    cloud: ['服务配置', '账号登录、短信验证、会员与支付需要服务适配器。请实现 ServiceAdapter 接口并接入自己的后端。', '语音识别和软件更新分别提供独立接入入口。未配置的功能会提示不可用，不会连接内置服务器。'],
    guide: ['使用指南', '无需账号即可进入本地模式查看完整界面。使用麦克风和全局快捷键前，请构建原生辅助程序，并按需授予系统权限。', '本地模拟返回示例文本。真实转写需要填写自定义服务地址和自己的凭据，或实现识别服务接口。原生输入会向其他应用粘贴文本。'],
    about: ['关于 TxChat', '面向 macOS 和 Windows 的开源桌面客户端，服务集成由开发者自行配置。', '构建、二次开发和漏洞报告方式见仓库 README、CONTRIBUTING 和 SECURITY。'],
  },
};
export async function loadDocument(kind: DocumentKind, language: 'zh' | 'en'): Promise<ProductDocument> {
  const [title, ...paragraphs] = copy[language][kind];
  return { kind, language, title, blocks: paragraphs.map(text => ({ kind: 'paragraph', text })) };
}
