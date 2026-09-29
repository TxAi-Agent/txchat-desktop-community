# TxChat Desktop Community

[简体中文](README.zh-CN.md)

An Electron and TypeScript desktop dictation client with macOS and Windows native helper source in one repository. The source includes the client interface, dictation lifecycle, account and membership flows, payment QR handling, Custom AI configuration, dictionary, preferences, tray and floating windows, diagnostics, and update coordination.

This is a developer source distribution. Keeping a feature's interface and state machine does not supply the service behind it. No backend repository, hosted account service, speech model, payment integration, or update distribution is included. The default service, recognition, and update integrations are unconfigured.

## Get started

Install Node.js 24 with npm, then run these commands from the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

`npm ci` downloads dependencies. `npm start` rebuilds before launching the app. On the setup screen, select **Open Local Development** to explore the client without an account. This local session creates no account or service token. You can view the client pages and use local dictionary and preference features without a backend or native helper.

## Included code and default behavior

| Area | Included client code | Default behavior |
| --- | --- | --- |
| Desktop interface | Main window, status, membership, Custom AI, dictionary, preferences, tray, floating windows | Available for local development; native interactions require the matching helper |
| Account | Sign-in, verification, session restoration, token refresh and sign-out | Service adapter is unconfigured |
| Membership and payments | Offers, usage, order state, QR display and recovery | Requires your own account and billing service; no order is created by the local session |
| Recognition | Dictation state machine, cancellation, audio capture and provider interface | Recognition provider is unconfigured; no genuine ASR or model is bundled |
| Custom AI | Provider configuration and request handling | Supply your own endpoint and credentials; there is no built-in endpoint URL |
| Diagnostics and updates | Client reporting and update state machines | Diagnostic service and update backend require developer implementation |

Selecting the **local** service explicitly enables a fixed-text demonstration. It is not speech recognition. When used with a native helper, the demonstration can capture real microphone PCM in memory while still returning fixed text. Browsing the local client and capturing microphone audio are separate operations.

Developers can implement the typed integration points described in [extensions](docs/extensions.md). A service or model listed in a configuration interface is not a promise of compatibility or availability. Operating a connected application requires implementing and validating the integrations appropriate to that application.

## Optional native helpers

| Platform | Native build requirements |
| --- | --- |
| macOS 14 or later, Apple silicon (arm64) | Xcode Command Line Tools, including Swift and Clang |
| Windows 11, x64 | .NET 10 SDK |

```sh
npm run build:native
```

The helper and platform integration source are included here; no second source repository is required. Start the helper through the app's native controls and grant the relevant system permissions before using microphone capture, native shortcuts, or text insertion.

Native text insertion is opt-in and can write to the foreground application. Use an empty document when exploring it. Windows leaves submitted text on the clipboard; macOS attempts to restore the previous contents. Compilation alone does not establish runtime behavior for every target application.

This repository distributes source, original graphical assets, and build instructions. It does not distribute installers, prebuilt helpers, installed dependency bundles, or CI build artifacts.

## Contribute and report problems

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development commands and the source-file manifest. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License and name

The project's original code, documentation, and included original assets are licensed under [Apache License 2.0](LICENSE). Third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Copyright licensing does not grant trademark rights to the TxChat name or branding. See [TRADEMARKS.md](TRADEMARKS.md). A [non-authoritative Chinese license explanation](LICENSE.zh-CN.md) is also available.
