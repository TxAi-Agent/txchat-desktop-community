# Third-party components

This repository's original material is licensed under [Apache License 2.0](LICENSE). Third-party dependencies and tools retain their own licenses. The project license does not relicense them.

Dependency declarations and resolved versions are recorded in `package.json` and `package-lock.json`. Installed dependencies are obtained by `npm ci`; their source and binaries are not vendored in this repository. Read each dependency's license and notice files before redistributing it. Electron's runtime also includes components with their own notices; preserve the notices distributed with the runtime if you redistribute it.

## Direct dependency declarations

The table records the direct package versions and license identifiers declared by their installed package metadata. It does not enumerate transitive packages or replace their full license and notice texts.

| Package | Version | Declared license |
| --- | --- | --- |
| React | 19.3.0 | MIT |
| React DOM | 19.3.0 | MIT |
| qrcode | 1.5.4 | MIT |
| Electron | 44.4.2 | MIT |
| esbuild | 0.28.2 | MIT |
| Playwright | 1.63.0 | Apache-2.0 |
| tsx | 4.23.13 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| @types/node | 24.13.5 | MIT |
| @types/qrcode | 1.5.6 | MIT |
| @types/react | 19.3.0 | MIT |
| @types/react-dom | 19.3.0 | MIT |
| node-api-headers | 1.9.0 | MIT |

## Transitive notices and redistribution

Some tools bundle additional components. In particular, Playwright and Playwright Core include `ThirdPartyNotices.txt` and license sidecars next to bundled JavaScript files; TypeScript includes `ThirdPartyNoticeText.txt`. Read those files as well as the package-level license when preparing a distribution.

The Electron installation toolchain resolves `@electron-internal/extract-zip` 1.0.5. Its [version-matched upstream package metadata](https://github.com/electron/extract-zip/blob/b83e459fd04c53b0a1c8438a6792df8f64be47fc/package.json) declares `BSD-2-Clause`, but that npm package does not include a standalone license or notice file. This repository references the package through the lockfile and does not distribute its code or binary. Before redistributing that package, obtain and retain the applicable copyright and full license notices for that exact version and its bundled components. A license file from a different upstream revision is not a substitute.

Native builds use platform SDKs and system frameworks. Those tools and frameworks are not included in the source repository and remain subject to their applicable terms.

`node-api-headers` supplies the Node-API headers used when compiling the macOS platform module. Its MIT license and applicable header notices must be preserved when redistributing covered material. The project's included original PNG and SVG graphics, including tray artwork, are project assets covered by the project copyright license; the separate trademark notice still applies.

This document describes the source repository's dependency boundary. It is not a license clearance for a downstream application or binary distribution.

## 中文说明

本仓库原创内容采用 [Apache License 2.0](LICENSE)，第三方依赖和工具仍适用各自许可证，不因本项目采用 Apache License 而改变。

依赖声明及解析后的版本记录在 `package.json` 和 `package-lock.json`。`npm ci` 获取所需依赖；本仓库不内置其源码或二进制副本。再分发依赖时，应阅读并保留各依赖适用的许可证及声明文件。Electron 运行时也包含具有独立声明的组件，再分发运行时时应保留其附带声明。

上表记录直接依赖版本及其安装包元数据声明的许可证标识，不列举传递依赖，也不替代各组件完整的许可证和声明原文。

部分工具内置其他组件：Playwright 和 Playwright Core 附带 `ThirdPartyNotices.txt` 及打包 JavaScript 文件旁的许可证文件；TypeScript 附带 `ThirdPartyNoticeText.txt`。准备再分发时，应同时阅读这些文件与包级许可证。

Electron 安装工具链使用的 `@electron-internal/extract-zip` 1.0.5 在上文链接的对应版本元数据中声明 `BSD-2-Clause`，但该 npm 包未附独立许可证或声明文件。本仓库仅通过锁文件引用它，不分发其源码或二进制文件。若要再分发该包，须先取得并保留这一精确版本及其内置组件适用的版权和完整许可证声明，不能用其他上游版本的许可证文件代替。

原生构建使用平台 SDK 和系统框架；这些工具和框架不包含在本源码仓库中，并适用各自条款。本文件说明源码仓库的依赖边界，不构成对下游应用或二进制分发的许可核准。

`node-api-headers` 提供编译 Mac 平台模块所需的 Node-API 头文件，再分发适用材料时应保留 MIT 许可证和相应头文件声明。仓库中的原创 PNG、SVG 图形及托盘素材属于项目素材，适用项目著作权许可；独立的商标说明仍适用。
