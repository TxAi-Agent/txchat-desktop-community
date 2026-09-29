# Extending the client / 扩展客户端

The repository contains the client and both native helper implementations. It includes no corresponding backend. The extension points below are TypeScript contracts inside the client, not an HTTP or WebSocket protocol specification. Implement and configure the services you need, then rebuild the client.

## Account, billing and diagnostic services

Implement [`ServiceAdapter`](../src/adapters/services/integration.ts) and return it from `createServiceAdapter()`. The default return value is `null`. The main process constructs `new CloudClient(createServiceAdapter())`; an unconfigured client fails service operations with `CLOUD_NOT_CONFIGURED`.

The interface covers verification challenges, verification, session refresh, account context, sign-out, offers and usage, current and new orders, order recovery, and diagnostic submission. It returns client domain values such as `SessionBundle`, `BillingOffer` and `BillingOrder`. No endpoint, server implementation, service credentials or product identifier is supplied.

`scope` is a stable configuration label, not a URL or account identifier. Use a different scope when switching service account realms so saved sessions cannot be reused in a different realm. Implement refresh and payment idempotency for repeated request IDs, propagate cancellation, and map service failures to the documented `CloudError` codes. Return service-controlled expiry and retry values; do not treat client clocks or a QR display as proof of payment.

Local development mode has `demo: true`, `signedIn: false`, no account identity and no service token. It provides local client access only. Keep authenticated service operations gated separately; local mode must not grant membership or payment access.

## Recognition

[`createRecognitionProvider()`](../src/adapters/recognition-provider.ts) returns `UnconfiguredRecognitionProvider` by default. Attempting recognition through that provider fails with `RECOGNITION_NOT_CONFIGURED`. Implement `RecognitionProvider` and return your implementation to connect a model or service:

```ts
interface RecognitionStream {
  write(pcm: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  dispose(): void;
}

interface RecognitionProvider {
  readonly configured?: boolean;
  createStream(options: {
    signal: AbortSignal;
    onPartial: (text: string) => void;
    mode?: 'smart' | 'verbatim';
  }): RecognitionStream;
}
```

PCM input is 16 kHz, mono, signed 16-bit little-endian audio. `write` consumes a chunk before its promise resolves; copy it first if your implementation needs to retain it. `finish` returns final text and `dispose` releases resources. Honor the abort signal and discard late results. The main process owns the provider; do not place credentials or recognition execution in the renderer.

The explicit **local** service uses a fixed-text demonstration. `DemoRecognitionProvider` is also available for deliberate development use. Neither performs real speech recognition or runs an AI model. Native microphone capture can still collect real PCM while using a demonstration provider. The default unconfigured provider does not silently fall back to demonstration text.

To exercise native recognition, compile the helper, start it through the app, grant microphone access, and select the intended service. Native shortcut input also requires its platform permissions and explicit enablement. Use an empty target document when testing insertion.

## Custom AI

The Custom AI client code is in [`src/adapters/custom-ai`](../src/adapters/custom-ai/index.ts), with editable provider definitions in [`src/shared/custom-ai.ts`](../src/shared/custom-ai.ts). The user supplies an endpoint, model selection and any required credentials. There is no built-in endpoint URL.

Check that the chosen endpoint accepts the request format implemented for that provider. The source does not guarantee a model's availability or compatibility. Custom AI can send audio or text to the configured endpoint when invoked; it is not the offline demonstration. Keep secrets in main-process storage, retain endpoint validation, and explain data processing and any service charges to users before they enable it.

## Updates

[`createUpdateBackend()`](../src/main/update-integration.ts) returns `null` by default. The update interface and state machine remain available, but there is no working update distribution behind them. Implement [`SoftwareUpdateBackend`](../src/main/software-update-coordinator.ts) for your own application to support checking, downloading, installation and cleanup.

Validate update metadata and artifact authenticity, preserve cancellation and application shutdown coordination, and test installation failure handling. Do not implement updates as an unchecked download-and-execute operation. Supplying an update backend is separate from providing source builds.

## Native development and checks

```sh
npm run build:native
npm run build
npm run test:helper
npm run test:desktop
npm start
```

