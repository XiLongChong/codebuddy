# Agent 编辑器 Demo 实现说明

开发一个可启动的 Windows x64 桌面 Demo。以 **Code - OSS 的 VSCodium 构建**为编辑器底座，把 **Pi Coding Agent** 接到自带的 AI 扩展中。打开真实项目后，用户能问代码、让 Agent 改多个文件并运行测试、看 Diff 和撤销；也能选中代码快速改写，或在输入时按 Tab 接受 AI 补全。

请直接按第 2 节实现全部功能，再按第 3 节验收并交付。界面用 Code - OSS 默认工作台，新增一个简洁的 AI 侧栏、几个原生命令和 Diff 视图。

## 1. CodeBuddy 和 TRAE 的功能拆解

| 操作 | CodeBuddy IDE | TRAE IDE |
| --- | --- | --- |
| 了解代码、交代任务 | 在对话中描述需求，使用 Craft Agent 修改项目，查看执行过程，可停止后继续追问。[CodeBuddy 对话](https://www.codebuddy.ai/docs/ide/User-guide/Agent-Mode/Conversation) | 在主对话里选模型和智能体，解释代码仓库、修错或生成代码。[TRAE 对话](https://docs.trae.cn/ide_chat) |
| 让 AI 知道在说哪段代码 | 用 `@` 引用文件、目录、终端输出和 Git 改动。[CodeBuddy 上下文](https://www.codebuddy.ai/docs/ide/User-guide/Context) | 将当前文件、选区或终端输出交给 AI，也可用 `@` 查找文件和目录。[TRAE 上下文](https://docs.trae.cn/ide_basic-usage-of-context) |
| 跑命令、看结果 | 对话展示执行步骤和结果，终端输出可以继续作为提问上下文。[CodeBuddy 对话](https://www.codebuddy.ai/docs/ide/User-guide/Agent-Mode/Conversation) · [上下文](https://www.codebuddy.ai/docs/ide/User-guide/Context) | 智能体运行项目命令，对话显示结果，可配置手动批准运行。[TRAE 对话流设置](https://docs.trae.cn/ide_chat-settings) |
| 查改动、撤销 | 查看本次改动的文件和 Diff，可通过 Checkpoint 恢复改码前的状态。[CodeBuddy 结果](https://www.codebuddy.ai/docs/ide/User-guide/Agent-Mode/Results) · [Checkpoint](https://www.codebuddy.ai/docs/ide/User-guide/Checkpoint) | IDE 中 Agent 改动写入磁盘，审阅时对改动进行保留或撤销。[TRAE 代码审查设置](https://docs.trae.cn/ide_chat-settings#代码审查) |
| 改眼前的代码 | 选区或光标处按 `Ctrl+I`，描述改法，预览并接受或取消。[CodeBuddy 行内对话](https://www.codebuddy.ai/docs/ide/User-guide/inline-chat) | 选区或光标处按 `Ctrl+I`，就地发起行内对话。[TRAE 行内对话](https://docs.trae.cn/ide_chat#行内对话) |
| 边写边补 | 输入时出现行内补全，`Tab` 接受，`Esc` 取消。[CodeBuddy 代码补全](https://www.codebuddy.ai/docs/ide/User-guide/Completion) | CUE 提供代码续写和建议修改，`Tab` 采纳，`Esc` 拒绝。[TRAE CUE](https://docs.trae.cn/ide_cue) |

Demo 取两款编辑器最常用的操作。范围是本地单目录项目、一个模型配置、同一时间跑一轮 Agent。云端任务、独立 Agent 窗口、MCP、语义索引和跨文件下一处编辑预测留给完整产品。

## 2. 必做功能

### 01 编辑器与插件

- 用 VSCodium 的 Windows x64 ZIP 作为可运行的 Code - OSS 底座。在可执行文件同级创建 `data` 目录进入便携模式，打包时预装自研 AI 扩展。解压启动后可打开 AI 侧栏。保留原有的文件树、搜索、编辑、终端、Git 和扩展管理。 [VSCodium 便携模式](https://github.com/VSCodium/vscodium/blob/master/docs/usage.md)
- 扩展页使用 Open VSX。能安装、启用和卸载兼容扩展，也能安装用户从授权渠道取得的本地 VSIX。以 Prettier 为例，安装后实际运行一次格式化。 [VSCodium 扩展源](https://github.com/VSCodium/vscodium/blob/master/docs/extensions.md) · [Microsoft 关于 Marketplace 的说明](https://code.visualstudio.com/docs/supporting/faq)

### 02 配置模型与会话历史

- AI 侧栏提供「配置模型」「新对话」「历史」。模型配置填写 OpenAI 兼容 API 的 Base URL、模型 ID 和 API Key，支持测试连接。API Key 存在 VS Code 的 SecretStorage，设置界面只显示脱敏内容。
- 使用 Pi Coding Agent SDK 建立会话，流式回复和工具执行接真实模型。模型未配置时展示设置入口，连接失败时显示错误并保留用户输入。普通编辑功能独立可用。
- 本地保存当前工作区的会话列表、消息和改动记录。重开同一目录后能打开旧会话并追问。切换目录后显示对应的历史。

### 03 侧栏问答与上下文

- 侧栏有历史消息、输入框、「问答 / Agent」切换和发送按钮。回复按流显示，支持 Markdown、代码块和可点击的文件路径。运行时显示「停止」，停止后可继续提问。
- 输入 `@` 可搜索并引用文件或目录。目录引用提供搜索范围，由工具按需读文件。编辑区右键提供「添加选区到对话」，以文件名和行号展示附件，发送前可移除。选区取编辑器中的当前文本，包括未保存内容。
- 支持附加当前文件的诊断或 Agent 最近一次命令输出。人工终端中的报错可粘贴到输入框。问答模式给 Pi 提供查找、搜索、读取和诊断工具，写文件和运行命令仅在 Agent 模式可用。

### 04 Agent 改码与运行命令

- 用户在 Agent 模式输入目标后，Pi 可以列目录、查找文件、搜索文本、读文件、新建或修改文本文件。文件变更直接写入工作区，后续工具和测试读取更新后的文件。界面根据真实事件显示工具名称、路径和成功或失败。一次任务可以连续改多个文件。
- 当 Pi 请求运行命令时，在对话内展示实际命令、工作目录和「运行」「拒绝」。仅执行用户批准的这一次命令，输出 stdout、stderr 和退出码给界面与 Pi。至少跑通项目里的 `node --test`，测试失败时 Pi 能读到报错并继续修复。
- 停止时取消 Pi 本轮和受管理的命令，取消待批准请求并阻止本轮继续调用工具。已写入的改动留在 Diff 列表，用户仍可撤销。文件工具只在受信任的当前工作区内使用，校验最终路径并跳过常见密钥文件。与未保存的编辑发生冲突时提示用户先保存，保留原有内容。

### 05 变更 Diff 与撤销

- Agent 通过文件工具首次写入某个文件前，记录这一轮的原始内容，轮内多次改同一文件时保留原始快照并更新最终内容。信息记录在扩展数据目录，与会话一同恢复。
- 对话显示本轮改动列表和待审阅状态。点文件用原生 Diff 查看该轮改动前后。提供「保留」「撤销」及「全部保留」。保留表示确认已写入的改动。撤销恢复原文件，新建文件仅在内容仍与 Agent 写入结果一致时移除。
- 提供「撤销最近一轮 Agent 改动」，可还原该轮仍处于修改后状态的文件，包括已点保留的文件。已撤销的文件直接跳过。文件内容有后续人工改动或在编辑器中有未保存改动时，列出冲突并跳过该文件。撤销范围是 Agent 文件编辑工具记录的改动。命令的副作用通过终端输出呈现。

### 06 选区快速编辑

- 按 `Ctrl+I` 或从编辑器右键选择「AI 快速编辑」。选中代码时修改选区，光标无选区时在光标处生成代码。Demo 可以用原生 Quick Input 收集指令。
- Pi 只生成目标文本。展示预览，由用户点「应用」或「取消」。应用通过编辑器编辑操作完成，`Ctrl+Z` 可撤销。原文在生成期间发生变化时提示重试。

### 07 Tab 补全

- 使用 `registerInlineCompletionItemProvider` 返回光标处的灰字补全。停顿时自动触发，也可从命令面板手动触发。「AI Tab 补全」设置可开关，默认开启。[VS Code Inline Completion API](https://code.visualstudio.com/api/references/vscode-api#InlineCompletionItemProvider)
- 使用同一个已配置模型快速生成少量续写文本，输入只取当前文件光标附近的前后文。此次请求无工具，独立于侧栏会话。`Tab` 接受，`Esc` 取消。继续输入或移动光标时丢弃旧结果，常规 Tab 缩进照常工作。

### 实现时直接复用

- **桌面底座**用 VSCodium，调试时将自研扩展装进已有构建，打包时把扩展随便携包预装。开发 Agent 界面和功能可以通过扩展 API 完成。[VSCodium](https://github.com/VSCodium/vscodium)
- **会话与工具**直接在扩展宿主嵌入 Pi Coding Agent SDK，固定依赖版本。参考 Phi 的 SDK 会话和编辑器上下文，通过产品工具接管文件写入与命令批准。复用 Pi 的流式事件、模型适配和会话存储。 [Pi SDK](https://docs.pi.dev/latest/sdk) · [Phi](https://github.com/gnassro/phi)
- **工具卡片与 Diff**参考 pi-agent-manager 的流式对话和工具卡片，以及 CodePi 已写入改动的保留、撤销及过期处理。按需移植对应模块，保留上游许可声明。 [pi-agent-manager](https://github.com/peilundai/pi-agent-manager) · [CodePi 的 Edit review](https://github.com/lutrarutra/codepi#edit-review)



