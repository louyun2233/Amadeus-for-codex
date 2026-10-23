# 实现进度

对照《Codex 迁移方案》的里程碑。每次进度变化都更新本文件。

## 当前修订（2026-10-17）

2026-10-23 记忆修订：事实不再因容量上限静默淘汰；聊天提要与长期事实分层，修复提要倒序清理；自动抽取只读用户原话并做证据校验；中文召回改为双字片段，移除无关最近八条的固定注入；记忆写入增加 `.bak`，损坏时拒绝空库覆盖。恢复说明见 [记忆机制与备份](记忆机制与备份.md)。

- 修复单句模式 `closed` 状态从核心到面板的转发。
- 修复 SSE 同一标签页重连时旧连接误删新连接的问题；语音队列在离线期间暂停 ACK 超时。
- 同一会话的对话按顺序运行；单句模式的并发请求使用独立会话。
- 增加生成取消按钮与后端中止；Codex 输出设容量上限，模型请求设超时。
- 启动时校验已保存的配置，修正只有摘要记忆时容量上限失效的问题。
- 补齐许可证、依赖锁文件与版本一致性检查，更新数据路径说明。
- 双窗口真实浏览器回归改为隔离执行：模拟模型与语音，验证焦点转移、语音唯一归属、会话同步及取消，不触碰现有运行数据。
- 面板状态增加读屏播报，输入框补可访问名称，并恢复清晰的键盘焦点轮廓。
- 增加可跳过、可返回、可重开的两步首次使用引导，说明数据去向并保存功能选择；新安装的语音与任务播报默认关闭，旧配置保留。
- 将会话与对话 HTTP 路由从大型 daemon 文件拆到 `src/host/chat-routes.mjs`；首次引导逻辑独立为 `src/panel/onboarding.js`。
- 将记忆与音色 HTTP 路由继续拆为独立模块；接口路径与响应格式保持不变，分发清单及接口契约检查同步覆盖新模块。
- 角色点击动作轮换同组 3 段并匹配对应音效；回答进行中只保留动作反馈，不插入点击台词或原版语音。可导入已复刻的阿里云音色 ID；样本音频不会自动上传。音色稳定模式避免云端失败时突然换声线。

下一阶段：继续按职责拆分 daemon/面板的大型模块；新安装的主动来电和空闲主动开口均分别选择开启，既有配置保持原值。

## 已完成

### M0 骨架 ✅

- 零运行时依赖的 ESM 工程（`package.json`，`engines.node >= 22`）
- daemon 进程：单实例锁、随机端口、`runtime/daemon.json` 记录 `{pid, port, token}`
- 鉴权：Bearer（CLI/MCP/hook）+ 一次性 `?token=` 换 HttpOnly 会话 cookie（浏览器）
- 只监听 `127.0.0.1`；非回环请求一律 403
- 静态资源路由带路径归一化（`..`、`\0`、符号链接逃逸均拒绝）
- 事件总线：SSE + 带 ack 的语音队列（超时重投、上限 3 次、丢弃原因可查）
- 插件形态：`.codex-plugin/plugin.json` + 4 个 skill（panel / voice / memory / status）

### M1 存储与配置 ✅

- `core/store`：原子写（临时文件 + rename），无原生依赖
- `ConfigStore`：《白名单 + 类型/范围校验》的 patch，未识别字段进入 `rejected[]` 返回给调用方
- `SecretStore`：环境变量优先，Windows 走 DPAPI 加密落盘；其它平台**拒绝**明文持久化并提示改用环境变量
- `SessionStore`：伴侣会话（独立于 Codex thread），消息落盘，路径穿越防护
- `MemoryStore`：`panel` / `codex` 双命名空间，去重、容量上限淘汰、检索（词频 + 时间衰减 + 标签加权）、清空/导出
- `AuditLog`：所有变更操作留痕（写入摘要截断，不含密钥）
- 配置下发一律经 `maskConfig` 脱敏；密钥只以 `{configured, source}` 形式暴露

### M2 对话链路 ✅（已实测跑通）

- `CodexExecAdapter`：`codex exec --json --ephemeral --skip-git-repo-check -s read-only -C <中立目录> -o <file>`
  - 复用用户 Codex 登录与模型，**零额外 API key**
  - 不污染用户的 Codex 会话历史（`--ephemeral`）
  - 未使用 `--ignore-user-config`，以便继承用户的 provider 配置
  - 在空目录里运行，避免伴侣因闲聊读到用户项目
- `OpenAiCompatAdapter`：可选独立 API key 通道（SSE 流式）
- `ChatEngine`：记忆召回 → 提示词组装 → LLM → 解析 → 落库 → 异步记忆维护
- 上下文压缩（阈值 40 / 保留 20）与记忆抽取（每 6 轮）
- 实测：一轮对话 4 秒返回，格式与情绪均正确解析

### M3 语音链路 ✅ 主要部分

- **Node 原生 Edge TTS**（`core/edge-tts.mjs` + `core/ws-client.mjs`）
  - 自实现 RFC6455 WebSocket 客户端（无需 `ws` 依赖），因为内置 WebSocket 无法设置请求头
  - 复现 `Sec-MS-GEC` 时间令牌与 `muid` cookie，定位到服务端当前要求的 Chromium 版本 143
  - 实测：中文/日文合成成功，返回词级时间戳（`{o,d}`，毫秒）
  - **Python 已从主链路移除**（方案风险 R1 关闭）
- **`<mstts:express-as>` 已移除**：服务端对该扩展返回 WebSocket 1007，且它是上游的非官方 monkeypatch。
  改为纯 prosody（音调/音量）表达情绪，附带好处是声线身份稳定、无并发竞态
- `TtsService`：磁盘 LRU 缓存（上限 200 条，替代上游约 240MB 的内存驻留）、并发同请求合并、provider 降级

### M4 Live2D 真实渲染 ✅（素材层已端到端验证）

- **M4.1 解包器**（`src/core/tar.mjs`）：Node 无内置 tar，因此自实现最小 ustar/pax 读取器 +
  `node:zlib`。严格的拒绝策略：绝对路径、`..`、反斜杠、符号链接/硬链接/设备文件、
  超长路径、条目数上限、单文件与总展开上限（zip-bomb）、头部校验和。
  `writeEntries` 还会二次校验落点必须留在目标目录内。
- **M4.2 注册表 + 下载器**（`config/assets.registry.json` + `src/core/assets.mjs`）：
  SHA-256 写死；多源回退 + 单源 3 次重试 + `Range` 断点续传；边写边算哈希；
  只允许注册表声明的 URL，且明文 HTTP 仅限回环（面板永远无法传 URL，堵掉 SSRF）。
- **M4.3 安装 / 校验 / 原子切换**：解包到 `.staging-*` 目录，校验入口文件与 `model.json`
  结构后才 `rename` 成正式版本并更新 `manifest.json`；失败则保留旧版本。
  路由 `/amadeus/assets/current/*` 与 `/amadeus/assets/runtime/*` 由 manifest 解析。
- **M4.4 面板渲染**（`src/panel/live2d.js`）：pixi 7 → live2d.min.js → pixi-live2d-display
  cubism2 的加载链；绑定 `PARAM_MOUTH_OPEN_Y`（口型）、`PARAM_EYE_L/R_OPEN`（眨眼）、
  `PARAM_ANGLE_*`/`PARAM_BODY_ANGLE_*`/`PARAM_EYE_BALL_*`（待机飘移）；情绪 → `f01–f04`
  表情；点击命中 head/mouth/body → `flick_head`/`tap_body`/`pinch_in`。任一失败回退 Canvas 占位图。
- **M4.5 真机端到端**：真实下载并安装（模型 8.63 MB / 48 文件，运行时 129 KB），
  `assets ready = true`；`scripts/verify-panel.mjs` 逐条拉取渲染所需的 41 个 URL，全部 200。

**M4 未做（有意）**：动作音效播放。归档里的 15 个 mp3 会被解包并可通过
`/amadeus/assets/current/sounds/*` 取到（已在验证脚本中覆盖），但**不播放**——
播放动作音效会与 TTS 抢音频通道，留作后续：音频通道需要先支持混音/优先级。

**M4.5 像素级目视已闭环**（2026-10-10）。本会话的 `node_repl` 不带浏览器插件所需的特权管道
（`setResponseMeta`/`nativePipe` 缺失，node v20），因此改用 `playwright-core` 驱动本机
Edge 155 无头渲染并截图核对。四张截图存于 `docs/screenshots/`。

目视过程一共抓到 **5 个只看代码发现不了的问题**，全部已修：

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | Live2D 完全不渲染，pixi 报 "does not support WebGL" | `panel.js` 在加载时就对 canvas 调了 `getContext('2d')`，同一个 canvas 之后永远拿不到 WebGL 上下文 | 占位图改用独立的 `#avatar-fallback` canvas，2D 上下文按需惰性获取 |
| 2 | 模型渲染了但被占位图盖住（只见右上角一角衣袖） | `.css` 里的 `display:block` 覆盖了 `[hidden]` 的 `display:none` | 增加 `#avatar[hidden]{display:none!important}` |
| 3 | 角色跑到画面外/严重偏右 | 用模型原点当锚点；Cubism 2 的 `getBounds()` 包含隐藏部件，其中心≠可见角色中心 | 改为先测 `getBounds()` 求 fit，再按"绘制范围中心"对齐目标点；残余偏移用注册表 `layout.x` 校正 |
| 4 | 眼睛卡在闭合并保持，动作与眨眼状态互相打架 | pld 的 `Live2DModel` 默认挂在 `Ticker.shared` 上自动更新，形成第二条更新循环，覆盖了面板写的参数 | 创建模型时 `autoUpdate:false`，只保留面板自己的单条 rAF 循环 |
| 5 | 注册表里的 `layout`/`expressionMap` 调整不生效 | 安装清单里没保存布局，`/amadeus/assets/status` 也没返回，面板拿不到 | 状态接口按注册表返回 `layout`/`expressionMap`，面板透传给渲染层 |
| 6 | 口型同步看起来接好了，实际完全不动 | 参数写在 `model.update()` **之前**，被动作/物理每帧覆盖 | 改为先 `model.update()` 推进动作与物理，再写面板自己拥有的参数 |
| 7 | 换成"开心"后脸上还留着"生气"的撇嘴 | 表情文件的 `f01` **参数是空的**（no-op），应用它不会清掉上一个表情；且我原来按猜测把 f04 当"疑问"，而 f04 真实参数是睁大眼+kirakira+脸红 | 按四个表情文件的真实参数重做映射（f02 忧郁 / f03 生气 / f04 惊讶害羞），未映射的情绪显式复位表情 |

**口型与表情的像素级验证**：驱动 `setMouth(1)` 后截图确认嘴部确实张开（此前读回参数为 0 是探针读了另一个存储，
以像素为准）；情绪切换后眼睛开度与嘴形有可辨认变化。需要说明的是，这个模型的四个表情幅度本身很克制
（f03 只改眉形、嘴形、嘴宽与身体下沉），所以静态截图上的差异不大——这是模型资产的特性，不是绑定问题。
眨眼已用参数采样确认是 `1 → 0 → 1` 的正常循环（修复前会卡在 0）。

另外顺手修了两处排版问题：面板高度改成 `clamp(280px, 44vh, 420px)` 让立绘有竖向画框；
自检页长路径横向溢出（`.list.mono` 加 `overflow-wrap:anywhere`）；音色选项文字在 select 里被截断。

屏幕截图：`docs/screenshots/panel-chat.png`（对话 + Live2D）、`panel-settings.png`、
`panel-diag.png`、`panel-degraded-no-assets.png`（模型未安装时的降级 UI）。

### 已提供的面板

- 翻盖手机 UI、暗红主题、状态胶囊、时钟
- Live2D 真实模型渲染（缺失时回退到 Canvas 占位角色：呼吸、眨眼、情绪红晕、嘴型跟随音频能量与词包络）
- 对话（SSE 流式）、语音输入（浏览器 Web Speech）、来电浮层
- 记忆页（列表 / 删除 / 清空 / 导出）、设置页（语音、模型通道、工具预授权、播报开关）、自检页
- Live2D 真实模型接入点已留出：`GET /amadeus/assets/*` + manifest 缺失时走 placeholder

### M5 Codex 集成 ✅ 主要部分

- MCP stdio server：11 个工具，工具面覆盖状态/能力/记忆/发声/来电/面板/会话
- 权限分级落地：只读免确认；写记忆免确认但留审计；`say`/`call` 需预授权，否则返回
  `{code:"needs_confirmation"}` 结构化结果；清空记忆要求 `confirm:true`
- `amadeus-notify.mjs`：Codex `notify` hook → daemon；播报默认关闭，且**不接受 turn 结束作为完成信号**
- `scripts/install.ps1`：幂等注册 MCP（写 `config.toml` 前自动备份）、建数据目录、启动 daemon

## 面板加固 pass（2026-10-10）

针对"前端健壮性"自查出的问题做了一轮加固。面板从 **822 行单 IIFE** 拆成 6 个模块：

| 模块 | 职责 |
| --- | --- |
| `src/panel/main.js` | 启动与装配、turn 归属、超时、渲染循环、全局错误钩子 |
| `src/panel/transport.js` | HTTP + SSE；重连去重；**唯一**的错误上报出口 |
| `src/panel/audio-queue.js` | 播放队列：去重、看门狗超时、objectURL 全路径回收、口型取值 |
| `src/panel/live2d.js` | 渲染器：加载链、fit/relayout、上下文丢失回调、单循环 |
| `src/panel/placeholder.js` | 占位渲染（独立 canvas） |
| `src/panel/views.js` | 对话 / 记忆 / 设置 / 自检四个视图 |

逐条对应之前列出的弱点：

| 弱点 | 处理 |
| --- | --- |
| 未按预期发生时页面失去正确性 | 对话轮次 120s 超时、播放看门狗超时、SSE 断开后 20s 宽限再判定丢失；所有异步交互补 catch 并上报 |
| 两件事同时发生 | `turnId` 归属校验（不属于本标签页的 chunk/done/error 直接丢弃）；语音按 utterance id 去重；SSE 重连时对 `hello.pending` 去重，避免重播 |
| 环境变化 | `ResizeObserver` → 重设画布后备尺寸并 relayout；已实测 392x394 → 392x280 跟随容器（修复前后备不变、纵向被压 29%）；监听 `webglcontextlost` 退回占位图 |
| 可维护性 | 拆模块；验证脚本从临时目录移进仓库（`scripts/ui/`）；`npm run verify:api` / `npm run verify:ui`；设置页改为**就地同步**控件值，不再每次重建 DOM |
| 错误边界 | `window.onerror` + `unhandledrejection` 钩子；daemon 新增 `POST /amadeus/report` 与 `GET /amadeus/logs`；渲染循环包 try/catch，抛错即降级为占位图并提示；自检页展示最近的客户端错误 |

