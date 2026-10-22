# Amadeus for Codex

牧濑红莉栖（Makise Kurisu）数字伴侣，面向 **Codex Desktop**：
红色翻盖手机面板 + Live2D + 日语语音 + 长期记忆 + 主动来电。

> **分享与隐私**：安装后产生的数据和密钥只属于安装者。检查不能保证未来的修改或用户自己另行加入的文件绝对安全。
> 状态：M0–M5 主体完成并实测通过（对话 / 语音 / 记忆 / 主动来电 / Live2D / 分发）；
> 剩余待办见 `docs/STATUS.md`。
> 功能设计、运行流程与边界见 [功能设计与说明](docs/功能设计与说明.md)；开发记录与剩余待办见 `docs/STATUS.md`。

## 快速开始

Windows 桌面安装：先安装 Node.js 22+，把发行 ZIP **完整解压**到固定目录，双击其中的 **`安装 Amadeus.cmd`**。它会注册 Codex 连接、检查并下载缺少的 Live2D 素材、打开面板；完成后重启 Codex Desktop。不要直接在压缩包预览窗口里双击，也不要只提取单个脚本。音色克隆仍按 [使用教程](使用教程.md#3-从零制作本地克隆音色) 单独完成，不随安装器自动安装。离线时素材下载可稍后在面板内重试。

进阶用户才需要下面的命令：

```powershell
node bin/amadeus.mjs doctor     # 能力自检
node bin/amadeus.mjs start      # 启动常驻 daemon
node bin/amadeus.mjs open       # 打开面板窗口（--browser 才用浏览器标签页）
node bin/amadeus.mjs status     # 查看状态
node bin/amadeus.mjs stop       # 停止
```

首次打开面板会显示可跳过的两步引导：先说明聊天、语音和录音的数据去向，再选择要启用的功能。以后可在「设置 → 使用引导」重新查看。

**没有现成音色？**从参考音频开始安装本地 Qwen、注册克隆音色、配置来电铃声的完整步骤见 [使用教程.md](使用教程.md)。本体安装不要求 Python；本地克隆语音另需 Qwen TTS WebUI。用户提供的红莉栖提示音来源及使用限制见 [参考音频说明](docs/参考音频说明.md)；发行包不转载该音频。

**要换成自己的角色？**模型、人设、固定台词和默认声线在源文件中配置，不在页面端切换。按 [角色替换教程](docs/角色替换教程.md) 编辑、校验并应用到已有安装。

## 目录

| 路径 | 内容 |
| --- | --- |
| `bin/` | CLI、daemon、MCP、notify 入口 |
| `src/core/` | 纯逻辑：配置、存储、记忆、会话、对话、语音、情绪、自检 |
| `src/host/` | 宿主层：HTTP 服务、鉴权、事件总线、适配器 |
| `src/panel/` | 面板前端（HTML/CSS/JS） |
| `tests/` | `node:test` 单元测试 |
| `config/` | 默认配置与资源清单 |
| `persona/` | 人设文本与角色固定台词 |

## 开发与验证

```bash
npm run check            # 一条命令前置检查：语法 + 分发清单 + 单元/契约测试
npm test                 # 只跑测试（无网络、无浏览器）
npm run dist             # 生成 dist/amadeus-codex-<version>.zip
npm run verify:api       # 校验面板运行所需的每个 URL 都能取到
npm run verify:ui        # 用系统 Edge/Chrome 无头渲染并截图（需先装素材）
npm run verify:tabs      # 隔离数据的真实双窗口回归，不调用在线模型或语音

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
powershell -ExecutionPolicy Bypass -File scripts\install.ps1              # 只注册 MCP
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

**打开 Codex 时面板会自己出现**：一个 **300×520 的小弹窗**，窗口为翻盖手机
（手机封顶 284×504，窗口再大也不会被拉伸；屏幕放不下时按屏幕高度的 72% 自动收窄）。
关掉窗口即可收工，尺寸可用 `AMADEUS_PANEL_SIZE=W,H` 覆盖。这一条**不依赖 Codex
hooks**：Codex 连接 Amadeus MCP 时会直接打开面板；登录后启动的 watcher 每 3 秒检查一次，
作为连接未建立时的备用路径。watcher 由隐藏的 VBS 守护，异常退出后会自动重启。一次 Codex
会话只自动打开一次；手动关掉后不会因同一会话中新建 MCP 连接再次弹出。用 `-NoAutoStart`
安装可以关闭自动打开。

也可以随时手动打开：双击插件目录里的 `Amadeus.exe`（安装脚本用 Windows 自带编译器现编译，
没编译器时生成 `Amadeus.cmd`），或 `node bin\amadeus.mjs open`。

## 默认行为：她是个陌生人

- **无记忆**：`memory.enabled` 默认关闭，不会抽取也不会召回任何长期事实。
- **单句连接**：`chat.oneshot` 默认开启，回完一句就断开（状态栏显示「已断开（单句模式）」），
  下一条消息从零开始，不带上一句的上下文。
- **语音与任务播报默认关闭**：首次使用引导可分别开启；已有配置保持原值。没有克隆音色时先按教程注册本地 Qwen 音色，再从「音色 → ＋ 导入…」选「本地 Qwen 克隆音色」。内置默认音色也可单独使用，但它不是克隆声线。
- **任务播报需明确开启**：安装脚本会写 Codex 的 `notify`（若你原本已有 notify，会把旧命令记到
  `%LOCALAPPDATA%\Amadeus\notify-chain.json` 并先转发给它）；开启语音与相应的任务开始／完成播报后，每个边界只播一段短句，但会轮换不同台词，不会连续重复。内部辅助任务不会单独播报。

对话模式、长期记忆与语音可在面板「设置」里调整。空闲主动开口与主动来电在新安装时默认关闭，需要分别开启；已有配置保持原值。回复生成期间，发送按钮会变成取消按钮；取消会中止后端请求。

日常对话使用 Codex 登录，但只在 Amadeus 的 `codex exec` 调用中将推理强度设为 `low`，不修改用户的全局 Codex 模型或推理设置。面板会显示「连接模型／等待回答／服务重试」等阶段，不展示模型内部推理；后端最多等待 60 秒，面板再留 15 秒接收结果或明确错误。如果 Codex CLI 到模型服务的请求超时，会明确指出连接故障，而不是把它当作角色在长时间思考。`GET /amadeus/chat?turnId=...` 可查阶段、耗时与首条回复耗时，审计记录仅写阶段和时间，不写提问原文。开启自动记忆时，纯闲聊或没有用户长期事实的提问不再追加第二次模型调用。

Windows 若启用了系统 HTTPS 代理，而 Amadeus 启动环境没有 `HTTPS_PROXY`，Amadeus 会读取当前用户的系统代理设置，只传给自己的 Codex CLI 子进程；已有 `HTTPS_PROXY`／`ALL_PROXY` 保持原样。不会修改 Windows 代理、全局 Codex 设置或其他程序。代理关闭或格式无效时不会注入。若面板显示「模型服务请求超时」，先确认系统代理可用及 Codex CLI 能连接模型服务。

音频样本不是动态音色：本地路径需先在 Qwen TTS WebUI 注册音频，得到 ID，再把该 ID 导入面板；阿里云路径则需先在云端完成复刻、取得对应账号的 ID。两种 ID 不通用。选中本地克隆后，点击角色、回答、接听后的语音和任务播报都走该声线；本地服务失败会明确报错，不会换成 Edge 或系统人声。来电铃声是单独的提示音，可用 `%LOCALAPPDATA%\Amadeus\sounds\incoming.wav` 自定义。详见 [从零克隆教程](使用教程.md#3-从零制作本地克隆音色)。

本地 Qwen 已配置的 Windows 用户重新运行安装脚本后，会添加隐藏的开机启动任务 `Amadeus Qwen TTS`，避免先打开 Amadeus 或 Codex 时 API 尚未启动。模型冷启动期间仍需稍等；任务不会切换或重制克隆音色。可用 `Get-ScheduledTask -TaskName 'Amadeus Qwen TTS'` 检查运行状态。

Codex 守候程序在新一轮连携打开面板时，或用户双击 `Amadeus.exe` 单独打开新面板时，播放一次开场白；刷新或重连不重复。说话期间，情绪标签驱动现有 Cubism 2 表情和轻微头部、视线过渡，语音结束后回到中性，并尊重系统的减少动态效果设置。当前本地 Base 克隆不支持显式情绪韵律参数；为保持克隆音色，不对音高和音色做后处理。

点击角色时，同一动作组会轮换不同的动作片段；空闲时的短句由当前选中的语音合成器朗读。生成或朗读回答时，点击仍有动作反馈，但不插入无关台词。Live2D 自带的原版语音不会自动播放。

语音输入有两种通道，在面板「设置 → 语音输入」里切换：

| 取值 | 识别在哪 | 说明 |
| --- | --- | --- |
| `browser`（默认） | 浏览器 | 免本项目的密钥；浏览器可能使用在线识别服务，具体由浏览器决定 |
| `api` | daemon → Whisper 兼容接口 | 需要语音密钥：面板里直接填，或设 `AMADEUS_STT_API_KEY` |
| `none` | — | 关掉麦克风输入 |

把 `AMADEUS_OPENAI_BASE_URL` 指向本机的 whisper 服务（whisper.cpp / faster-whisper / LM Studio 等）
时密钥可以留空，**音频不出本机**；模型名用 `speechInput.apiModel` 覆盖（默认 `whisper-1`）。
录音只经过内存，不写盘；日志里只记字节数，不记内容。配置了 `api` 但没配密钥时，
面板会自动退回浏览器识别并在对话里说明原因，而不是让麦克风按钮变成死的。

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
| 麦克风录音 | 交给浏览器识别；浏览器可能使用在线服务 | 发送到配置的转写接口；接口指向本机时音频留在本机 |
| 会话与长期记忆 | 保存在本机数据目录；长期记忆默认关闭 | 可从面板导出或删除 |
| Live2D 素材 | 安装时从资源注册表中的地址下载并校验哈希 | 使用哈希匹配的本地素材文件 |

## 免责声明

代码使用 [MIT 许可证](LICENSE)。角色、模型、音色版权归原权利方，素材按需下载，禁止商用。见 `NOTICE`。

资源来自网络，仅供学习交流，如有侵权请联系删除。

本项目为个人学习项目，非商业用途

Live2D 模型、音频等资源版权归原作者所有

使用本项目产生的任何问题，作者不承担责任

如有版权问题，请联系删除相关内容

## 致谢
红莉栖 Live2D 模型资源来自开源社区。

感谢如下项目的参考： `Lx1228/Amadeus2026` `FuRongJun-1999/lingshu` `yyxcnasd/amadeus-for-dsh` `sola1039/HAST-SEC`

感谢所有开源社区贡献者
