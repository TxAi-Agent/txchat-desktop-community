# Security policy

[简体中文](SECURITY.zh-CN.md)

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/TxAi-Agent/txchat-desktop-community/security/advisories/new) for this repository. GitHub explains the reporting process in its [private reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

Do not disclose vulnerabilities, credentials, tokens, personal data, or sensitive recordings in a public issue, pull request, discussion, or attachment. If the private reporting form is unavailable, a public issue may ask only for a private reporting channel; include no vulnerability details or sensitive data.

Include the affected commit or version, platform, a minimal reproduction using synthetic data, expected and observed behavior, and potential impact. Send only the information necessary to reproduce the problem. If a credential was exposed, revoke or rotate it with its provider; do not include the credential in the report.

## Scope

Reports concerning the current client source, Electron IPC boundaries, credential storage, account and payment state handling, native helper interaction, Custom AI endpoint handling, and unintended microphone or text insertion behavior are relevant. Include the dependency version when a report concerns a dependency. There is no promised response time or long-term support schedule for older revisions.

The default service adapter and update backend are unset, and the default recognition provider reports that it is unconfigured. Local development does not create an account, service token or payment entitlement. Fixed-text recognition is an explicitly selected demonstration.

Native capture requires operating-system permissions and handles real microphone samples. Native insertion requires opt-in and can affect another application. Custom AI and developer-provided adapters can transmit audio, text or account data to their configured services. Review and disclose those data flows, keep credentials out of renderer state and logs, and honor cancellation. No backend or operational service security is supplied by the client source. An implemented update backend must verify update metadata and artifact authenticity before installation.