新增的 UI 回归（`scripts/ui/verify-ui.mjs`，用系统 Edge/Chrome 无头运行）覆盖 8 项，
包括"画布跟随容器"和"客户端错误进入 daemon 日志"——两条都是这轮新修的。
`playwright-core` 只是 devDependency，不下载浏览器。

仍未处理（有意留下）：把嘴型倍数与 fit 系数也挪进注册表；多客户端（多标签页）共享一个会话
仍没有"谁拥有这个会话"的概念，目前只保证单标签页内的 turn 归属正确。

## 主动交互调度器（2026-10-10）

`src/core/scheduler.mjs`——被动等待之外的第一块"她主动找你"的能力：到点打电话、安静太久主动开口。

设计上把**时间、配置、听众、模型、投递**全部注入，所以规则本身是纯逻辑，15 个单元测试不需要真定时器：

- 首次运行只建立基线，不会立刻打电话
- 任意两条主动台词之间有 10 分钟下限，来电与空闲不会贴着连着来
- 机器休眠 / 时钟跳变只产出**一条**，不会补一串"错过的"来电
- 没有面板连着、正在对话中、语音关闭时，一律不出声
- 模型生成失败或返回空内容 → 回落内置台词，不会静默
- tick 抛错、投递抛错都被包住并上报，不会打死驱动它的定时器

状态持久化在 `DATA_DIR/proactive.json`（`lastCallAt` / `callCount` / `lastUserAt` / `lastProactiveAt`），
所以重启不会立刻再来一通电话。面板里任何真实互动（对话、手动发声、手动来电）都会重置空闲时钟。

接口：`GET /amadeus/proactive`（状态）、`POST /amadeus/proactive/tick`（强制执行一次判定，便于测试）；
MCP 工具 `amadeus_proactive`；面板设置页新增"空闲多久开口""来电间隔"两项，自检页显示调度状态。

### 这轮自查出的两个真问题

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 生成成功的台词被静默丢弃，永远说兜底台词 | 调度器读 `parsed.jp`/`parsed.cn`，而 `parseReply()` 返回的是 `ja`/`zh`——字段名对不上。**单元测试没抓到，因为测试替身恰好返回了被假设的字段名** | 默认解析器改成直接调用真实 `parseReply` 并在内部做映射，同时补一条使用真实解析器的回归测试 |
| 主动台词会把情绪标签念出来 | `parseReply().ja` 保留每句的 `【emotion】` 标签（对话路径用的是去标签分句，所以没暴露） | 默认解析器用 `stripTags` 清洗后再交给 TTS |

另外补了一个可观测性缺口：daemon 是分离进程、stderr 被丢弃，`warn` 级也不进审计日志，导致
"为什么走了兜底"完全查不到。现在调度器的降级会记入审计日志。

### 实测

把状态种成"很久没联系"后重启，打开面板并强制执行一次判定：

```
tick decision:        {"action":"call","reason":"due"}
call overlay:         visible=true  text="喂喂，我是红莉栖。听得见吗？"   ← 模型生成，非兜底
after tick:           callCount 0 → 1
immediate second tick:{"action":"none","reason":"cooldown"}
page errors:          []
```

截图：`docs/screenshots/panel-incoming-call.png`。

## 分发打包（2026-10-10）

`config/dist-manifest.json` 是打包与安装共用的**单一真相源**：打包脚本按 `include`/`exclude`
收集文件，安装脚本按 `requiredForInstall` 做前置校验，`tests/dist.test.mjs` 保证两者不漂移。

- `npm run dist` 直接写 ZIP（Node 无内置 zip，自实现 deflate + CRC32，不引依赖），
  产物落在 `dist/amadeus-codex-<version>.zip`，内部有一层 `amadeus-codex-0.1.0/` 顶层目录，
  解压不会把 bin/ src/ 铺进用户当前目录。
- `scripts/install.ps1`：预检（Node 版本 + 逐文件存在性，缺件一次性列全）→ 备份 config.toml →
  写临时文件再 `Move-Item` 覆盖 → 注册 MCP → 启动 daemon；`-Uninstall` 移除注册并保留数据；
  `-NoStart` 只注册。
- `docs/INSTALL.md`：安装 / 打开面板 / 装素材 / 升级 / 卸载 / 手工注册（Linux/macOS）/ 排查表。

### 跑起来才暴露的两个真问题

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 解压后的 `install.ps1` 直接**语法错误**（`The string is missing the terminator`），中文串显示为 `瀹屾垚銆傞噸鍚?` | Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI 读取 `.ps1`；我加的中文文案变成乱码并吞掉引号 | 脚本改回 **ASCII-only**，并加测试断言所有 `.ps1/.bat/.cmd` 不含非 ASCII 字节、不带 BOM |
| `ConvertFrom-Json` 解析 `dist-manifest.json` 失败 | 同一编码问题的第二处，这次是 `Get-Content -Raw` 把 UTF-8 清单当 ANSI 读 | 不再用 `Get-Content`/`Set-Content` 处理可能含非 ASCII 的文件，改用 .NET `ReadAllText` / `WriteAllText` + `UTF8Encoding($false)` |

第二处修复顺带堵掉一个更严重的隐患：原来的卸载逻辑用 `Get-Content` 读、`Set-Content -Encoding UTF8` 写，
会把用户 `config.toml` 里的**非 ASCII 内容改坏**。现在读写都是显式 UTF-8 无 BOM。

### 实测（全部在隔离的 CODEX_HOME 中，未触碰真实配置）

```
1) 首次安装           exit 0 · 注册块 1 · 中文注释/值原样保留 · 生成备份
2) 重复安装           exit 0 · 注册块仍为 1（幂等）
3) 发行包缺一个文件   exit 1 · 明确指出缺哪个 · config.toml 哈希未变化
4) 卸载               exit 0 · 注册块 0 · 中文内容原样保留 · 生成第二个备份
5) 解压包独立运行     无 node_modules，health/assets/proactive 均 200，doctor 通过
```

发行包：74 个文件 / 826 KiB → ZIP 287 KiB。

## 模块对齐审计 + CI（2026-10-11）

不整合、只逐层验收模块之间的**接口边界**。方法是从各层的真实数据里抽取集合再求差集，
而不是靠读代码猜。已确认一致的：配置键读取、面板写入路径、13 条面板 API 路径对 daemon 路由、
11 个 SSE 事件名双向一致、表情枚举（core ↔ 注册表 ↔ 占位渲染）、密钥名、记忆命名空间。

发现并修复 **5 处不对齐**：

| # | 问题 | 修复 |
| --- | --- | --- |
| 1 | `defaults.json` 的 `assets.sources` 无任何代码使用，且与注册表的 sources 重复 | 删掉，源头只保留注册表 |
| 2 | daemon 发 `assets:progress`，面板从不处理 → 8.6 MB 下载期间只有"安装中…" | 面板接上进度（下载百分比 / 解压 / 完成） |
| 3 | daemon 发 `shutdown`，面板从不处理 → `amadeus stop` 后状态栏仍是旧值 | 停止时置为"daemon 已停止"并清空本地队列 |
| 4 | `EventHub.clear()` 零调用，`cleared` 事件与面板监听都是死代码 | 打通：`/amadeus/action {cmd:'clear'}` → 广播 `cleared` → 面板清本地队列，并补了设置页的"清空语音队列"按钮 |
| 5 | 5 个 MCP 工具（`assets_status`/`assets_install`/`call`/`proactive`/`sessions`）在任何 skill 里都没被提到 | 分别补进 status / voice / panel 三个 skill，模型才知道何时用 |

### 固化为测试

`tests/compat.test.mjs`（12 条）把上面每条接缝都变成断言：配置键↔默认值↔白名单、
面板写入路径⊆白名单、MCP 工具名↔skill 引用（双向）、面板路径↔daemon 路由、
SSE 事件名双向集合相等、表情枚举跨模块一致、密钥名、记忆命名空间、
TTS 词时间戳响应头名、CLI 命令↔帮助文本。

写这条测试时自己也踩了一次同类问题：最初用裸 `get('x')` 提取密钥名，把
`searchParams.get('text')` 也当成了密钥，测试立刻失败并列出 10 个假阳性——
说明断言失败信息足够可读，也说明提取器必须收窄到 secret store。

### CI

`.github/workflows/ci.yml`：

- `test` 作业（ubuntu + **windows** 矩阵）：`npm test` → `npm run dist` → 上传发行包；
  Windows 上额外跑 `scripts/verify-install.ps1`。之所以要 Windows，是因为前两次真 bug
  （ANSI 解码 UTF-8、乱码吞引号）在 Linux CI 上永远看不见。
- `ui` 作业：装素材 → 校验每个渲染 URL → 无头渲染截图。标为 `continue-on-error`，
  因为它依赖第三方站点下载模型，天生会抖；真正的硬门禁是 `test` 作业。

`scripts/verify-install.ps1` 把之前临时敲的安装器 e2e 变成可复跑脚本（12 项断言，
全部在隔离的 `CODEX_HOME`/数据目录里，不碰真实配置）。

本机实测：`npm test` 89/89、`node --check` 0 失败、`verify-install.ps1` 12/12、
`verify:ui` 全过、发行包 76 文件 → 295 KiB。

## 多标签页会话归属（2026-10-11）

真实缺陷是**可听见的**：`EventHub` 把语音事件广播给所有连接，于是两个标签页同时朗读同一句；
新开的标签还会收到未 ack 的队列并**重播**正在说的内容；两个标签共用一个会话，
一边发消息另一边要刷新才能看到。

设计是三条规则：

1. **客户端身份**：每个标签在 `sessionStorage` 里持有一个 id（同标签刷新不变，不同标签不同），
   API 走 `X-Amadeus-Client` 头，SSE 走 `?client=` 查询参数（EventSource 不能设头）。
2. **语音单播**：同一时刻只有一个"语音归属者"。`utterance` 只发给它；
   `hello` / `pending` 的队列也只发给它；归属者掉线时自动移交给幸存者并把队列带过去。
   谁获得焦点谁就 `POST /amadeus/client/active` 抢归属——语音跟着用户在看的那扇窗。
3. **会话增量同步**：消息落库后广播 `session:append`，其他标签就地追加；
   发起方按 `origin === 自己的 clientId` 跳过，避免重复追加。

同时把 `chunk` / `turn:done` / `turn:error` 从"广播"改为"按 origin 单播"——
归属也不再依赖 `turnId` 的巧合匹配。

### 这轮出的三个问题（都是流程本身抓到的）

| 现象 | 根因 | 抓到它的是 |
| --- | --- | --- |
| 面板里 `session:append` 的处理函数永不触发 | 我在 `main.js` 里写了处理，但 `transport` 的订阅清单里没加这个事件名 | `tests/compat.test.mjs` 的"SSE 事件名双向一致" |
| `POST /amadeus/chat` 返回 `url is not defined` | 该 handler 只声明了 `(req, res)`，而我改成用 `url` 取客户端 id | 双标签 e2e 的对话步骤 |
| 契约测试误报 `chunk`/`turn:done`/`turn:error` 没人发送 | 提取器只认 `broadcast`/`#send`，认不出新增的 `sendTo`/`sendToOrigin` | 契约测试自己（假阳性，但也说明断言必须覆盖全部发送方式） |

两次 e2e 失败还各有一次是**我的断言写错**：一次用裸 fetch 冒充某标签发起对话，
于是该标签合理地认为"我自己已渲染"；一次把历史消息算进了本轮增量。
两处都改成走真实 UI 路径 + 断言增量。

### 验证

`tests/hub.test.mjs`（12 条）覆盖归属规则：首个客户端成为归属者、第二个不收队列、
语音只给归属者、抢归属会把队列移交、重复抢是 no-op、未知客户端被拒、
归属者掉线后移交、无人连接时队列保留、ack 后不再重播、失败的 ack 会重投、
同 id 重连保留归属、`sendTo` 只到一个人。

`scripts/ui/verify-two-tabs.mjs`（`npm run verify:tabs`）用两个真实标签页验收：

```
PASS  two tabs get distinct client ids
PASS  daemon sees both clients                      clients=2
PASS  exactly one audio owner
PASS  only the owner fetches audio                  owner=1 other=0
PASS  focus transfers ownership
PASS  the new owner plays, the old one stays silent  owner=1
SKIP  cross-tab chat sync (需 AMADEUS_TWO_TAB_CHAT=1)
PASS  no script errors in either tab
```

开启聊天那一步时实测：`A 4 -> 6`、`B 4 -> 6`，即**发起方恰好 +2（重复追加会 +4）**、
另一标签**同步 +2**。

## 从外部资料回补既有模块（2026-10-15）

按给到的《剧情模式：多 AI 角色对话实现说明》与两个仓库，回头补**已经做完的部分**，不开新任务。

先分清许可，这决定了能拿什么：

| 来源 | 许可 | 采取方式 |
| --- | --- | --- |
| `FuRongJun-1999/lingshu` | **MIT** | 可移植机制（已署名，见 NOTICE） |
| `sola1039/HAST-SEC` | **非商业自定义许可** | **只学思路，不搬一行代码** |
| 《剧情模式》说明文档 | 文档 | 只取与单角色项目相关的原则 |

### 回补 1：记忆的矛盾/更正语义（lingshu，MIT 移植）

原来的记忆只会"完全相同去重"：`用户对花生过敏` 与 `用户对花生不过敏` **两条都留着**，
检索可能把过时那条喂进她的提示词。

移植要点（`src/core/contradiction.mjs`）：

- **只在近重复对上做差分**——误报面由闸门限定，而不是靠更聪明的检测器；
- 差异片段判**极性**（否定标记，并豁免「非常/无论/未来」这类含"不"却不否定的词）、
  **数值**（两侧数字多重集不同）、**反义**（已/未、在线/离线、通过/否决…）；
- 我的简化：用共同前后缀代替逐块字符对齐，注释里写明丢失的只是罕见的双反义情形；
- 闸门补了一条"共同前后缀占比"——`服务器在线/离线` 的 bigram Jaccard 只有 0.33，
  单靠 Jaccard 会漏掉短句更正。

