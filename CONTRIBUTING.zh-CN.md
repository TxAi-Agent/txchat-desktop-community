# 参与贡献

[English](CONTRIBUTING.md)

欢迎改进社区应用、原生辅助程序、测试和文档。较大改动请先通过 issue 说明目标行为及涉及平台，再开展实现。

## 开发

使用 Node.js 24 和 npm，在仓库根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

构建后执行 `npm run test:desktop` 检查离线 Electron 界面，并执行 `npm run check:public` 检查源码文件清单、依赖来源和文件内容。桌面检查通过 Playwright 使用 Electron，无需安装 Playwright 浏览器。在无图形界面的 Linux 主机上，使用 `xvfb-run -a npm run test:desktop`。

`npm run verify` 包含类型检查、单元测试、构建及 `check:public`，不包含桌面或原生辅助程序检查。

需要开发原生能力时再构建辅助程序：

```sh
npm run build:native
npm run test:helper
```

原生构建需要 Apple 芯片的 macOS 14+ 及包含 Swift、Clang 的 Xcode Command Line Tools，或 Windows 11 x64 及 .NET 10 SDK。Mac 平台模块使用已安装的 `node-api-headers` 依赖。识别、麦克风及文本写入的边界见[扩展说明](docs/extensions.md)。

自动化桌面及辅助程序检查使用合成数据和协议操作，不录制麦克风音频，也不向其他应用写入文字。

通过本地开发入口可以在无账号情况下开发客户端。账号与计费服务适配器、更新后端默认为空，真实识别未配置；固定文本演示需要主动选择本地服务。修改集成时，应保持默认未配置状态明确，通过注入适配器测试，并说明开发者或用户须配置什么。示例和测试中不得内置服务凭据或账号。

## 源码文件清单

[`public-files.json`](public-files.json) 列出仓库包含的源码文件。添加、删除或重命名文件时须同步更新，每个相对仓库根目录的路径只出现一次。文档和测试文件也应纳入；生成的构建输出和已安装依赖不纳入。存在 Git 仓库时，`check:public` 还会比较 Git 索引与清单，因此执行检查前应暂存预期的新增和删除。

本地临时文件放在仓库之外。内容检查只是辅助保护，仍应检查实际差异是否包含敏感数据或第三方材料。

## Pull Request

- 说明问题、预期行为及平台差异。
- 保持改动集中，为行为变化添加有意义的测试；使用方式变化时同步文档。
- 执行类型检查、测试和构建，报告命令及结果，并说明未能执行的检查。
- 区分自动化结果与原生运行观察。某个平台构建成功不能证明另一平台的实际行为。
- 使用合成文字和音频样本。示例、日志、截图及提交中不得包含凭据和个人数据。
- 保留依赖许可证和署名声明，源码改动中不包含生成的二进制文件及已安装依赖。

希望保护 Git 提交邮箱时，可以使用 GitHub 提供的 `noreply` 地址，见 [GitHub 提交邮箱说明](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)。

## 安全与许可

安全漏洞请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私密报告，不要提交到公开 issue 或 Pull Request。

根据 [Apache License 2.0](LICENSE) 第 5 条，除非明确另作声明，您为纳入本项目而有意提交的贡献适用该许可证。请仅提交有权贡献的内容，并标明第三方材料及其许可证。许可证不转移贡献的所有权；另见项目[商标说明](TRADEMARKS.md)。
