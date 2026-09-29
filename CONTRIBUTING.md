# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Contributions to the community app, native helpers, tests, and documentation are welcome. For a larger change, open an issue describing the intended behavior and platform scope before implementation.

## Development

Use Node.js 24 and npm. From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

After building, run `npm run test:desktop` for the offline Electron interface checks and `npm run check:public` for source-file, dependency-source, and content checks. The desktop checks use Electron through Playwright; no Playwright browser installation is required. On a headless Linux host, use `xvfb-run -a npm run test:desktop`.

`npm run verify` groups type checking, unit tests, the build, and `check:public`. It does not include desktop or native helper checks.

Build native helpers only when working on their functionality:

```sh
npm run build:native
npm run test:helper
```

Native builds require macOS 14+ on Apple silicon with Xcode Command Line Tools (Swift and Clang), or Windows 11 x64 with the .NET 10 SDK. The macOS platform module uses the installed `node-api-headers` dependency. See [extensions](docs/extensions.md) for recognition, microphone, and text insertion boundaries.

The automated desktop and helper checks use synthetic data and protocol operations; they do not record microphone audio or insert text into another application.

Start with the local development entry to work on the client without an account. The account/billing service adapter and update backend are unset, and genuine recognition is unconfigured. A fixed-text demonstration requires explicitly selecting the local service. When changing an integration, keep its default unconfigured behavior explicit, test through injected adapters, and document what the developer or user must configure. Never embed service credentials or an account in examples or tests.

## Source file manifest

[`public-files.json`](public-files.json) lists the source files included in the repository. Update it when adding, removing, or renaming a file, keeping each repository-relative path exactly once. Include documentation and test files; exclude generated output and installed dependencies. When Git is present, `check:public` also compares the Git index with the manifest, so stage intended additions and deletions before running that check.

Keep local scratch files outside the repository. A passing content check is a guardrail; review the actual diff for sensitive data and third-party material as well.

## Pull requests

- Explain the problem, expected behavior, and any platform-specific effects.
- Keep changes focused. Add meaningful tests for changed behavior and update documentation when usage changes.
- Run type checking, tests, and the build; report the commands and results, including checks you could not run.
- Separate automated results from native runtime observations. A build on one platform does not establish behavior on another.
- Use synthetic text and audio fixtures. Remove credentials and personal data from examples, logs, screenshots, and commits.
- Preserve dependency license and attribution notices. Keep generated binaries and installed dependencies out of source changes.

For Git commit email privacy, you may use a GitHub-provided `noreply` address. See [GitHub's email privacy guidance](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address).

## Security and licensing

Report vulnerabilities privately through [SECURITY.md](SECURITY.md), not a public issue or pull request.

By intentionally submitting a contribution for inclusion, you provide it under the project's [Apache License 2.0](LICENSE), unless you explicitly state otherwise, as described in section 5. Submit only material you are authorized to contribute and identify any third-party material and its license. The license does not transfer ownership of your contribution. The project's [trademark notice](TRADEMARKS.md) also applies.