存储层语义（原项目缺的部分）：

- 命中更正 → 旧条目记 `supersededBy / supersedeKind / confidence=0`，**留在盘上可审计**，
  但默认不再被 `list`/`search` 返回，**不会再进她的提示词**；
- 新条目记 `supersedes`；`stats` 增加 `active / superseded`；
- `?includeSuperseded=1` 看全部；写入时 `supersede:false` 关闭该行为。

daemon 端到端实测：

```
POST 用户对花生过敏 → POST 用户对花生不过敏
默认视图          : 只剩「用户对花生不过敏」
includeSuperseded : 旧条目 supersededBy=<新 id> kind=polarity
统计              : total=2 active=1 superseded=1
```

`tests/memory-supersede.test.mjs`（11 条）场景改编自对方 `bench_correction.py` /
`bench_supersede.py`：三类更正各一条、**同义改写不得误判**（标点/语气词）、
含"不"的非否定词不误判、`喜欢猫/喜欢狗` 这类可并存事实不得互相取代、
连续更正只留最新、关闭开关后两条都留。

### 回补 2：一行命令导入自备模型（思路来自 HAST-SEC，未取代码）

`AssetManager.installFromFile` 早就写好，却**没有任何入口**——路由和命令都没有。现在补上：

```powershell
node bin\amadeus.mjs assets install-file kurisu-model "D:\你自己\kurisu.tar.gz"
```

三种分支实测：哈希匹配 → `ok:true, installed:true, fileCount:48`；
错误文件 → `ok:false` 且打印 expected/got 两个哈希；缺参数 → 用法 + 退出码 1。

### 回补 3：一条前置检查命令（思路来自 HAST-SEC）

`npm run check` = 全部 .mjs/.js 语法 + 分发清单指向真实文件 + 单元/契约测试：

```
PASS  syntax: 55 files parse
PASS  distribution manifest points at real files
PASS  unit + contract tests  ℹ tests 112  ℹ 112 pass
```

### 回补 4：检索的近因自增强（lingshu 机制 2）

lingshu 的更新能力不来自矛盾检测，而来自 `search → last_access → recall`：
**你在反复问的事会保持靠前**。我原来的检索**读的时候不写任何状态**，一个几十天前的事实
和刚被问过的事实排序权重完全一样。

现在：条目多一个 `lastAccess`；`search()` 命中后回写（**节流 60 秒**，一次查询风暴不会写十次）；
排序用的时间取 `max(ts, lastAccess)`。

**但没有照搬**——对方自己的 `bench_recall_drift.py` 就是为了暴露这套机制带来的漂移，
所以这里加了一条护栏：**加成 7 天后过期**，之后回落到创建时间的近因，
否则"被碰过一次"的事实会永远霸榜。`list()` 仍按创建时间排（那是时间线，不是检索排名）。

`tests/memory-recall.test.mjs`（6 条，场景改编自对方 `bench_recall_drift.py`）：
反复问的事排到前面、**加成会过期**、同一瞬间十次查询只写一次时间戳、
boost 一条不会饿死其它条、只读查询可关掉回写、被取代的事实永远不会被加成。

### 回补 5：把误报**量出来**（lingshu 机制 1 的纪律）

对方的纪律是"在真实语料的近重复对上统计比例并打印样例人工核对"，而不是靠几条样例下结论。
我没有现成语料，于是构造了**可控且可复现**的一份：10 条事实 × 7 种**保持真值**的改写
（标点、语气词、每日/每天、特别注意/非常注意、空格），凡是命中都是误报；再加 8 条真更正量漏检。

第一次跑出来的读数就是有用的：

```
near-duplicate pairs judged: 41; false positives: 0 (0.0%)
corrections: 8/8 detected   kinds: {"polarity":4,"number":3,"antonym":1}
```

误报 0，但**反义那一类被标成了 polarity**：`获得通过 → 被否决` 里「否」既是否定标记、
又是反义词的一半，而极性先判。这不是 bug，是与参考实现一致的类型重叠
（`未` 同样如此）。所以契约改成：**必须检出**，`number` 精确（它先于差分判定），
`polarity/antonym` 允许互相标注——`supersedeKind` 只用于审计展示，不参与决策。

这条正是"量化"才能发现的：只跑几条样例时，我会以为自己分类得很准。
`tests/contradiction-bench.test.mjs`（3 条）把两个比率固定下来，任一方向退化都会红。

### 回补 6：调度器状态化（《剧情模式》文档最值钱的一条）

文档的核心是"谁开口不该由固定轮转决定，而由**内在状态**决定；并且导演只给**增量**、不给绝对值"
（给绝对值会让数值剧烈跳变、性格不稳）。我是单角色，没有"谁开口"的问题，但有同一个病：
**固定 `idleMs` 到点就说话，她此刻想不想开口完全不参与决策**。

映射成单角色的两个量：`will`（现在有多想开口）、`part`（对当前话题的投入度），
而 `drift = 100 - part` 是**推出来的、不存储**——文档明确这两者必须是同一根条的两端。

关键取舍：**`will = 50` 时行为与改前逐字一致**（缩放因子恰为 1.0），
所以既有的 15 条调度器测试一条都不用改。状态只在她更想/更不想说话时产生偏移：

```
will 100 -> 阈值 x0.5     will 50 -> x1.0     will 0 -> x1.5
```

增量来自**已有的信号，不额外调模型**：被搭话 +6，提问 +6，长消息（≥40 字）+4，
短时间内来回 +4；`part` 同向但幅度不同。每 tick 向基线衰减 5%，所以一次兴奋不会永久有效。

`tests/scheduler-mood.test.mjs`（6 条）：缩放因子的基线与上下界、
提问比陈述更能提升意愿、被钳在 0–100、`drift` 恒等于 `100-part`、
兴奋会衰减回基线、**高意愿时在配置的 idleMs 之内开口**、低意愿时即使到了 idleMs 也不开口。

顺手抓到并修掉的两个问题：一是测试里漏了"首次 tick 只建立通话基线"这一步
（低意愿那条因此**因为错误的原因通过**，已补上基线并注明）；二是发现
**衰减会让门槛在每次 tick 时上移**（will 100→97.5→95.1，阈值 30→31.5→32.9 分钟），
这不是缺陷而是真实性质，测试改成断言"明显越过"并直接断言"在 idleMs 之内开口"。

### 回补 7：记忆的出处（lingshu 机制 3 的落地版）

lingshu 的 `recall_with_evidence` 让召回**带上"为什么信这条"**，并且被撤回的结论不得当作事实给出。
单角色的落地是两件事：

1. **她能把出处说出来**——记忆条目进入提示词时附带「时间 + 来源」括注，
   人设约束里补一句"可以自然引用（你上次跟我说过），但不要说'记忆数据'这类词"。
2. **用户能审计**——面板记忆列表的元信息从"命名空间 · 类型 · 时:分"换成
   `命名空间 · 类型 · 出处`，而**出处字符串由 core 渲染**（`describeMemory`），
   面板不重复实现措辞。

来源词表按写入路径给出：面板对话里提到的 / Agent 记下的 / 手动写入的 / 来源不明；
被更正的条目会附加"已被更正"。同时断言**被更正的条目永远不会进提示词**——
这是前一项 supersede 与这一项的组合约束。

`tests/memory-provenance.test.mjs`（6 条）：相对时间分档（刚刚/分钟/小时/天/月/时间不明）、
五种来源各自措辞、更正标记、**提示词里每条事实都带括注**、被更正的事实不进提示词、
API 返回的条目带 `provenance`。

改这步时又踩到一次"真实时钟 vs 固定时钟"：`buildSystemPrompt` 原本用 `Date.now()`，
测试用固定时间戳就变成了"24 个月前"。给它加了可注入的 `now`——
提示词组装因此变成确定性可测的。

### 回补 8：动作音效（此前唯一"素材在包里、功能没接"的缺口）

模型归档里的 15 个音效 mp3 一直在解包、也一直能被 `/amadeus/assets/current/sounds/*` 取到，
但从不播放。现在接上了，做法上有一条硬约束：

**音效必须走独立的 `<audio>`**——口型分析器（`createMediaElementSource`）挂在语音元素上，
共用元素会让她的嘴跟着敲门声动。设计上音效是 **fire-and-forget**：
不进语音队列、不阻塞、不打断、不参与口型；只有一条 400ms 冷却防止连点叠成噪音。

映射放在注册表（`motionSounds`），因为它是模型专属数据而不是代码：
动作组 `tap_body` → 文件 `tapBody_00.mp3`。音效跟随语音开关，音量走新的 `voice.sfxVolume`。

`tests/sfx.test.mjs`（8 条）：播放并应用音量、连点合并成一次、冷却后恢复、
关语音即静音、播放失败不外泄异常、`reset` 清冷却、动作组到文件名的解析、
音量支持 getter（设置改动即时生效）。
浏览器侧另加一条真实断言：**点击立绘会触发音效**（实测 `tapBody_00.mp3`）。

### 有意没做的部分

《剧情模式》的核心是**多角色**（导演 + 意愿度 + 优先级链 + 多立绘 + 场景状态机）。
本项目是**单角色**，与人数强相关的机制（在场名单、轮转、立绘站位、切场状态机）
没有落点，硬做只会多出空转的抽象。其中适用于单角色的两条其实早已满足：
"导演输出必须有兜底"（调度器的兜底台词）、"一段最多几句"（`parseReply` 限 3 句）。

若将来要做多角色，那份文档里最值得抄的是**意愿度增量 + 优先级链**，
尤其是"递话必须排队""召集/道别要让未表态者先说"这两条具体坑。

## 独立 LLM key 录入 UI + 模块啮合复验（2026-10-15）

补的是最后一条"后端就绪、面板够不着"的缝，外加一次跨模块啮合复验。

**密钥录入：写路径打通**

- `GET /amadeus/status` 增加 `secrets`，只有 `{configured, source, envVar}`，值永远不出 daemon
- 新增 `POST /amadeus/secrets {name, value}`：只认白名单名字（未知名字 400、缺名字 400、未鉴权 401），
  响应回的是 `describe()` 而不是值；写操作进审计日志
- 设置页新增 `API Key` 行：`type=password`、**永不回填**、留空即不修改；保存成功后只刷新状态文案
- 平台差异仍由 `SecretStore` 兜底：Windows 走 DPAPI 落盘，其它平台拒绝明文持久化并提示改用环境变量
- `tests/secrets.test.mjs`（5 条）：环境变量优先、`describe()` 不泄露值、未知名字拒绝、未配置如实上报

**这一轮抓到的三个真问题**

1. `main.js` 里来电浮层的兜底文案还是日文 `着信中…`（`item.cn`/`item.text` 都缺时才会露出）。
   上次的"冻结文案"守卫只扫 `index.html` 与 `views.js` 的 `row()` 标签，够不着这个运行期兜底。
   已改为 `来电中…`，并把守卫扩到**整个 `src/panel`（排除 vendor）**：禁日文假名，禁 `応答/拒否/着信中`。
   同时把 `Live2D 素材` 行也改走 `row()`，让"标签清单"真正成为全集。
2. 截图目视发现密钥行**排版是坏的**：输入框写死 150px 导致占位符被切，`保存` 被挤成竖排两行。
   改为 flex 分配（输入框可缩、按钮 `nowrap` 且不缩），占位符收短成 `sk-…`。
   并固化成断言：控件不裁切不折行，且**任何设置行的控件都不得压到标签列**。
3. 连跑 15 遍全量测试抓到 1 次偶发失败：`memory-recall.test.mjs` 用**文件 mtime** 当"有没有写过盘"的探针。
   本机实测：`写临时文件 → rename 覆盖同名文件` 这个原子写套路，**155/200 次 mtime 完全不变**——
   NTFS 的文件时间戳隧道（file system tunneling）会把同名重建文件的旧时间戳还原回来。
   也就是说这条断言一边会随机红，一边在"其实没写"时也可能**空过**。
   已改成断言落盘字段本身（`lastAccess` 读回磁盘 JSON），并补上"窗口内第二次查询被节流吸收"这一条。
   连跑 20 次稳定通过。

**五个问题的答案**

1. 出错时页面对不对：保存失败走 `report('error')`，`finally` 恢复按钮；输入框只在成功后清空。
   提示文案由 `getSecrets()` 单一来源驱动，读不到就是"未设置"。
2. 两件事同时发生：`onSecretsChanged()` 只触发一次 `refreshStatus()`，连续保存就是重取同一份描述，
   不做增量状态；保存期间按钮自锁，双击不会并发出两次写。
3. 环境变了还 work：非 Windows 平台写入回 409 + `degrade`，面板只提示失败不崩；
   环境变量存在时 `describe()` 报 `source: env`，文案自动切到"环境变量"分支。
4. 一直改还能维护吗：标签、文案、写入路径各收敛一处（`row()` / 白名单 / 单一 `describe()`），
   测试冻结的是"用户能看见的字"，不是实现细节。
5. 错误边界：路由层 400/401/409 全覆盖且不回显密钥；面板侧 `try/catch/finally`；
   文案守卫扫整个目录而不是单文件。

## 语音输入后端通道（2026-10-15）

补完密钥录入 UI 之后，接着补的是**从来就没有后端**的那一项：语音输入。此前只有浏览器
Web Speech，机器上浏览器不带识别服务时，麦克风按钮就是死的。

**实现**

- `src/core/stt.mjs`：`browser | api | none` 三通道，沿用配置里早就写好、但一直没人实现的枚举
- `api` 走 OpenAI 兼容的 `POST /audio/transcriptions`：密钥用 `AMADEUS_STT_API_KEY`，或在面板里填；
  把 `AMADEUS_OPENAI_BASE_URL` 指向本机 whisper 服务时**密钥可为空**，音频不出机器
  —— 这就是"本地 whisper"的落点，而不是再引入一个只会报错的二进制依赖
- 新增 `POST /amadeus/stt`：音频只在内存里过一遍，不落盘；限 8 MB、mime 白名单；日志只记字节数
- 面板：`api` 用 MediaRecorder 录音上传，`browser` 保持原路径；`use-browser` / `missing-key`
  自动退回浏览器识别并在对话里说明原因，`mic-disabled` 明确提示；所有路径都收敛到 `resetMic()`，
  不留计时器、不占着麦克风
