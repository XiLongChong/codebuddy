# Agent 编辑器 Demo

解压 Windows x64 便携包到可写目录，双击同目录的 **VSCodium.exe**。通过「文件 → 打开文件夹」打开一个本地项目，信任项目后点击左侧活动栏的对话图标。也可以在命令面板中执行 **AI：打开对话**。

## 配置模型

点击侧栏的 **配置模型**，填写 OpenAI 兼容服务的 Base URL（例如 `https://api.openai.com/v1`）、模型 ID 和 API Key。点击 **测试连接** 会实际请求模型，点击 **保存** 生效。Agent 模式需要服务支持流式 Chat Completions 和函数工具调用。回环地址上的本地服务可以留空密钥。

模型配置使用 VS Code SecretStorage。会话和文件快照按工作区保存在便携目录的 `data/user-data/User/workspaceStorage` 下。再次打开同一个文件夹，点击 **历史** 可继续之前的对话。密钥的解密依赖本机用户的系统凭据。

## 常用操作

| 操作 | 使用方式 |
| --- | --- |
| 了解项目 | 在 **问答** 中输入问题。输入 `@` 选择文件或目录。编辑器右键可添加当前选区，输入框的 **＋** 可附加诊断或最近命令输出。人工终端的输出可直接粘贴。 |
| 修改并测试 | 切换至 **Agent** 并描述任务。侧栏显示每次工具操作。命令卡展示工作目录和命令，点 **运行** 仅批准这一次。点击 **停止** 可打断本轮。项目命令使用本机 PATH 中的工具。 |
| 审阅改动 | 点击改动文件打开原生 Diff，逐个保留或撤销，也可全部保留。**撤销最近一轮 Agent 改动** 支持已保留的文件，并列出后续人工修改或未保存编辑造成的冲突。命令产生的副作用可从命令输出检查，文件撤销只覆盖 Agent 文件工具的写入。 |
| 快速编辑 | 选择文本或放置光标，按 **Ctrl+I**，输入指令，查看 Diff，选择 **应用** 或 **取消**。应用之后可按 **Ctrl+Z**。 |
| 行内补全 | 输入并停顿，**Tab** 接受灰字、**Esc** 收起。可运行 **AI：触发 Tab 补全**，或在设置中搜索 `agentEditor.tabCompletion` 切换开关。 |
| 扩展管理 | 在扩展视图中从 Open VSX 安装兼容扩展，通过齿轮启用、禁用或卸载。扩展视图的「… → Install from VSIX」可安装本地 VSIX。安装 Prettier 后，在 JavaScript 文件中执行「Format Document With… → Prettier」。 |

## 开发与验证

从 GitHub 克隆源码后，在 Windows x64 上准备 Node.js 24（含 npm）以及 Windows 自带的 `tar.exe`。在仓库根目录运行：

```powershell
npm ci
npm test
npm run package:win
```

`npm ci` 按 `package-lock.json` 安装依赖。首次打包会从 GitHub 下载并校验 VSCodium 1.143.17232，将自研扩展和 Pi 1.5.2 等运行依赖预装到 `data/extensions`。如果已下载同一版本的官方 ZIP，可通过环境变量 `VSCODIUM_ZIP` 指定文件路径。

将生成的 `out/AgentEditor-0.1.0-win32-x64.zip` 解压到可写目录，双击 `VSCodium.exe`。使用 AI 功能时，在侧栏配置自己的 OpenAI 兼容服务。源码仓库中的依赖锁文件和打包脚本可以交给 Agent 执行上述步骤。

`npm test` 在临时项目中检查文件边界、停止与命令批准、原始快照、冲突撤销、Pi 的流式事件、失败测试反馈及历史续问。协议回归使用本地可重复的响应序列，无需 API Key。

打包后可运行 `npm run test:editor`，由测试脚本启动独立的 VSCodium 扩展宿主，实际执行 Prettier 格式化。默认从 Open VSX 下载 Prettier 12.4.0，也可通过环境变量 `PRETTIER_VSIX` 指定同一版本的 VSIX 文件。