Use Xcode Command Line Tools, including Swift and Clang, on macOS 14+ arm64, or the .NET 10 SDK on Windows 11 x64. The macOS build also compiles the platform integration module using installed Node-API headers. No second source repository is needed.

The automated desktop checks use Electron through Playwright and need no Playwright browser download. Tests use synthetic data and protocol operations; they do not record microphone audio or insert text into user applications. Test permissions, audio devices, shortcuts and foreground insertion separately and deliberately.

Windows leaves submitted text on the clipboard after paste; macOS attempts to restore the previous clipboard contents. Do not assume identical clipboard behavior or successful insertion in every application. Custom integrations must preserve cancellation, target validation and cleanup safeguards.

## 中文说明

本仓库包含客户端和双端原生辅助程序，不包含对应后端。以上扩展入口是客户端内部的 TypeScript 契约，不是 HTTP 或 WebSocket 协议规范。开发者需自行实现和配置所需服务，然后重新构建。

**账号、会员、支付与诊断：** 实现 [`ServiceAdapter`](../src/adapters/services/integration.ts)，并由 `createServiceAdapter()` 返回。默认返回 `null`，`CloudClient` 的服务操作会报 `CLOUD_NOT_CONFIGURED`。接口覆盖验证码挑战与验证、会话刷新、账号上下文、退出、套餐与用量、订单创建与查询、订单恢复和诊断提交，返回客户端领域类型。本仓库不提供端点、服务实现、凭据或产品编号。`scope` 是稳定的配置标签，不是 URL 或账号；切换账号体系时应使用不同标签。适配器须处理刷新和支付操作的幂等键、取消及错误映射，不能把客户端时钟或二维码显示当成支付成功依据。

**本地开发会话：** `demo: true`、`signedIn: false`，没有账号身份或服务令牌。它只开放本地客户端功能；已登录服务操作仍须独立受控，不能赋予会员或支付权益。

**识别：** [`createRecognitionProvider()`](../src/adapters/recognition-provider.ts) 默认返回未配置实现，识别报 `RECOGNITION_NOT_CONFIGURED`。自定义实现接收 16 kHz、单声道、有符号 16 位小端 PCM；`write` 返回前应消费音频块，如需保留须自行复制；`finish` 返回最终文字，`dispose` 释放资源。遵守取消信号，丢弃迟到结果。适配器由主进程持有，不应把凭据或识别执行放进渲染进程。

主动选择 **local 本地服务**才使用固定文本演示，也可主动选用 `DemoRecognitionProvider` 开发。它们不是真实 ASR，也不运行模型；配合原生采集时仍可能使用真实麦克风 PCM。未配置的默认实现不会悄悄回退为演示结果。真实识别需自行实现服务或模型接入。

**自定义 AI：** 用户自行填写端点、选择模型并提供所需凭据，没有内置端点 URL。应核对端点是否支持对应请求格式，不能将模型列表视为兼容或可用承诺。调用自定义 AI 时可能向配置端点发送音频或文字，不能描述为离线演示。保留主进程凭据存储与端点校验，并在启用前说明数据处理及可能的服务费用。

**更新：** [`createUpdateBackend()`](../src/main/update-integration.ts) 默认返回 `null`，只保留更新界面和状态机。开发者可为自己的应用实现 `SoftwareUpdateBackend`，但必须验证元数据和更新文件真实性，保留取消、退出协调及失败处理，不能直接下载后无校验执行。

**原生开发：** 使用上面的构建和检查命令。Mac 需要 macOS 14+ arm64 和包含 Swift、Clang 的 Xcode Command Line Tools；Windows 需要 Windows 11 x64 和 .NET 10 SDK。Mac 还会使用已安装的 Node-API 头文件编译平台集成模块。无需另一个源码仓库。

自动化检查使用合成数据与协议操作，不录音，也不向用户应用写入文字。权限、音频设备、快捷键和前台写入需要单独主动验证。Windows 粘贴后保留已提交文字；macOS 尝试恢复原剪贴板。自定义集成应保留取消、目标校验及资源清理保护。