- 自检新增 `语音输入` 一行；`/amadeus/status` 增加 `speechInput`（ready / degrade），面板据此选路

**这轮抓到的真问题**

1. 超限上传要回 413，客户端却收到 `ECONNRESET`：原来的 `readBody` 超限时直接 `req.destroy()`，
   于是**响应永远发不出去**。改成把剩余字节继续读掉（丢弃）再回 413；JSON 通道同样受益
   （原本超限是 500）。这是"错误分支没人跑过"的典型：正常路径全绿，只有真去传大文件才看得见。
2. 日志里出现 `[stt] [stt]` 双前缀（`createChildLogger` 已经加过 scope），顺手清掉。

**五个问题的答案**

1. 出错时页面对不对：所有异常路径都收敛到 `resetMic()`，按钮不会卡在"录音中"；没听清会提示而不是静默。
2. 两件事同时发生：`micOn` / `micStarting` 双闸，连点不会开出第二条录音；录音 60 秒自动收尾；
   手动停止先停 recorder 再停识别。
3. 环境变了还 work：没有 `MediaRecorder`/`getUserMedia`、没有 `SpeechRecognition`、
   daemon 返回 4xx，都会退回或明确说明，功能不会凭空消失。
4. 一直改还能维护吗：三通道枚举只有一个定义点（配置 schema），"谁该退到哪"只在 `stt.describe()`
   与面板一处 catch 里，测试盯的是行为而不是实现。
5. 错误边界：401/403→`api-key-rejected`，5xx→`stt-upstream`，连不上→`stt-unreachable`，
   超时→`stt-timeout`，超限→413；密钥与音频都不进日志、不进响应。

## 系统播报：面板没开也能听见（2026-10-15）

方案 Q25 的可选项落地：任务完成/失败时，如果**没有面板在看**，就用系统语音把短句念出来。
默认关闭（`broadcast.systemTts`）——“电脑突然开口”必须是用户主动选的。

**实现**

- `src/core/system-tts.mjs`：Windows 走 PowerShell + `System.Speech`，macOS 走 `say`，
  Linux 依次探测 `spd-say` / `espeak-ng` / `espeak`；一个都没有就返回 `no-system-voice`，不抛错
- 一句话 = 一条队列项：**同时只跑一个进程**，后来的排队（上限 2），满了丢最新、
  绝不打断正在说的那句；30 秒超时兜底杀进程；daemon 退出时 `shutdown()` 收掉当前进程
- 文本不进命令行：Windows 通过 `AMADEUS_SPEAK_TEXT` 环境变量传递；日志只记字符数，不记内容
- 广播顺序：**面板队列永远先入**，再尝试系统语音；真的念出来了就把队列里那条 ack 掉，
  免得打开面板时把同一句再说一遍；面板有连接时系统语音不介入（`panel-open`），避免双声道
- 自检新增 `系统播报` 一行（后端 id，或“不可用（面板播报仍然可用）”）

**这轮抓到的真问题**

1. `verify:ui` 默认语音队列是空的：手工测 notify 时在 hub 里留了一条待播广播，面板一打开就去取 TTS，
   而当天 Edge TTS 上游正好在返 500 —— 于是**上游故障被当成面板回归**报了出来。已在 harness 开头先
   `action clear`；同时确认了面板侧的真实行为：取音频失败会重试到上限 3 次再带原因丢弃
   （`events.dropped` 可查），聊天文本完全不受影响。
2. 同一句的“双通道”竞态：系统语音念完到 ack 掉队列条目之间有几毫秒窗口，若面板恰在此刻连上，
   两边都会念。代价是一句内容相同的话，选择不加锁，仅记录在此。

**五个问题的答案**

1. 出错时页面对不对：页面不参与系统播报；系统语音失败只写审计与 `describe().lastDegrade`，
   不影响对话，也不影响面板播出。
2. 两件事同时发生：同时只有 1 个进程；队列满丢最新、不丢正在说的；系统播报与面板播报互斥（有面板就不走系统）。
3. 环境变了还 work：三个平台各有后端，都没有就明确降级；开关关闭时该分支完全不执行；
   自检会提示“开了但没有后端”。
4. 一直改还能维护吗：后端探测结果缓存一次，平台分支集中在 `backendFor()`；
   测试用注入的 spawn 覆盖队列/超时/关闭，跑测试时不会真的出声。
5. 错误边界：spawn 异常、非零退出、超时、队列满、空文本各有明确 reason；daemon 退出会杀掉当前进程，不留孤儿。

## 修复语音链路 403（Edge TTS 的 v2 令牌）（2026-10-15）

给系统播报做验证时撞出来的：`/amadeus/tts` **全部**返回 500，`error: edge tts socket error:
websocket upgrade rejected: HTTP/1.1 403 Forbidden`。原因不是网络，是端点换了握手令牌：
`Sec-MS-GEC` 从"单次 SHA-256"升级成 v2（`<CS64 16 hex>-<SHA256 64 hex>`），
URL 上的 `Sec-MS-GEC-Version` 前缀必须是 `2-`。旧的 `1-` 一律 403。

**做法**

- 新增 `src/core/edge-tts-drm.mjs`：把 edge-tts（MIT，rany2）的 v2 算法移植成 JS。
  32 位乘法走 `Math.imul`；两处 64 位 rotate（`e * 2**32 + e` 再移位）用 BigInt，
  因为 double 存不下那些乘积。SHA-256 也不是标准实现：初始状态与轮常量都被改过，
  所以 `createHash('sha256')` 复现不了。
- `edge-tts.mjs` 改用 `secMsGecV2()` + `Sec-MS-GEC-Version=2-<chromium>`，并补上 `Sec-CH-UA*` 三个请求头。
- `TrustedClientToken` 与算法常量收敛在 drm 模块一处，避免两处常量各自漂移。

**移植中的一个真坑**

JS 的 `& 0xffffffff` 给出的是**带符号** 32 位值，`BigInt(负数)` 会乘出完全不同的数。
第一版就是这样：4 条 golden 向量全错。修法是先 `>>> 0` 再进 BigInt。
这类错误不抛异常，只会安静地算出错的哈希——所以这轮特意先用参考实现生成向量再动手。

**五个问题的答案**

1. 出错时页面对不对：令牌是纯函数，失败只影响当次请求；面板侧行为不变（重试到 3 次后带原因丢弃，
   聊天文本完全不受影响）。
2. 两件事同时发生：按 5 分钟分桶的纯计算，无共享可变状态，并发请求各算各的。
3. 环境变了还 work：**已知限制**——系统时钟偏差会直接导致 403（上游用响应 `Date` 做时钟校正，
   我们暂时没有实现），已记在"未完成"；其余部分与平台无关。
4. 一直改还能维护吗：算法、常量、令牌前缀集中在一处，golden 向量测试就是"上游又变了"的告警器。
5. 错误边界：salt 短于 7 字节直接抛；令牌形状自测；握手被拒时错误信息里带服务端状态码。

## Edge TTS 时钟校正：403 的自愈路径（2026-10-15）

上一节把 403 修好了，但它留下的"已知限制"其实是可修的：令牌由本机时钟推导，机器时间偏几分钟就会
一直被拒，而错误信息里完全看不出来。上游的做法是——**用响应里的 `Date` 修正偏移**。

**做法**

- `ws-client.mjs`：握手被拒时把状态码与响应头挂到 error 上（之前只留了状态行文本，`Date` 直接丢掉）
- `edge-tts-drm.mjs`：新增 `parseHttpDate` / `skewSecondsFromDate` / `adjustClockSkew` / `skewedNowMs`，
  令牌默认使用"修正后的现在"；偏差超过 7 天直接拒绝（坏代理不该能把我们的时钟推走几年）
- `edge-tts.mjs`：403 且带可解析 `Date` → 修正偏移并**重试一次**；只有 403 会走这条路
  （401、1007、超时都不重试）
- 偏差只在进程内保留：重启后遇到 403 会重新学一遍，避免把一个可能已经过时的偏移写进磁盘

**验证**

- 真握手探针：用"慢了 10 分钟的时钟"造令牌 → 403，响应确实带 `Date`；换成修正后的令牌重放 → **101**
- `tests/edge-tts-clock-skew.test.mjs`（7 条）：日期解析、异常值拒绝、钳制、一次性重试、
  非 403 不重试、偏差跨调用保留；全部用注入的假 WebSocket，不发真实请求
- 结构改造后重跑真实合成：17136 bytes / 3 段词级时间戳，`probe()` 仍返回 ok

**五个问题的答案**

1. 出错时页面对不对：修正不了就照旧报错；只对 403 且只重试一次，不会把一次失败放大成请求风暴。
2. 两件事同时发生：并发合成读同一个偏移值、写入是单次赋值，两个请求同时发现偏差也得到同一结果。
3. 环境变了还 work：这一节就是环境适配本身；只用绝对时间戳，跨时区/夏令时无关。
4. 一直改还能维护吗：时钟逻辑集中在 drm 模块的四个小函数里，重试策略只在 `finish` 一处。
5. 错误边界：无法解析的 `Date`、超范围偏差都不移动时钟；重试有上限，不会打转。

## Codex 插件市场条目（2026-10-15）

backlog 的最后一项。此前只有 zip + `install.ps1`；现在也可以让 Codex 自己管理这个插件。

**做法**

- `.agents/plugins/marketplace.json`：市场清单（`name` / `interface.displayName` / `plugins[]`），
  条目指向仓库根 `./`，策略 `installation: AVAILABLE` + `authentication: ON_USE`
- `codex plugin marketplace add .` 直接可用；但插件路径就是仓库根，Codex 会连
  `node_modules/`、`work/`、`dist/` 一起复制进插件缓存 —— 所以 `make-dist` 现在**同时产出一个
  只含发行文件的 `dist/marketplace/`**（约 1 MB），把它作为市场根才是给别人用的路径
- `install.ps1 -Marketplace`：按 CLI 自己写出的 TOML 形状追加 `[marketplaces.amadeus]` +
  `[plugins."amadeus@amadeus"]`（幂等、先备份、原子写入；`source` 用单引号字面量，
  反斜杠无需转义）；`-Uninstall` 一并移除三段（mcp / marketplace / plugin）
- `verify-install.ps1` 新增市场场景，并在本机存在 codex CLI 时**真跑一次**
  `codex plugin list --available --json`；CI 没有 CLI 就打印 SKIP

**两个只有真跑才知道的细节**

1. `authentication` 只接受 `ON_INSTALL` / `ON_USE`。第一版写 `NONE`，CLI 直接回
   `unknown variant 'NONE', expected 'ON_INSTALL' or 'ON_USE'` —— 枚举不能靠猜。
2. 校验脚本一开始把 CLI 检查放在**故意写坏的** `config.toml`（未转义的 Windows 路径 + 非 ASCII）
   上，CLI 解析失败 → 退出码 1。产品没问题，是检查放错了位置：现在 CLI 检查跑在干净的隔离
   CODEX_HOME 里，坏配置那条场景继续单独验证"文本级幂等 + 不动原配置"。

**验证**

- 真 CLI：`codex plugin marketplace add dist/marketplace` → `Added marketplace amadeus`；
  `codex plugin list --available --json` → `pluginId: "amadeus@amadeus"`；
  `codex plugin add amadeus@amadeus` → 安装到
  `<codex home>/plugins/cache/amadeus/amadeus/0.1.0`
- `scripts/verify-install.ps1`：18/18（含 `codex sees amadeus@amadeus`）
- `tests/marketplace.test.mjs`（6 条）：清单形状、条目与 `plugin.json` 的名字/版本/分类一致、
  策略枚举冻结、安装 UI 需要的字段齐全、skills 目录存在、**不伪造 homepage/repository**

**五个问题的答案**

1. 出错时页面对不对：条目指向的路径不存在时 CLI 会拒绝加载；测试提前断言路径存在且名字一致。
2. 两件事同时发生：注册是"检查 → 追加 → 原子替换"，重复执行只保留一份；CLI 自己装的缓存目录
   与安装脚本互不干扰。
3. 环境变了还 work：`source` 用单引号字面量，含空格/反斜杠的路径不会被 TOML 转义破坏；
   路径含单引号时跳过并提示，而不是写坏配置。
4. 一直改还能维护吗：市场条目、`plugin.json`、`package.json` 三者的名字/版本/分类由测试绑在一起，
   策略枚举来自 CLI 的实际报错。
5. 错误边界：CLI 不存在 → 打印 SKIP 而不是失败；检查用的 CODEX_HOME 是隔离目录，
   不会碰用户真实的配置与插件缓存。

## 真机第一次跑：EFS 目录里的 EXDEV（2026-10-15）

"执行项目"这一步不是走个流程：在**真实**数据目录里第一次打开面板，面板立刻报
`POST /amadeus/sessions` 500 —— `EXDEV: cross-device link not permitted`。

**根因（一步步验出来，不是猜）**

- 测试机的 `%LOCALAPPDATA%` 整棵树是 **EFS 加密**的：`cipher /c` 显示
  "New files added to this directory will be encrypted"，条目为 `E sessions`。
- 在这种目录里，**同一目录内的 rename 也会失败**。实测：`rename` 到不存在的目标、
  `rename` 覆盖已存在目标、`rm + rename`、`linkSync` 全部 `EXDEV`；而 `writeFileSync`
  与 `copyFileSync` 正常。
- 我们的 `writeJsonAtomic` 用的正是"临时文件 + rename"，于是**会话 / 记忆 / 配置全部写不进去**：
  面板建不了会话，设置也存不下。测试全绿，是因为测试的临时目录在 `%TEMP%` 下。

**修法（`src/core/store.mjs`）**

- rename 抛 `EXDEV` → 记住这个**目录**，对它改用"写临时文件 → `copyFile` 覆盖 → 删临时文件"；
  其它错误（例如 `EPERM`）照旧抛出，不掩盖真实故障。
- 复制写不是原子的，所以读侧补上自愈：解析失败时把文件留成 `<file>.corrupt-<时间戳>`
  再当空处理，而不是让整个路由 500。
- 每个目录只 warning 一次，日志里能看出"这个目录不允许 rename"。

**验证**

- 真实路径 `%LOCALAPPDATA%\Amadeus\sessions`：写→读回一致；清掉了修复前失败留下的 14 个临时文件
- 真 daemon：`POST /amadeus/sessions` → 200（返回 id）、`GET` 能看到、`PATCH /amadeus/config` → 200
- 真面板：`verify:ui` **23/23**（含 "no unexpected console errors"），Live2D 用真实素材渲染
- `tests/store.test.mjs`（4 条）：注入 EXDEV → 回退且只探测一次；EPERM 仍然抛出；
  临时文件不残留；损坏文件被隔离
