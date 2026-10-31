# Amadeus for Codex

面向 **Codex Desktop** 的牧濑红莉栖桌面伴侣。Amadeus 以红色翻盖手机呈现对话、Live2D、语音、长期记忆和主动来电；面板是 Windows 原生 Qt/OpenGL 窗口，不依赖浏览器或 WebView。

| 功能 | 当前实现 |
| --- | --- |
| 桌面面板 | 开屏标识动画、Live2D 动作与表情、可拖动窗口；右下角拖动缩放，保持手机 15:26 的外形比例；来电画面随显示区缩放 |
| 对话与任务 | 使用本机 Codex 连接；支持发送 PNG、JPEG、WebP 图片供支持视觉输入的模型识别；任务开始、完成和失败可按设置播报 |
| 语音 | 可选本地 Qwen 克隆音色或其他已配置来源；克隆合成失败时不会静默换声；来电铃声单独设置 |
| 记忆 | 会话与长期事实保存在本机，长期记忆默认关闭，可导出、删除与备份 |
| 角色替换 | 在源文件中更换模型、人设、固定台词与默认声线，面板不提供角色切换入口 |

Windows 原生面板需要 Node.js 22+、64 位 Python 3.11+ 和 Codex Desktop。**音色克隆不是安装面板的前置条件**；本地克隆需另行安装 Qwen TTS WebUI 并注册自己的参考音频。首次安装会联网安装 Python 依赖并下载角色模型。

> **分享与隐私**：经过自动检查的发行压缩包不包含作者的 API Key、个人配置、聊天记忆、录音或克隆音频。请只分享运行 `npm run dist` 后生成的 `dist/amadeus-codex-<version>.zip`，不要直接压缩整个开发目录；安装后产生的数据和密钥只属于安装者。检查不能保证未来的修改或用户自己另行加入的文件绝对安全，发布前请重新运行 `npm run check` 与 `npm run dist`。

功能边界见 [功能设计与说明](docs/功能设计与说明.md)；开发记录见 [STATUS](docs/STATUS.md)。

本轮已验收的修复见 [原生面板审阅与验收](docs/原生面板审阅与验收.md)：包含断线回复恢复、窄窗换行、原生设置补全、启动会话保护和 Live2D 点击交互修正；来电文字已居中，沿用原有手机风格。本轮改动随 `main` 分支源码提供；历史 0.1.4 安装包不包含这些后续修复。

角色反馈现在区分输入、思考、回答、朗读和待机；关闭语音也会保留面部情绪。轻点头部/身体、轻划和按住头部约 0.65 秒后松开会有不同反馈，并显示短字幕。本地克隆的固定点击台词会提前准备，点击直接播放缓存，避免临时合成和迟到补播。头部与眼睛使用同一套鼠标跟随计算。具体设置与验收见 [交互与情绪说明](docs/交互与情绪说明.md)。

情绪表现已按当前模型实际有效的眼睛、眉高、嘴角和头部参数校准，回复结束后会短暂延续相关情绪。屏幕左下显示当前状态。右键菜单沿用手机的深红样式，只保留轻抚、轻拍、逗她一下和恢复自然，不再显示内部动作文件名；思考或朗读期间不会打断角色。

### 0.1.4 界面与 Live2D 修复