- 顺带把 `ensureDaemon` 的等待从 15s 提到 30s：刚复制完的发行包第一次启动时，
  Defender 扫描会让 daemon 起来得慢，15s 会误报 "did not become ready in time"，
  而实际上服务已经正常（与 MCP 注册里的 `startup_timeout_sec = 30` 对齐）

**五个问题的答案**

1. 出错时页面对不对：写失败不再让路由 500；损坏文件被隔离并当空处理，页面继续可用。
2. 两件事同时发生：并发写仍各写各的临时文件；只有"目录是否支持 rename"这一项是共享状态，
   写入顺序不变。
3. 环境变了还 work：这正是环境适配——EFS 加密目录、普通目录都能写，其它错误类型不被吞掉。
4. 一直改还能维护吗：能力探测与回退收在 `writeJsonAtomic` 一处，`renameSync` 可注入，
   所以回归测试不需要真的造一个 EFS 卷。
5. 错误边界：`EXDEV`→回退、`EPERM`→抛出、损坏 JSON→隔离、空文件→返回 fallback。

## 面板窗口化 / 音色只留默认与导入 / 默认无记忆（2026-10-15）

三条来自使用者的明确要求，一次做完。

**1. 面板不在浏览器里打开，而是随 Codex 一起出现**

- `bin/amadeus-panel.mjs`：确保 daemon 在跑，然后用 Edge/Chrome 的 `--app=` 打开一个
  **无标签页、无地址栏**的 430x940 应用窗口（找不到浏览器才退回默认浏览器；`--browser` 强制用标签页）。
  已经有一个面板连着时不再开第二个窗口（`--force` 可以强行再开一个）。
- **不再依赖 Codex hooks**（见下一节：这台机器的 `/hooks` 页面是空的）。改为安装时在
  「启动」文件夹放一个快捷方式，由 `bin/amadeus-watch.mjs` 探测 Codex 进程后弹一次面板窗口。
- `Amadeus.exe`：`scripts/launcher.cs` + `scripts/build-launcher.ps1` 用 Windows 自带的
  .NET Framework 编译器在安装时现编译（4.6 KB，WinExe 无控制台窗口）；没有编译器就留一个
  `Amadeus.cmd`。双击即"启动 daemon + 弹出面板"，也就是连携启动的 exe。
- `amadeus open` 与 `amadeus start --open` 都改走这条路径。

**2. 音色只分「默认 / 导入」**

- 删掉原来那份固定名单（含男声），`voice` 现在是：内置默认 + 用户导入。
- `src/core/voices.mjs`：导入两类语音 —— `edge`（在线语音 ID，校验形状）与
  `system`（Windows 已安装语音，SAPI）。
- `SystemTts` 增加 `listVoices()` 与 `synthesize()`：后者用
  `SetOutputToWaveFile` 渲染成 WAV，于是**导入的本机音色可以离线说话**，与在线通道共用同一套
  磁盘缓存（缓存扩展名跟随容器，WAV 不再被写成 .mp3）。
- 面板设置页：`音色` 下拉只有「默认 / 已导入 / ＋ 导入…」；选「＋ 导入…」才展开导入表单
  （名称、语音 ID、「本机语音」下拉），另有「移除当前」。
- **顺带修一个真 bug**：`select()` 只按列表项设置值，配置里出现列表外的值（例如手工改成
  `emotionIntensity: 1.1`）时控件会显示为空白 —— 现在会把该值补成一项显示出来，
  UI 校验也加了"可见控件不许为空"这条断言。

**3. 默认无记忆，且一句之后断开**

- 默认值改为 `memory.enabled=false`、`memory.autoExtract=false`、`chat.oneshot=true`
  （记忆与连续对话仍在，设置页可开）。
- `chat.oneshot`：一轮回答结束后把会话标记为 `endedAt`，面板显示「已断开（单句模式）」；
  下一条消息由 daemon 开一个**全新会话**，且这一轮不会带任何历史（`history: []`）。
- 面板启动时只恢复"未结束"的会话，所以刷新后不会把上一句当作上下文。
- 一轮中若记忆开关是关的，召回与近期事实都不进提示词（`ChatEngine` 里单点判断）。

**五个问题的答案**

1. 出错时页面对不对：没有浏览器 → 退回标签页；没有编译器 → 退回 `.cmd`；导入失败 → 明确报错且
   不写入；列表外的配置值不再显示成空白。
2. 两件事同时发生：面板已连接时不再开窗（避免两个窗口抢音频）；hook 是 `async` 且只做"确保在跑 +
   开窗"，与 Codex 启动并行，不会阻塞会话。
3. 环境变了还 work：浏览器路径按 Edge/Chrome 常见位置探测；系统语音不可用时导入项仍可保留
   （只是发不出声）；单句模式与记忆开关都是可回退的配置。
4. 一直改还能维护吗：窗口化逻辑只有 `amadeus-panel.mjs` 一处，CLI/快捷方式/hook 都调它；
   音色库是独立 JSON，不动 config schema；`select()` 的补值规则对所有下拉生效。
5. 错误边界：hook 失败静默（不让 Codex 显示插件出错）、导入校验 ID 形状与 provider、
   删除音色时自动把选择重置回默认。

**验证**

- 真机：`node bin\amadeus-panel.mjs --force` → 应用窗口打开并连上（`events.clients = 1`）
- 真机音色：导入 `Microsoft Huihui Desktop`（system）→ 选中 → `/amadeus/tts` **200 `audio/wav` 129640B / 470ms**（离线）
  → 移除后选择自动回到 `ja-JP-NanamiNeural`
- 真机默认值：`oneshot=true`、`memory.enabled=false`、`memory.autoExtract=false` 已应用到现有配置
- `verify:ui` **25/25**（新增「音色菜单只有默认与导入」「可见控件不为空」）；`npm test` **208/208**
- `scripts/build-launcher.ps1` → `Amadeus.exe` 4608 bytes

## 去掉 Codex hooks：改用进程 watcher（2026-10-15）

使用者给出的 `/hooks` 截图是空的（"No hooks found / Configured hooks will appear here"）——
也就是说这台 Codex **不通过插件清单暴露生命周期 hook**，之前的 `SessionStart` 方案在这台机器上
永远不会触发。于是把连携启动换成不依赖 hooks 的做法。

**做法**

- `src/host/codex-watch.mjs`：纯逻辑——`imageRunning()`（Windows 用 `tasklist /FI`，其它平台
  `pgrep`）与 `watchDecision()` 状态机。规则：Codex 不在 → `reset`；面板已连 → `seen`；
  Codex 在且本轮还没弹过 → `launch`；已弹过 → `idle`（**你关掉窗口后不会被反复弹回来**）。
- `bin/amadeus-watch.mjs`：3 秒一轮的守候进程，只在 `launch` 时调 `openPanel()`；
  日志写到 `%LOCALAPPDATA%\Amadeus\watch.log`（超过 64 KB 自动截断）。
- `src/host/panel-launcher.mjs`：把"找浏览器 / 判断面板是否已开 / 开 app 窗口"抽出来，
  给 `amadeus open`、`Amadeus.exe`、watcher 三处共用（以前只有 `amadeus-panel.mjs` 一份）。
- `install.ps1`：写一个 `Amadeus-watch.vbs`（用 `wscript` 隐藏启动 node），并在
  `%APPDATA%\...\Startup\Amadeus Panel.lnk` 放快捷方式；`-NoAutoStart` 可跳过；
  `-Uninstall` 会删掉这两个东西。
- 插件里删掉 `hooks/hooks.json`、`plugin.json` 的 `hooks` 字段，以及分发清单里的相关条目；
  `tests/marketplace.test.mjs` 增加一条断言防止它被悄悄加回来。

**验证**

- 真机：`wscript Amadeus-watch.vbs` → 进程起来，日志 `Codex detected -> panel window`，面板窗口打开
- 真机：停掉 daemon 后 watcher 自己把 daemon + 面板拉回来（日志可见）
- `scripts/verify-install.ps1`：把 `APPDATA` 重定向到沙箱后断言"快捷方式创建 / `Amadeus-watch.vbs`
  存在 / launcher 编译成功 / 卸载后快捷方式消失"，共 **21 项**全过
- `tests/watch.test.mjs`（5 条）：镜像名清单、探测容错、短路顺序、四种决策、完整时序
- `npm test` 214/214；`npm run check` 81 文件语法通过

## 面板窗口收成"就是那台翻盖手机"（2026-10-15）

反馈：面板弹出来**黑框太大、太占屏幕**，希望只看到翻盖手机本体，小窗口弹出。

**做法**

- 面板新增 **app 模式**：URL 带 `#app` 时 `html[data-mode=app]` 生效 —— body 去掉 18px 内边距和
  径向渐变背景（换成手机外壳色），`#phone` **封顶 284x504**、居中，窗口再大也不拉伸；
  `#screen` 收到 `clamp(130px, 26vh, 190px)`。四周不再有"黑框"。
- 启动器用 **fragment** 传尺寸（`#app-300x520`）：token 交换会 302 到干净 URL，
  只有 fragment 能活下来；**Chromium 在浏览器已运行时常常忽略 `--window-size`**，
  所以页面自己还会 `resizeTo()` 一次（实测有效）。
- 窗口默认 **300x520**（430x940 → 360x700 → 300x520），并有一条"不超过屏幕可用高度 72%"的兜底；
  可用 `AMADEUS_PANEL_SIZE=W,H` 覆盖；
  `amadeus open --browser` 的标签页布局保持原样。

**验证**

- 真机窗口尺寸（Win32 实测，屏幕缩放 160%）：**逻辑 301x522 / 物理 482x835**
- 真机 `#app`：300x520 窗口里 phone = **284x504 @ (8,8)**，`screen=135px`，输入行 bottom=492 未溢出
- `verify:ui` 两条断言（app 模式生效 / 窗口放到 900x700 时手机仍是 284x504 且居中）→ **27/27**

**五个问题的答案**

1. 出错时页面对不对：不带 `#app` 时布局完全照旧；窗口被拉大也只是手机跟着变大，不会错位或露底。
2. 两件事同时发生：窗口模式只改 CSS 与窗口尺寸，与 SSE、音频归属无关。
3. 环境变了还 work：fragment 在 302 之后仍在；没有 app 能力的浏览器退回标签页，用旧布局。
4. 一直改还能维护吗：整块规则只有 `html[data-mode='app']` 三条，尺寸是常量 + 一个环境变量。
5. 错误边界：`AMADEUS_PANEL_SIZE` 非法时 Chromium 直接忽略，退回默认尺寸。

### 补充：小窗口里人物没居中（同日修）

反馈：小手机格式下立绘偏左。用渲染器自己报的数一测就清楚了：

- 256/260 宽的 canvas 里，人物实际画在 x = -12..112，中心 50，而画布中心是 130 —— 偏左 80px。
- 根因有两条叠加：`model.getBounds()` 把**隐藏部件**也算进去，所以量出来的"中心"本来就偏右；
  当年为了让大面板看起来居中，注册表里写死了一个 **绝对像素** `layout.x = -80`。
  绝对像素的补偿只在 392px 宽的画布上成立，画布一缩到 260px 就正好把人物推走 80px。

修法：

- `visibleBounds()`：只遍历 `visible/renderable` 的叶子节点求并集，量的是**真正画出来**的东西。
- 手动微调改成相对量：`nudge = x * (canvasWidth / 392)`，即"当年 392px 宽的画布"上标定的值。
- 注册表 `layout.x` 由 `-80` 改为 `0`（不再需要猜）。
- 渲染器新增 `debugInfo()`（画布/缩放/位置/包围盒/上次布局），面板挂成 `window.__amadeusAvatar()`，
  让 UI 校验能量化断言"人物居中"——WebGL 画布没法可靠回读像素。

验证：260x133 与 260x188 两种画布下，内容中心 = 画布中心（横向偏差 **0**，纵向正好落在 `0.52h`）；
`verify:ui` 新增一条断言（`content=130 canvas=130`）→ **28/28**。

## 对话报错 / 任务完成无应答 / 默认音色对齐 Amadeus2026（2026-10-15）

三条反馈，一路挖出四个真问题。

**1. 双击 Amadeus.exe 后聊天报 `codex CLI not found on PATH`**

- 原因：daemon 由 watcher / `Amadeus.exe` 启动，这类会话的 PATH 不一定包含 Codex 自己那套
  CLI（`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`）。
- 修法：`resolveCodex()` 顺序改为 `AMADEUS_CODEX_BIN` → 已知安装位置（应用管理的 versioned
  bin、Program Files、npm shim）→ `where`；npm 的 `.cmd` shim 通过 `cmd /c` 启动
  （提示词走 stdin、argv 固定，没有注入面）。
- 验证：把 PATH 剥成 `C:\Windows\system32;C:\Windows` 仍能解析到应用管理的 `codex.exe`；
  真实一轮对话 4 秒完成并回复「哟，好久不见。你还好吗？」。

**2. Codex 任务完成后没有应答**

- 原因两层：安装脚本**只打印**了 notify 建议、从未写进 config.toml；而且面板窗口在用户点击前
  被 Chromium 拦下 `play()`（`user didn't interact with the document first`），语音被 ack 成
  failed 后丢弃。
- 修法：
  - 安装脚本真的写 `notify`。本机原本已有 `codex-computer-use.exe`，所以先把旧命令存进
    `%LOCALAPPDATA%\Amadeus\notify-chain.json`，再把 notify 指向 `amadeus-notify.mjs`；
    该脚本先转发旧命令、再通知 daemon。卸载按记录还原（不覆盖用户设置）。
  - `broadcast.enabled` 默认改为 true（面板可关）。
  - 启动器给面板窗口加 `--autoplay-policy=no-user-gesture-required`，并在开窗前清掉占用同一
    profile 的残留浏览器进程（Chromium 这个开关是**进程级**的，旧进程活着就会沿用旧策略）。
  - 面板侧再加一层：被拦下的句子**不再丢弃**，改为挂起、第一次点击/按键后按顺序补播，
    状态栏提示「点一下面板，她就能开口了」。
- 验证：真实 `notify(task-complete)` → `broadcasted: true`、待播归零、**没有任何 playback failed
  或 held 上报**（即直接出声）。

**3. 默认音色对齐旧版 Amadeus2026**

- 旧版应用是 Next.js + 阿里云百炼（DashScope）：默认引擎 `qwen3-tts-vc`，曾用内置样本
  复刻音色；其密钥存放方式不适合直接沿用，新项目不复制旧应用的密钥。
- 测试账号：`qwen3-tts-vc(-2026-01-22)` 返回 `Model not exist`、`cosyvoice-v3.5-flash`
  返回 418 → **复刻音色那条链路在该账号上没开通**；但 `qwen3-tts-flash` + 女声（Cherry/Seren）
  可以正常合成。
- 因此当时默认音色改用**同一家服务**：`voice.provider = dashscope`、`voice.name = Cherry`、
  `voice.dashscopeModel = qwen3-tts-flash`；语音密钥由使用者自行配置，Windows 上可选
  **DPAPI 加密**存储（面板新增「语音密钥」行，可改可清）。后续版本的克隆音色行为见 README。
  以后开通复刻服务，把复刻得到的音色 ID 粘进「导入音色」即可换回那个音色。
- 验证：`/amadeus/tts` → 200 `audio/mpeg` 96044 bytes / 847ms，缓存元数据 `provider=dashscope`
  （确认没有静默回退到 Edge）。

**4. 顺带修掉的两个「换个环境就哑」的真问题**

- **DPAPI 依赖 PowerShell 模块**：原实现用 `ConvertTo-SecureString`（属于
  `Microsoft.PowerShell.Security` 模块）。daemon 由 Startup watcher 启动、环境里没有
  `PSModulePath` 时模块无法自动加载，**已存的密钥会全部读成「未配置」**。改为 .NET
  `ProtectedData`（只需装载 System.Security 程序集），并保留旧格式的解密回退。
- **EFS 目录上的复制写**：`writeJsonAtomic` 的 EXDEV 回退里 `copyFileSync` 在这台机器的加密
  目录上也会失败（目标不存在 ENOENT / 已存在 UNKNOWN），保存密钥直接报错。现在回退链是
  复制 → 直写（读侧已有损坏文件隔离兜底）。
- 验证：在**没有 PSModulePath** 的环境里写入+读回一致；真实密钥保存返回
  `{configured: true, source: dpapi}`。

**五个问题的答案**

1. 出错时页面对不对：语音被浏览器拦下不再丢（挂起+点击补播）；阿里云失败自动回退 Edge；
   密钥读不到就回退默认链路。
2. 两件事同时发生：面板已连接时不再开第二个窗口；notify 的链式转发是 fire-and-forget，
   不阻塞 Codex；语音队列同一时刻只播一条。
3. 环境变了还 work：PATH 缺失、PSModulePath 缺失、EFS 加密目录、阿里云未开通——四种都实测过。
4. 一直改还能维护吗：codex 解析、密钥存储、语音路由、notify 合并各自只有一处实现，
   并有测试与 UI 校验兜着。
5. 错误边界：`.cmd` shim 走 `cmd /c`、未知音色 ID 拒绝导入、卸载还原原 notify、
   旧版密钥格式仍可读。

## 未完成 / 下一步

当前待做：daemon/面板大型模块的进一步拆分。首次使用引导与隔离的真实浏览器双窗口回归已在 2026-10-17 完成。

## 已修正的上游缺陷（对照评审报告）

| 缺陷 | 处理 |
| --- | --- |
| 密钥随配置下发 / 进 URL | 配置一律脱敏；面板 URL 只带一次性 token，换取 HttpOnly cookie |
| 路由鉴权不一致 | 所有路由走同一 `createAuth().check`，非回环 403 |
| `danger-full-access` 自我提权 | 已移除，只写自己的数据目录 |
| 记忆兜底落盘丢 `summary` | 已移除「反向 HTTP 拉取再落盘」的兜底路径 |
| TTS `_style` 全局竞态 | 移除 express-as，风格改为请求作用域，worker 不再共享可变全局 |
| `turn/end` 一律播报完成 | 播报默认关闭，且只接受任务/goal 完成信号 |
| 破坏性无 ack 队列 | SSE + ack + 超时重投 + 丢弃原因 |
| lookbehind 正则 | `splitSentences` 改为逐字符扫描，无 lookbehind |
| 内存驻留音频缓存 | 改为磁盘 LRU |
| 字符串改写式构建 | 已移除，全部是可直接运行的 ESM 模块 |

## 验证记录

```
npm test                                    215/215 通过
npm run check                                81 文件语法 + 分发清单 + 215 测试 通过
npm run verify:api                           45/45 通过（面板资源与路由）
npm run verify:ui                            28/28 通过（真实渲染 + 设置行对齐 + 音色菜单 + 控件非空 + app 窗口 + 立绘居中）
npm run verify:tabs                            7/7 通过（双标签语音归属，跳过 1 项可选）
scripts/verify-install.ps1                   27/27 通过（安装器全流程 + 市场注册 + 真 CLI 列举 + autostart 创建/清理，隔离 CODEX_HOME）
Codex 插件市场（真 CLI）                      add dist/marketplace → list 显示 amadeus@amadeus → add 安装到插件缓存
连携启动（真机，无 hooks）                    wscript Amadeus-watch.vbs → 日志 `Codex detected -> panel window`；停掉 daemon 后 watcher 自己拉回
音色 默认/导入（真机）                        导入 Microsoft Huihui Desktop（system）→ /amadeus/tts 200 audio/wav 129640B 470ms（离线）
连携启动器                                     scripts/build-launcher.ps1 → Amadeus.exe 4608 bytes
面板 app 窗口（真机）                          逻辑 301x522（物理 482x835 @160%），窗口内 phone 284x504 居中
立绘居中（真机 + 断言）                        260x133 / 260x188 画布，内容中心 = 画布中心，横向偏差 0
Codex CLI 解析（剥掉 PATH 实测）               仍解析到 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
真实一轮对话（面板环境）                       4 秒完成，回复「哟，好久不见。你还好吗？」；会话按单句模式结束
任务完成播报（真 notify）                      broadcasted:true、待播归零、无 playback failed（直接出声）
默认音色（阿里云，Amadeus2026 同源服务）        /amadeus/tts 200 audio/mpeg 96044B / 847ms，缓存 provider=dashscope
密钥存储（无 PSModulePath 环境）               写入+读回一致（ProtectedData），旧格式仍可解密回退
POST /amadeus/secrets 契约                    400 未知名字 / 400 缺参数 / 401 未鉴权 / 200 白名单，永不回显值
POST /amadeus/stt 契约                        browser→409 use-browser / 无密钥→409 missing-key / 坏 mime→400 / 超限→413 且 daemon 仍存活
STT 端到端（真 daemon + loopback 假 whisper）  200 转写，multipart 带上 model/language/音频，未鉴权 401
系统播报（本机静音实跑）                     System.Speech 装载成功，环境变量传文本，退出码 0
广播通道选择（真 daemon）                     无面板→`speaking` 并 ack 掉队列；有面板→`panel-open`；无后端→回退面板队列
Edge TTS 握手（探针）                         `2-` + v2 令牌 → 101 Switching Protocols；`1-` → 403
Edge TTS 端到端（真 daemon /amadeus/tts）     日文 11232B、中文 11232B、混排 15264B，均带词级时间戳
Edge TTS 时钟自愈（探针）                     慢 10 分钟的令牌 → 403（带 Date）→ 修正后重放 → 101
真机数据目录（EFS 加密）                      会话创建 200、配置写入 200、面板 23/23；修复前是 EXDEV + 500
MCP 冒烟（initialize/tools/list/tools/call）   通过，14 个工具，amadeus_status 实调返回
真实对话（codex exec，零额外 key）             通过，格式解析正确
主动来电 e2e（种状态→重启→判定→浮层）         通过，使用模型生成台词而非兜底
双标签会话同步（AMADEUS_TWO_TAB_CHAT=1）       A 4→6 / B 4→6，发起方无重复追加
发行包                                        110 文件 / 1128 KiB → ZIP 407 KiB（另出 dist/marketplace/ 约 1 MB）
```

## 说明

- 类型策略：使用 ESM JavaScript + JSDoc 注释，而不是 TypeScript 编译链。理由是主链路
  "零配置"优先，避免引入构建步骤；如果后续需要更强约束，可在不改运行时的前提下加
  `// @ts-check` 与 `tsc --noEmit`。
- 事件通道用 SSE 而不是 WebSocket（面板→daemon 仍走 REST）。SSE 是单向的，正好匹配
  "服务端推事件"的用法，且不需要额外依赖、自带断线重连。

## 2026-10-15 深夜：面板窗口与任务播报修复

背景：用户报「弹窗错误，为浏览器灰界面」，以及「codex 任务完成后无应答」。三个真实缺陷，都已修复并留下回归测试。

### 1. 面板窗口被创建成隐藏窗口（`src/host/panel-launcher.mjs`）

`spawn(..., { windowsHide: true })` 会让 Windows 递一个 SW_HIDE 给子进程，Chromium 把**第一个窗口**按隐藏创建：
进程列表里能看到一个 300x520 的窗口、daemon 也数到一个客户端，用户屏幕上却什么都没有（或被一个没有标题的空白窗口挡住）。
现在浏览器进程走 `BROWSER_SPAWN_OPTIONS`（`windowsHide: false`；msedge/chrome 是 GUI 子系统程序，不会闪控制台），
参数生成抽成纯函数 `appWindowArgs()`，单测断言 `--app=` / `--window-size=` / `--user-data-dir=` / autoplay 都在。

### 2. 两个调用者同时开窗会多出一个空窗口

面板只有「页面连上 daemon」才算 open，watcher 与 `Amadeus.exe` 在同一秒到达时都会通过 `panelIsOpen()`，
Chromium 于是给同一个进程再加一个窗口。现在用 `runtime/panel-launch.lock` 做 5 秒启动冷却：第二次调用返回
`launching` 不再开窗，冷却过期后依旧可以「关掉再打开」。
真机实测：watcher 与 `Amadeus.exe` 相隔 0.7 秒触发 → 仍然只有 1 个浏览器进程、1 个可见窗口。
另外，清理掉旧面板进程后会让新窗口等 600ms 再启动：对着一个还没退干净的进程开窗，Chromium 会额外给一个
没有导航过的小窗口（就是那扇「挡在手机后面的空白窗」）。

### 3. 任务完成播报被「上一次的 notifier」杀死（静音根因）

`bin/amadeus-notify.mjs` 会链式执行 Codex 原有的 notifier，而那条命令指向 Codex 自己的运行时
（`...\runtimes\cua_node\<hash>\...\codex-computer-use.exe`）。该目录已被 Codex 清理，`spawn` 对缺失文件抛的是
**异步 `event: 'error'`**，没人监听 → Node 直接退出。日志里只剩第一行 `kind=task-complete`，POST 永远发不出去。

现在：缺失文件先 `existsSync` 跳过并记 `chain-missing`，同时挂 `child.on('error', ...)`；另外把
`callDaemon()`（内部 `ensureDaemon` 会另起一个 daemon 并最多等 30 秒）换成 1.5 秒 `ping` + 3 秒超时 `fetch`，
再补一行 `kind:...:sent status=... broadcasted=...` 便于自证。

真 `codex exec` 实测链条：

```
kind=chain-missing command=...codex-computer-use.exe
kind=task-complete type=agent-turn-complete
kind=task-complete:sent status=200 broadcasted=true
→ 1 秒后 %USERPROFILE%\.cache\codex-runtimes\amadeus\voices\ef71c0ba….mp3 重新合成（Cherry + excited 的缓存键）
```

### 新增测试

- `tests/notify-classify.test.mjs`：真实载荷 `agent-turn-complete` 必须判成 task-complete；`turn-incomplete`
  不能误判；错误载荷 / 坏 JSON / 空载荷都要降级而不是抛错。
- `tests/notify-hook.test.mjs`：链式 notifier 缺失 → 退出码 0 且仍然写日志；存在 → 照旧转发；chain 文件损坏 → 不致命。
- `tests/panel-launcher.test.mjs`：窗口不许隐藏、参数齐全、启动冷却生效且会过期。

### 五个问题

1. **未按预期发生时页面还正确吗**：面板入口在会话失效时返回可读的「重新加载」页而不是灰屏；窗口只在
   `/amadeus/panel/` 真的应答（2xx/3xx）之后才打开，不会对着死端口开窗。
2. **两件事同时发生**：watcher 与手动启动被 5 秒冷却串行化，只留一个窗口；一句台词只有一个 audio owner。
3. **换环境还能不能跑**：找不到浏览器 → 退回标签页；链式 notifier 被删 → 只记一行日志；daemon 不在 →
   记 `daemon=down` 后正常退出，而不是崩掉。
4. **长期可维护**：分类逻辑从 CLI 搬进 `src/core/notify-event.mjs` 并配测试；窗口参数抽成纯函数；
   每个修复都留下「改回去就会红」的回归测试（234 条）。
5. **错误边界**：hook 全程有超时且不抛；空 argv、坏 JSON、缺 exe、缺 daemon、端口不通都有测试或真机覆盖。

### 本轮验证

```
npm test                    234/234 通过
npm run check               84 文件语法 + 分发清单 + 234 测试 通过
npm run verify:ui           28/28 通过（含 app 窗口 284x504 居中、立绘居中 content=130 canvas=130）
真机 app 窗口               1 进程 / 1 可见窗口，482x835 @160% = 300x520 逻辑，标题 AMADEUS
真机并发开窗                watcher + Amadeus.exe 间隔 0.7s → 仍只有 1 个窗口
真 codex exec 播报          chain-missing → task-complete → :sent status=200 broadcasted=true → 语音缓存落盘
链式转发回归（可执行存在）  伪造 chain 指向 marker 脚本 → marker 被写出（转发仍然生效）
```

### 环境备注（本轮的连带发现）

- 本轮期间 Codex 自己清空了 `%USERPROFILE%\.cache\codex-runtimes`（连它自带的 `pwsh.exe` 和
  `codex-computer-use.exe` 一起消失），所以后续命令改用系统 Windows PowerShell 5.1 执行。
- Amadeus 的缓存刚好也在这个目录树下（`~/.cache/codex-runtimes/amadeus`），属于**应当搬走**的耦合点：
  Codex 一次清理就会连带删掉模型/语音缓存。建议后续把 `cacheRoot` 改到 `%LOCALAPPDATA%\Amadeus\cache`。