- 来电画面铺满手机显示区；标志、来电文字和接听键随窗口大小调整，信号与电池图标不再依赖字体字符。
- 缩短模型待机动作中持续过久的闭眼段。眼睛和头部在鼠标进入或离开面板时保持同一刷新节奏；面板外的位置按显示区边缘处理，避免跟踪速度突变。
- 从 Git 仓库原地更新的用户关闭并重新打开 `Amadeus.exe` 即可加载本次面板代码；从发行包升级仍按 [安装教程](docs/INSTALL.md#升级) 操作。

## 快速开始

1. 下载 [最新源码 ZIP](https://github.com/louyun2233/Amadeus-for-codex/archive/refs/heads/main.zip)，或在 GitHub 的 `main` 分支选择 **Code → Download ZIP**；将压缩包**完整解压**到固定目录。源码包含下面的一键安装入口，无需自行编译。
2. 确认 `node --version` 显示 22 或更新版本，`py -3 --version` 显示 3.11 或更新版本，并且安装的是 64 位 Python。
3. 双击解压目录中的 **`安装 Amadeus.cmd`**。它会创建 `.native-venv`、安装原生面板依赖、构建 `Amadeus.exe`、注册 Codex 连接、启动服务并检查角色素材。
4. 安装窗口提示完成后，重启 Codex Desktop。也可以双击 `Amadeus.exe` 单独打开面板。

完整步骤、升级和排障见 [安装教程](docs/INSTALL.md)；从零制作本地克隆音色见 [使用教程](使用教程.md#3-从零制作本地克隆音色)。

进阶用户才需要下面的命令：

```powershell
node bin/amadeus.mjs doctor     # 能力自检
node bin/amadeus.mjs start      # 启动常驻 daemon
node bin/amadeus.mjs open       # 打开原生面板窗口
node bin/amadeus.mjs status     # 查看状态
node bin/amadeus.mjs stop       # 停止
```

新安装时语音朗读、任务播报、长期记忆和主动功能默认关闭；需要时在原生面板的「设置」页开启。

打开面板先在手机屏幕播放标识逐渐浮现的开机动画，随后显示 Live2D 与对话。拖动屏幕顶端状态区、转轴或机身边框可移动窗口；拖动**右下角斜线**可缩放窗口，手机外形维持 15:26，新的窗口仍从 300×520 开始。来电时可拖动屏幕空白处；点击 **CONNECT** 接听，点击底部圆键拒接。

**没有现成音色？**从参考音频开始安装本地 Qwen、注册克隆音色、配置来电铃声的步骤见 [使用教程.md](使用教程.md)。桌面面板本身需要 Python；本地克隆语音另需 Qwen TTS WebUI。用户提供的红莉栖提示音来源及使用限制见 [参考音频说明](docs/参考音频说明.md)；发行包不转载该音频。

**要换成自己的角色？**模型、人设、固定台词和默认声线在源文件中配置，不在页面端切换。按 [角色替换教程](docs/角色替换教程.md) 编辑、校验并应用到已有安装。

**长期记忆如何保存与恢复？**面板记忆与 Codex 任务记忆分开存储；事实不会因达到数量上限被静默淘汰，聊天提要只保留最近三条。单句模式重开面板时显示空白对话；历史会话仍保存在本机。故障诊断、备份和恢复步骤见 [记忆机制与备份](docs/记忆机制与备份.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `bin/` | CLI、daemon、MCP、notify 入口 |
| `src/core/` | 纯逻辑：配置、存储、记忆、会话、对话、语音、情绪、自检 |
| `src/host/` | 宿主层：HTTP 服务、鉴权、事件总线、适配器 |
| `native/` | 原生 Qt/OpenGL 面板、Live2D、语音输入与播放 |
| `src/panel/` | 旧网页面板源码，不进入发行包 |
| `tests/` | `node:test` 单元测试与原生 Qt 回归测试 |
| `config/` | 默认配置与资源清单 |
| `persona/` | 人设文本与角色固定台词 |

## 开发与验证

```bash
npm run check            # 一条命令前置检查：语法 + 分发清单 + 单元/契约测试
npm test                 # 只跑测试（无网络、无浏览器）
npm run dist             # 生成 dist/amadeus-codex-<version>.zip
.native-venv\Scripts\python.exe -m py_compile native\panel.py

powershell -ExecutionPolicy Bypass -File scripts\verify-install.ps1   # 安装器全流程（隔离 CODEX_HOME）
```

契约测试（`tests/compat.test.mjs`）专门盯模块之间的接缝：配置键、MCP 工具名 vs skill 文档、
面板请求路径 vs daemon 路由、SSE 事件名、表情与密钥枚举、记忆命名空间。
这类"两边对不上"的问题单看任何一个模块都发现不了。

想用自己已有的模型文件（而不是走下载）：

```bash
node bin/amadeus.mjs assets install-file kurisu-model /path/to/kurisu.tar.gz
```

哈希仍要与注册表一致，对不上会被拒绝并打印 expected/got。

## 安装到 Codex

两种方式，任选其一（也可以都用）：

1. **安装脚本（进阶）**：注册 MCP、校验发行包、准备数据目录，最后启动 daemon。普通 Windows 用户直接双击根目录的 `安装 Amadeus.cmd` 即可。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1              # 注册连接、安装原生面板并启动服务
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Marketplace # 同时注册插件市场
```

2. **Codex 插件市场**：让 Codex 自己管理这个插件（`codex plugin` 需要 Codex 自带 CLI）。

```powershell
node scripts\make-dist.mjs                     # 生成 dist\marketplace（只含发行文件）
codex plugin marketplace add dist\marketplace   # 注册市场
codex plugin add amadeus@amadeus                # 安装
codex plugin list --available                   # 确认可见
```

直接 `codex plugin marketplace add .` 也能工作，但插件路径就是仓库根，Codex 会把
`node_modules/`、`work/`、`dist/` 一起复制进插件缓存；所以上面先 `make-dist` 生成一个只含
发行文件的 `dist\marketplace` 再注册。市场条目在 `.agents/plugins/marketplace.json`，
插件元数据在 `.codex-plugin/plugin.json`。

**打开 Codex 时面板会自己出现**：新窗口默认 300×520；可拖动右下角斜线缩放，手机比例保持 15:26，最小 270×468。这一条**不依赖 Codex
hooks**：Codex 连接 Amadeus MCP 时会直接打开面板；登录后启动的 watcher 每 3 秒检查一次，
作为连接未建立时的备用路径。watcher 由隐藏的 VBS 守护，异常退出后会自动重启。一次 Codex
会话只自动打开一次；手动关掉后不会因同一会话中新建 MCP 连接再次弹出。用 `-NoAutoStart`
安装可以关闭自动打开。

也可以随时手动打开：双击项目目录里的 `Amadeus.exe`（由安装脚本使用 Windows .NET Framework 编译器生成），或运行 `node bin\amadeus.mjs open`。若缺少编译器，安装会明确报错。

## 默认行为：她是个陌生人

- **无记忆**：`memory.enabled` 默认关闭，不会抽取也不会召回任何长期事实。
- **单句连接**：`chat.oneshot` 默认开启，回完一句就断开（状态栏显示「已回复 · 单句会话已结束」），
  下一条消息从零开始，不带上一句的上下文。
- **语音与任务播报默认关闭**：可在原生面板「设置」中分别开启；已有配置保持原值。没有克隆音色时先按教程注册本地 Qwen 音色，再把「合成服务」设为 `qwen-local`，填写「音色 ID」并保存音色配置。内置默认音色也可单独使用，但它不是克隆声线。
- **任务播报需明确开启**：安装脚本会写 Codex 的 `notify`（若你原本已有 notify，会把旧命令记到
  `%LOCALAPPDATA%\Amadeus\notify-chain.json` 并先转发给它）；开启语音与相应的任务开始／完成播报后，每个边界只播一段短句，但会轮换不同台词，不会连续重复。内部辅助任务不会单独播报。

对话模式、长期记忆与语音可在面板「设置」里调整。空闲主动开口与主动来电在新安装时默认关闭，需要分别开启；已有配置保持原值。回复生成期间，发送按钮会变成取消按钮；取消会中止后端请求。

原生设置还提供独立对话 API 的通道、模型、地址与密钥，阿里云音色对应的合成模型、来电音量、主动互动间隔，以及「允许 Codex 发声／来电」授权。密钥只写入本机存储；状态只显示是否设置。阿里云克隆 ID 必须与克隆时的目标合成模型匹配，保存 ID 时也要填写「云端合成模型」。

日常对话使用 Codex 登录，但只在 Amadeus 的 `codex exec` 调用中将推理强度设为 `low`，不修改用户的全局 Codex 模型或推理设置。面板会显示「连接模型／等待回答／服务重试」等阶段，不展示模型内部推理；后端最多等待 60 秒，面板再留 15 秒接收结果或明确错误。如果 Codex CLI 到模型服务的请求超时，会明确指出连接故障，而不是把它当作角色在长时间思考。`GET /amadeus/chat?turnId=...` 可查阶段、耗时与首条回复耗时，审计记录仅写阶段和时间，不写提问原文。开启自动记忆时，纯闲聊或没有用户长期事实的提问不再追加第二次模型调用。

Windows 若启用了系统 HTTPS 代理，而 Amadeus 启动环境没有 `HTTPS_PROXY`，Amadeus 会读取当前用户的系统代理设置，只传给自己的 Codex CLI 子进程；已有 `HTTPS_PROXY`／`ALL_PROXY` 保持原样。不会修改 Windows 代理、全局 Codex 设置或其他程序。代理关闭或格式无效时不会注入。若面板显示「模型服务请求超时」，先确认系统代理可用及 Codex CLI 能连接模型服务。

音频样本不是动态音色：本地路径需先在 Qwen TTS WebUI 注册音频，得到 ID，再把该 ID 导入面板；阿里云路径则需先在云端完成复刻、取得对应账号的 ID。两种 ID 不通用。选中本地克隆后，点击角色、回答、接听后的语音和任务播报都走该声线；本地服务失败会明确报错，不会换成 Edge 或系统人声。来电铃声是单独的提示音，可用 `%LOCALAPPDATA%\Amadeus\sounds\incoming.wav` 自定义。详见 [从零克隆教程](使用教程.md#3-从零制作本地克隆音色)。

本地 Qwen 已配置的 Windows 用户重新运行安装脚本后，会添加隐藏的开机启动任务 `Amadeus Qwen TTS`，避免先打开 Amadeus 或 Codex 时 API 尚未启动。模型冷启动期间仍需稍等；任务不会切换或重制克隆音色。可用 `Get-ScheduledTask -TaskName 'Amadeus Qwen TTS'` 检查运行状态。

Codex 守候程序在新一轮连携打开面板时，或用户双击 `Amadeus.exe` 单独打开新面板时，播放一次开场白；刷新或重连不重复。说话期间，情绪标签驱动现有 Cubism 2 表情和轻微头部、视线过渡，语音结束后短暂保留情绪再缓慢回落，并尊重系统的减少动态效果设置。当前本地 Base 克隆不支持显式情绪韵律参数；为保持克隆音色，不对音高和音色做后处理。

点击角色时，同一动作组会轮换不同的动作片段。默认角色包含 72 条互动台词，头部点击、肩膀轻拍、拖动逗弄、轻抚头发各 18 条，整体覆盖 18 种情绪；按动作随机抽取，一轮内不重复，表情与中文字幕跟随所选台词。本地克隆短句在后台逐条准备，随后直接播放原始 WAV 缓存。首次准备未完成时显示表情与字幕，稍后再点击即可发声，不会积压后补播。生成或朗读回答时不插入点击台词或打断当前情绪。Live2D 自带的原版语音不会自动播放。

眼部与表情参数只在当前帧叠加，避免逐帧累积导致闭眼卡住；异常长闭合按左右眼分别恢复。眉眼和嘴部的最终显示值平滑衔接不同状态，短暂眨眼保持独立节奏，也不增加鼠标跟随延迟。本地 Qwen 合成必须确认流完整结束后才缓存；长回复按最多 80 字分段，在当前段播放时预取下一段，不再因超过 24 句截去末尾。播放端会停止无进度的音频，停止语音不阻塞界面动画。原克隆声线、语速、音调和已有短句缓存保持不变，详见 [交互与情绪说明](docs/交互与情绪说明.md#句中中断与播放停滞)。

原生界面与功能审阅记录见 [原生面板审阅与验收](docs/原生面板审阅与验收.md)。`npm run check` 在已安装原生环境的 Windows 上会同时检查 Python 与 Qt 回归测试；`node scripts/verify-panel.mjs` 检查本机原生面板依赖和服务，不会打开浏览器。

桌面面板通过 Windows 系统语音识别读取麦克风，无需浏览器。可在「设置」中启用或关闭麦克风；识别结果先进入输入框，确认后发送。

| 取值 | 识别在哪 | 说明 |
| --- | --- | --- |
| `windows-native`（默认） | Windows Speech Recognition | 使用系统已安装的识别语言与默认麦克风 |
| `api`（仅旧配置兼容） | daemon → Whisper 兼容接口 | 原生面板首次连接时会迁移到 `windows-native` |
| `none` | — | 关掉麦克风输入 |

Windows 原生语音识别使用系统提供的识别器；没有对应语言包或麦克风权限时，面板会显示错误。旧版 `api`、`browser` 语音输入配置会迁移到 `windows-native`，不再调用网页录音功能。

「系统播报」在未使用克隆音色时可选：面板没开时由操作系统语音念任务提示。选中 `qwen-local` 克隆音色时，这个开关禁用，以免 Windows/macOS/Linux 的另一种声线冒充角色；任务播报由打开的面板使用克隆声线完成。

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 配置 / 会话 / 记忆 / 审计 | `%LOCALAPPDATA%\Amadeus` |
| 模型 / 素材缓存 | Windows 默认 `%LOCALAPPDATA%\Amadeus\cache`；可用 `AMADEUS_CACHE_DIR` 覆盖 |
| 运行态（端口 / token / pid） | `%LOCALAPPDATA%\Amadeus\runtime\daemon.json` |

密钥默认不落盘（环境变量 `AMADEUS_<NAME>` 优先）；Windows 上可选 DPAPI 加密存储。

### 分享前的隐私检查

本项目的发行包由 `config/dist-manifest.json` 白名单收集文件，打包时拒绝常见 API Key／私钥、个人 Windows 用户路径、邮箱与疑似手机号、运行数据文件，以及环境文件、数据库、录音和嵌套压缩包。测试也检查扫描器不会把命中的密钥片段写进错误信息。当前发行包不包含任何用户的会话、长期记忆、克隆音色、来电铃声或本机密钥；新用户必须使用自己的 Codex 登录，并自行配置可选语音服务。

请不要分享 `%LOCALAPPDATA%\Amadeus`、`%USERPROFILE%\.codex\config.toml`、本地 Qwen WebUI 的音色库或自己的参考音频。直接分享整个源码目录也可能带出 `work/`、`dist/` 的旧包、截图、日志和安装后生成的启动文件。若密钥曾在其他地方公开过，清理当前项目并不能使它恢复安全，应在服务商控制台轮换密钥。

### 数据会流向哪里

| 数据 | 默认路径 | 可选路径 |
| --- | --- | --- |
| 聊天文本 | 交给本机 Codex CLI；实际模型服务取决于你的 Codex 配置 | 发送到你配置的 OpenAI 兼容接口 |
| 合成语音文本 | 新安装默认不发送；启用后由选中的音色来源处理 | 本地 Qwen（文本发往 `127.0.0.1:7860`）、阿里云百炼、Edge 或本机系统语音，具体由面板选择；本地克隆不会静默换声 |
| 麦克风录音 | 交给 Windows 已安装的语音识别器；结果留在输入框待确认 | 识别器能否工作取决于系统语言包与麦克风权限 |
| 会话与长期记忆 | 保存在本机数据目录；长期记忆默认关闭 | 可从面板导出或删除 |
| Live2D 素材 | 安装时从资源注册表中的地址下载并校验哈希 | 使用哈希匹配的本地素材文件 |

## 许可

代码使用 [MIT 许可证](LICENSE)。角色、模型、音色版权归原权利方，素材按需下载，禁止商用。见 `NOTICE`。