## 2026-10-16：Codex 更新后唤醒、来电铃声、重复播报

用户报三件事：Codex 更新后 Amadeus 唤不醒、来电没有声音、在手机界面聊一句会同时听到回复和「任务完成」播报。三件都定位到根因并修好了。

### 1. 唤不醒：三个叠在一起的原因

- **Codex 更新会改写自己的 `notify` 键**：现场证据 `node bin/amadeus-hook.mjs status` →
  `command = [...codex-computer-use.exe, "turn-ended"]`、`installed: false`。我们的 hook 被摘掉，
  任务完成播报和 ping 一起停了。现在 hook 是**常驻维护**的：watcher 启动时和检测到新构建时都会
  `ensureNotifyHook()`；对方原来的命令先存进 `notify-chain.json` 再替换，卸载/移除时还原。
- **daemon.json 指向死进程**：现场是 `daemon.json = pid 37844 / port 12183`，而真正活着的 daemon
  （pid 37712）在 5394 端口上监听 —— 客户端永远连不上，面板永远起不来。现在 `readDaemonInfo()`
  会把「pid 已经不在」的记录判为过期；daemon 启动时先做健康检查再决定是否让位，运行中每 60 秒
  自查 `daemon.json`（丢了或是别人的就重写；发现另一个**活**实例就自己退出）。
- **watcher 的 `launched` 闩锁**：它只在「Codex 完全消失过一次」后才会重新开面板，Codex 更新时
  进程常常不给你这个空档。现在用 `codexSignature()`（CLI `bin\<hash>` 目录 + `WindowsApps\OpenAI.Codex_*`
  版本目录的指纹）判断「换了一个 Codex 构建 = 新的 presence」→ `force` 重开面板；另外开了窗但
  25 秒内没有任何客户端连上，也会重试（最多 3 次），而用户自己关掉的面板照旧保持关闭。

### 2. 来电没有声音

以前来电只有 TTS 台词，没有自己的提示音，所以合成慢/被静音时就完全没声。现在铃声是独立通道：

- `<data>/sounds/incoming.<wav|mp3|ogg|m4a>` 用户放进去的优先；
- 否则从系统导入一次邮件提示音（`%WINDIR%\Media\Windows Notify Email.wav`）→ `<data>/sounds/system-incoming.wav`；
- `GET /amadeus/sound/incoming` 提供（只从我们自己的数据目录读，不接受调用方给的路径，需要鉴权）；
- 面板用独立的 `#ring` 元素播放，循环、20 秒封顶、被自动播放策略拦下时下一次点击补响；
- 语义改成「先响铃，接听后她才开口」，拒接不播；设置里新增「来电铃声 / 铃声音量」。

### 3. 一句对话听到两个声音

面板自己的对话也是 `codex exec` 跑的，工作目录固定为 `<data>/runtime/chatcwd`，于是那次
`agent-turn-complete` 也被当成「真实任务完成」播报了一句话。现在 `classifyNotifyEvent(payload, { dataRoot })`
增加 origin 判定：cwd 在我们数据目录里就是 `panel` → hook 直接跳过并写
`kind=task-complete:panel-origin broadcast=skipped`；daemon 路由再兜底一层（`origin === 'panel'`
返回 `broadcasted:false`，并记一条 audit）。

### 附带：缓存搬出 Codex 的目录树

`cacheRoot` 从 `~/.cache/codex-runtimes/amadeus`（Codex 更新会整棵删掉）搬到 `%LOCALAPPDATA%\Amadeus\cache`，
并做一次性迁移（`migrateLegacyCache()` 只复制新目录里缺的文件，最多 2000 个 / 512 MB，留标记不重复跑）。

### 新增测试

- `tests/codex-config.test.mjs`：没有 notify 行时插到首个表头之前；Codex 那种 `[ "a", "b" ]` 空格写法能解析；
  接管别人的命令前先写 chain；重复运行幂等且绝不把自己的命令写进 chain；移除时还原；缺 config/缺 hook 只报告不创建。
- `tests/watch-signature.test.mjs`：指纹随构建变化、读不到时返回空串不抛；`signatureChanged` → `relaunch`，
  面板已连上时 `seen` 优先，`retryDue` → `launch`。
- `tests/ringtone.test.mjs`：独立元素、循环、音量夹取、接听即停、20 秒封顶、自动播放被拒后按手势补响。
- `tests/sounds.test.mjs`：系统导入一次并复用、用户文件优先、太小/缺失降级为 no-ring、content-type 映射。
- `tests/call-ring-route.test.mjs`：铃声路由要鉴权且返回字节；`origin: panel` 的播报被拒并留 audit；真实任务照旧播报。
- `scripts/ui/verify-call.mjs`（`npm run verify:call`）：向真实 daemon `POST /amadeus/call`，检查浮层、铃声真的在播、
  队列没有被重复投递、接听停铃并触发 TTS、拒接停铃。

### 五个问题

1. **未按预期发生时页面还正确吗**：铃声拿不到 → 静音但浮层与台词照旧；`notify` hook 被摘 → watcher 自己装回去；
   daemon.json 指向死进程 → 客户端不再相信它，重新拉起并把指针写正。
2. **两件事同时发生**：两个 daemon 抢同一个数据目录时，只有拿到指针且健康检查通过的那个留下，另一个自己退出；
   开窗失败（25 秒无客户端）有界重试，用户主动关窗不会被强行拉起。
3. **换环境还能不能跑**：Codex 换版本/换安装位置有指纹兜底；Codex 更新删缓存不再影响我们（缓存已搬走 + 迁移）；
   没有系统提示音的平台降级为「无铃声」而不是报错。
4. **长期可维护**：hook 维护逻辑集中在 `src/core/codex-config.mjs`（CLI 与 watcher 共用），窗口/铃声/播报判定都在
   可单测的纯函数里，每个修复都留下了会失败的回归测试（260 条）。
5. **错误边界**：所有新路径都有超时或上限——hook 写入失败会报告而不是覆盖、指纹读不到返回空串、
   铃声 20 秒封顶、迁移有文件数/体积预算、call 线路必须 ack 以免被 hub 反复重投。

### 本轮验证

```
npm test                    260/260 通过（新增 26 条：hook 维护、指纹/决策、铃声、铃声路由、播报来源）
npm run check               94 文件语法 + 分发清单 + 260 测试 通过
npm run verify:ui           28/28 通过（设置里多了「来电铃声 / 铃声音量」两行，其余不变）
npm run verify:call         13/13 通过（真实 daemon：铃声 t=1.4s 在播、接听触发 1 次 TTS、拒接停铃、队列不重复投递）
真机唤醒                    watcher 启动 → daemon pid 29180 / port 12183（复用原端口）→ 面板窗口可见、clients=1
hook 修复现场               node bin/amadeus-hook.mjs status 曾显示 installed:false → ensure 后 config.toml 恢复我们的 notify，
                            原命令仍完整保存在 notify-chain.json
播报来源（真机）            cwd=<data>\runtime\chatcwd 的 turn → origin=panel → broadcast=skipped；
                            cwd=项目的 turn → origin=codex → :sent status=200 broadcasted=true
铃声资源（真机）            /amadeus/sound/incoming → 200 audio/wav 376120B，X-Amadeus-Ring: system（邮件提示音）
```

## 2026-10-16（第二轮）：点她的音色、语音卡顿/消失、移植不带 key

用户报三件事：点角色时听到的音色和回答音色不一样；有些回答语音卡顿、甚至整句没声；把项目移植给别人时不要用作者本人的 API key 供对话。

### 1. 点她的音色和回答不一致

点击时播放的是模型自带的 15 个原版语音片段（`flickHead / tapBody / pinchIn / pinchOut / shake` × 3，36–126 KB 的 MP3）——那是**原作声线**，和设置里选的音色（默认 Cherry）当然不是一个人。
现在点她走同一个语音通道：面板 `POST /amadeus/say` 发一句短反应（`ふぅん。 / なによ。 / ん？ / ちょっと。 / ……バカ。`，带情绪标签），由**当前音色**合成，2.5 秒节流；原版片段保留在设置里的「原版动作音效」（默认关闭）。
这几句日文台词在源码里写成 `\uXXXX` 转义：`tests/ui-strings.test.mjs` 禁止 `src/panel` 出现字面假名（防止日文漏进中文 UI），转义让这条规则继续严格，而不是为它开口子。

### 2. 语音卡顿与整句消失

三个独立原因，全部修掉：

- **未确认的句子被反复重投、最后丢弃**：一句回复拆成多句排队，但只有正在播的那句能"播完确认"。其余句子在 hub 里 20 秒没确认就被重投，面板按 id 去重（于是既没播、也没确认），再被判 `no acknowledgement from panel` 丢弃——长回复的最后一句就是这样消失的。现在面板**收到即确认**（`status: 'accepted'`，hub 视为已投递并出队），播放失败仍然上报。
- **逐句合成、句间空转**：每句都要等上一句播完才开始合成，句与句之间是一次云端往返的静音，听起来就是卡顿。现在播第一句时**预取下一句**，下一句落地即播。
- **切分丢尾巴 / 切在词中间**：`splitSentences` 超过 12 句就停止 push（后面的内容静默丢失），超过 200 字直接硬切。现在上限提到 24 句，超出的合并进最后一块（≤280 字，provider 上限 300），并且优先在标点处切断。

顺带加了语音文本清洗 `sanitizeForSpeech()`：markdown、链接、emoji 在送进 TTS 之前去掉（缓存键也随之稳定），纯 emoji / 标点的行直接跳过，而不是让 provider 回 400 变成"没声音"。

### 3. 移植给别人不带你本人的 key

- 对话默认走 `codex-exec`，复用**对方自己的** Codex 登录，不需要任何 key；语音默认阿里云，但没填 key 时会自动退回内置 Edge 女声。
- 新增凭据闸门 `scripts/portable-scan.mjs`：打包前扫描所有要分发的文件，命中 `sk-…`、`Bearer <长串>`、云厂商 key、私钥块，或出现 `secrets.json` / `config.json` / 日志等运行期数据，就直接**拒绝打包**。`npm run check` 里也加了这一步，`npm run verify:portable` 可单独跑。

### 新增测试与脚本

- `tests/speech-limits.test.mjs`：标点优先切分、超长回复不丢结尾、每块 ≤280 字、清洗规则（markdown/链接/emoji/空输入）。
- `tests/hub-receipt.test.mjs`：收到即确认立刻出队；失败仍然重试；同一句只投递一次。
- `tests/portable.test.mjs`：默认对话通道不需要 key；仓库里没有凭据；带 key 的文件会被拒绝；运行期数据文件按名拒绝。
- `scripts/ui/verify-speech.mjs`（`npm run verify:speech`）：真实面板与 daemon —— 点她走语音通道且不播原版片段；三句连续合成各一次、顺序正确、无丢弃、无播放失败、无页面错误。

### 五个问题

1. **未按预期发生时页面还正确吗**：语音合成失败只影响那一句（并上报），队列继续走；无可朗读字符的行直接跳过；原版片段缺失只影响「原版动作音效」这个可选功能。
2. **两件事同时发生**：连点被 2.5 秒节流；预取与播放按 id 对齐，清空队列会连同预取一起丢弃；收到即确认让"正在播"与"排队中"不再互相误判。
3. **换环境还能不能跑**：没有 key → 内置女声；没有网络 → 该句上报失败但不阻塞后面的句子；没有系统铃声/素材 → 各自降级，互不牵连。
4. **长期可维护**：切分、确认、清洗各自独立成模块并配测试；凭据闸门既在 `check` 也在打包流程里，规则集中在一个文件。
5. **错误边界**：切块有上限（280 < provider 300）、句数有上限且不丢内容、预取失败会在轮到它时抛出并被捕获、凭据闸门失败即拒绝出包。

### 本轮验证

```
npm test               273/273 通过（新增 13 条：切分/清洗、hub 收到即确认、可移植性）
npm run check          101 文件语法 + 分发清单 + 273 测试 + 无凭据 通过
npm run verify:portable PASS（仓库无任何凭据material）
npm run verify:speech   9/9 通过（点她→1 次语音合成、无原版片段；三句各合成一次且顺序正确；无丢弃、无失败）
npm run verify:call     13/13 通过（来电铃声/接听/拒接全链路未受影响）
```

## 2026-10-17：把 Code-Codex 的四个做法搬进来

参照 `Rice-dog/code-codex`（同样面向 Codex Desktop 的本地伴侣项目）的实现，挑了四条最匹配、且不会碰坏已有行为的东西落地。

### 1. 日志边界脱敏（他们的 `runtime_redaction.rs` / `runtime-redaction.ts`）

`notify.log` 之前存的是 Codex 的**原始载荷**——用户的整段提示词、工作目录、回复全文；`audit.jsonl` 存操作摘要。
新增 `src/core/redact.mjs`：URL（本机地址保留 origin+path、去掉 token 查询串；远端整条丢弃）、Windows/UNC/POSIX/`~/` 路径、
`Bearer …`、`sk-…`/`LTAI…`/私钥块、邮箱一律替换；**诊断信息（码、端口、耗时、kind/type/origin/布尔）原样保留**。
对象层面按字段名判断（`token/cookie/password/secret/authorization/apikey` 以及 `content/text/body/prompt/messages/`
`input-messages/last-assistant-message/raw/commandline/thread-id/turn-id/cwd/…`）直接打成 `[redacted]`，深度 ≤6、宽度 ≤128、预算 256 条。
- notify hook 现在**先脱敏再写日志**：`argv=["turn-ended",{"type":"agent-turn-complete","thread-id":"[redacted]","cwd":"[redacted]",…}]`。
- `audit.record()` 同样过一遍再截断到 200 字。
- 旧日志不再"读的时候才想办法"：导出报告时逐行解析，连**过去写的**、把载荷塞在字符串里的老格式也会被结构化脱敏（`redactLogLine`）。

### 2. 支持报告（他们的"复制脱敏诊断报告"）

新增 `amadeus report`：把 `/amadeus/diag?deep=1`、`/amadeus/status`、客户端报告、审计尾部、`notify.log`/`watch.log` 尾部
汇总成一份**脱敏 JSON**，写到 `%LOCALAPPDATA%\Amadeus\diagnostics\amadeus-report-<时间>.json` 并打印路径。
真机验证：报告里没有 `人设：Amadeus`/`你还好么`/提示词/`SENTINEL`，凭据扫描 `[]`；同时 `kind=task-complete`、`origin=panel`、
`notifyHook`/`ringSound`/`storage` 这些真正有用的东西还在。

### 3. 稳定诊断码（他们的 `CC-START-CDP-014`）

新增 `src/core/codes.mjs`：`AM-1001` 数据目录不可写、`AM-1002` 缺少所有权标记、`AM-1101` 找不到 codex CLI、
`AM-1201/1202/1203` 模型/运行时/哈希、`AM-1301/1302` 语音输入/系统播报、`AM-1401` 内置 Edge 音色不可达、
`AM-1501` 没有来电铃声、`AM-1601` daemon 指针过期、`AM-1602` notify 钩子被摘、`AM-1701` 找不到浏览器。
`doctor` 的每条 degrade 现在都是 `{ code, capability, reason, action, note }`。
同时修掉一个**假警报**：persona 之前是在数据目录上一级找的，永远找不到——现在按项目根解析。

### 4. 先验身份再杀进程（他们的 `process_guard`）

`killStalePanelBrowsers` 原来按"命令行里包含 profile 路径"杀进程——这正是上次把我自己的验证 shell 一起杀掉的原因。
现在：只查询浏览器镜像（`msedge/chrome/brave`），并且要求 profile 是**完整**的 `--user-data-dir=` 参数
（`panel-profile-old` 这种同前缀目录不算），去重、排除自身 pid；查询或终止失败一律返回 0 而不是抛错。
真机：重启面板时旧窗口被正确替换，只有 1 个可见窗口，没有任何无关进程被杀。

### 另外两件顺手补齐的

- `src/shared/layout.mjs`：目录清单单一来源（`ensureDirs` 直接用），并在数据根写入 `storage-layout.json`
  （product/schema/dataRoot/cacheRoot），`doctor` 里能看到 `checks.storage`。**不含任何删除逻辑**——
  标记只是"这目录是我们的"声明，将来真要清理时先验标记再说。
- `tests/portable-scan.mjs` 的凭据闸门继续在 `check` 与打包里生效（上一轮加的），本轮新增的报告也拿它扫过。

### 新增测试

- `tests/redact.test.mjs`：路径/URL/凭据/邮箱 sentinel 全灭；诊断字段存活；对象字段级脱敏；深层 JSON 字符串也会被解析脱敏；
  循环引用、BigInt、抛异常的 getter、超长输入不抛错且输出有界。
- `tests/process-identity.test.mjs`：只是"提到路径"的 shell 不会被杀（就是那次事故的回归）；同前缀目录不算；只杀匹配的浏览器；
  查询/终止失败返回 0。
- `tests/layout.test.mjs`：`ensureDirs` 建立清单并声明所有权；别的 product/schema/坏 JSON 都会被视为未声明并重写。
- `tests/diag-codes.test.mjs`：每条 degrade 都有 `AM-\d{4}` + reason + action；缺模型/运行时、钩子被摘、钩子正常各一条。

### 五个问题

1. **未按预期发生时页面还正确吗**：脱敏失败时返回 `[redacted]` 而不是原文；报告写不出来会抛错给 CLI（用户可见），不会静默生成半份；
   身份校验失败只是"不杀进程"（旧窗口留着），不会误杀。
2. **两件事同时发生**：报告导出与 daemon 读取互不写同一文件；杀进程先查后杀且只杀匹配项；`ensureOwnership` 只写一次标记。
3. **换环境还能不能跑**：没有 `%TEMP%`、没有浏览器、没有 Codex 配置都能得出报告；Windows/POSIX 路径、UNC 都能脱敏。
4. **长期可维护**：码表、布局清单、脱敏规则各自一个模块并有测试；报告字段依赖这些模块，不再各写一份。
5. **错误边界**：脱敏深度/宽度/长度有界，坏 JSON 行降级；杀进程有 15 秒超时并吞掉异常；所有权标记损坏会被重写。

### 本轮验证

```
npm test               295/295 通过（+22：脱敏、进程身份、布局/所有权、诊断码）
npm run check          108 文件语法 + 分发清单 + 295 测试 + 无凭据 通过
amadeus doctor         checks 里新增 storage / ringSound / panelBrowser / notifyHook（ok:true，degrade 为空）
amadeus report         生成脱敏报告；人不出现、码与诊断出现；凭据扫描 []
真机重启               watcher → 新面板窗口 1 个可见、daemon 12183、旧窗口被身份校验正确地替换
npm run verify:speech  9/9 通过
npm run verify:call    13/13 通过
```

## 2026-10-17（第二轮）：长期记忆真的会记了、桌面端任务开始/结束会互动

用户报两件事：长期记忆记不住上次打开时的对话；任务开始/完成时她都不出声。

### 1. 记忆是"真 bug"，不是没打开开关

两处叠加导致**单句模式下永远提取不出任何东西**：

- `#maintain` 只在 `assistantCount % 6 === 0` 时提取。单句模式每轮都关会话，`assistantCount` 永远是 1 → 条件永不成立。
- `extractMemories` 还要求 `messages.length >= 4`（两轮对话），单句会话只有 2 条 → 即使被调用也直接返回。

现在：会话关闭（单句模式每轮都会关）就是提取时机，条数门槛降到 1 轮；另外每轮关闭时写一条**对话回顾**
（`上次聊天：用户说「…」，我回应「…」`，`source: conversation`），只保留最近 3 条，免得盖过真正的事实。
事实仍走原来的 `auto-extract`（提示词不变，仍然只记长期有效的信息）。

真机实测（面板对话一轮"记住一件事：我住在上海，我的猫叫小白。"）：

```
auto-extract | 用户养了一只猫，名字叫小白
auto-extract | 用户的猫叫小白
auto-extract | 用户住在上海
conversation | 上次聊天：用户说「…」，我回应「你住在上海。还有，猫叫小白，对吧。我记住了。」
audit        | {"source":"chat","tool":"memory.extract","summary":"+2"} / "+1"
```

（本机配置已打开 `memory.enabled` + `memory.autoExtract`；关掉开关就回到"陌生人"模式，测试里也钉住了这一点。）

### 2. 桌面端任务没有互动：notify 钩子根本收不到桌面端的回合

`notify` 只对 `codex exec` 生效。桌面窗口里跑的任务从不触发它——所以任务开始没有反应，任务结束也只有 CLI 才播报。
现在改为读 Codex 自己的会话 rollout（`~/.codex/sessions/**/rollout-*.jsonl`，**只读**）：
`task_started` / `task_complete` / `turn_aborted` 就是回合边界，桌面端与 CLI 都能覆盖。

- 新 `src/host/task-watch.mjs`：只跟最新的几个 rollout 文件，**首次只记录偏移量不回放历史**，按行解析、
  半个未写完的行留到下次，按 `turnId+kind` 去重；面板自己发起的会话（cwd 在我们的数据目录里）整份忽略。
- 新增"任务开始"互动 + 设置项「任务开始互动」（默认开）。CLI 回合仍走 notify 钩子，两条路径共用一份
  **turnId+kind 账本**，所以同一回合不会被播报两次（一个回合的 start 与 complete 互不影响）。
- 真机 E2E（临时 sessions 目录，不碰真实会话）：追加 `task_started`/`task_complete` → daemon 依次播报，
  audit 出现 `task.start` / `task.complete`，队列里两条待播。
- 回归点：线程可能已经跑了几天（文件在更早的日期目录里），第一版"只取最新目录里最新的几个文件"会漏掉它；
  现在扫描时按 mtime 统一排序并保留已跟踪文件，测试里复现了这个形状。

### 新增测试

- `tests/chat-memory.test.mjs`：单句模式会提取事实、会写回顾、回顾数量有上限、开关关掉时不写、
  以及记忆会出现在**下一个会话**的系统提示里。
- `tests/task-watch.test.mjs`：三种回合边界、面板自己的会话被忽略、历史不回放、同一事件不重复、
  半行等待补全、**活跃线程在旧日期目录也能被跟踪**。
- `tests/task-announce.test.mjs`：同一 (turnId, kind) 只播一次、不同 turnId 各自播、start 不会被 complete 压掉、
  面板来源仍然不播、播报会写进 audit。

### 五个问题

1. **未按预期时页面还正确吗**：rollout 读不到/被删只是没有互动，不影响对话与语音；半个 JSON 行不会被当成事件；
   回顾写入失败只记一条 warn。
2. **两件事同时发生**：notify 与 watcher 同时看到同一回合 → 账本按 (turnId, kind) 去重；
   单句模式下每个回合结束才做提取，不会与下一轮抢会话文件。
3. **环境变化还能不能跑**：没有 `~/.codex/sessions`（没有桌面端/换机器）→ 只保留 CLI 播报；
   `AMADEUS_CODEX_SESSIONS` 可以指到别的目录（也是测试用的注入点）；日期目录跨月/跨年都能扫到。
4. **长期可维护**：解析、滚动读取、去重各自是纯函数/独立类；播报线路集中在 `announceTask`；
   记忆提取与回顾在 `chat.mjs` 里显式写明"为什么是会话关闭时做"。
5. **错误边界**：读取窗口有上限（128 KB/文件、最多 3 个文件）且从文件末尾对齐；账本上限 300 条并按时间老化；
   回顾只留 3 条；`turnId` 缺失的回合一律忽略。

### 本轮验证

```
npm test            310/310 通过（+15：记忆管线与回顾、rollout 事件、双路去重）
npm run check       112 文件语法 + 分发清单 + 310 测试 + 无凭据 通过
真机记忆            面板对话一轮后写入 3 条 auto-extract + 1 条 conversation 回顾，audit 记录提取
真机任务互动        watcher(临时 sessions) → task.start / task.complete 各播报一次，队列 2 条
真机 CLI 回合        notify 钩子 → kind=task-complete:sent status=200 broadcasted=true
```

## 2026-10-17（第三轮）：修掉「目标达成」提前出现

用户报：「目标达成」时机不对，任务还没做完就播报了。

### 根因：播报的不是用户那个回合

rollout 里的 `task_complete` 本身写在正确的位置（实测：最后一条 assistant `message` 之后 9 ms，
之后直到下一次 `task_started` 只有 `thread_settings_applied`）。问题在**是哪个回合**：
我工作时会派生 `codex exec`（跑检查、抓数据、验证），每次都是一次独立会话，于是
**子任务的完成也被当成"任务完成"播报**——用户还在看我干活，她已经说「目标达成」。
（上一轮我自己跑的 `codex exec reply with OK` 就是这种子任务，17:05:36 完成时被播报了一次。）

### 修法

- 新 `src/host/task-policy.mjs`：`ActiveTurnLedger` 记录"当前有几个回合在跑"。
  在另一个回合仍未结束时开始的回合是**嵌套回合**，它的开始与结束都只记 audit（`task.nested-start` /
  `task.nested-complete`），不发声；只有最外层用户回合播报。
- 一个回合最多活 10 分钟：崩溃的子任务不会永久压住后面的播报。
- notify 路径（CLI `codex exec`）同样检查"当前有没有用户的回合在跑"，有就返回 `nested-turn` 不播。
- 另外补了一条**过期播报**规则：`kind: 'broadcast'`（开始/完成这种"新闻"）在队列里超过 5 分钟就丢弃并记录原因，
  面板关着时结束的任务不会在下次打开面板时突然冒出来播报；用户要的那句回复不受影响。

### 真机 E2E（临时 sessions 目录，不碰真实会话）

```
task.start           main-1       ← 用户回合，播报
task.nested-start    helper-1     ← 子任务，只记 audit
task.nested-complete helper-1     ← 不再出现"提前完成"
task.complete        main-1       ← 真正的结束，播报
pending = 2（只有 start + complete 两句）
```

### 新增测试

- `tests/task-policy.test.mjs`：外层回合播报、嵌套回合不播、子任务失败不影响外层、崩溃回合 10 分钟后过期、
  缺 turnId 的事件不会被误判为嵌套。
- `tests/hub-receipt.test.mjs` 增补：过期播报在面板连上时被丢弃（不回放），用户的回复仍然保留。
- `tests/task-announce.test.mjs` 增补：有活跃用户回合时，notify 的完成事件返回 `nested-turn`。

### 五个问题

1. **未按预期时页面还正确吗**：账本只影响"要不要出声"，任何异常都不会阻断对话与语音；过期播报只丢"新闻"。
2. **两件事同时发生**：嵌套判定基于"当前还有几个回合在跑"，同一 (turnId, kind) 仍只播一次。
3. **换环境还能不能跑**：没有嵌套（纯 CLI/纯桌面）时行为与上一轮一致；崩溃的子任务最多压 10 分钟。
4. **长期可维护**：判定逻辑独立成 `task-policy.mjs` 并有测试，播报入口只有 `announceTask` 一个。
5. **错误边界**：账号/回合 id 缺失一律按"非嵌套"处理（宁可播报也不静默），过期有 5 分钟上限，账本按时间老化。

### 本轮验证

```
npm test          317/317 通过（+7：嵌套回合策略、过期播报）
真机嵌套 E2E      start / complete 各一次，helper 两次只留 audit
真机状态          daemon 12183、面板窗口 1 个、clients=1、pending=0
```

## 2026-10-19：闲聊长时间等待的链路修复

面板曾在「你最近在做什么实验」后停留在等待状态，下一句也没有助手记录。排查发现：

- 旧版每次调用 `codex exec` 都继承用户的高推理设置，并与面板共用 120 秒超时；CLI 没有完整助手消息时，面板只显示省略号。
- 本机 Codex CLI 的模型采样请求连续超时重试。Windows 系统已启用回环代理，但 CLI 子进程没有代理环境变量。给一次诊断调用显式传入系统代理后，同一角色问题约 22 秒得到完整回复。

改动限定在 Amadeus：对话调用单独使用 `low` 推理；Windows 系统代理仅在子进程没有现成代理变量时传给它；后端 60 秒、面板 75 秒；界面显示连接、等待、重试阶段；审计只记回合 ID、阶段与耗时。没有用户长期事实的闲聊跳过额外的自动记忆模型请求。不会修改 Codex 全局配置或 Windows 代理，也不会显示模型内部推理。

五个边界：失败时显示明确的模型连接错误，页面恢复可发送；并发回合仍由原会话队列排序；无系统代理时沿用现有环境；代理解析与阶段传递有独立测试；超时、取消与断线仍有边界，诊断记录不含提问原文。
