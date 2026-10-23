# 安装 / 升级 / 卸载

## 前置条件

| 需要 | 说明 |
| --- | --- |
| Node.js 22+ | 本机服务运行时。安装脚本会检查并在版本过低时明确报错 |
| Microsoft Edge WebView2 Runtime | Windows 独立桌面窗口的渲染运行时；不是 Edge 浏览器标签页 |
| Codex Desktop | MCP 由 Codex 拉起，任务边界由本机守候程序与 notify 传递 |
| Windows | 安装脚本是 PowerShell。Linux/macOS 见下方"手工注册" |

安装 Amadeus 本体不需要 Python、curl、API key 或 npm 运行时依赖；从零制作**本地克隆音色**则需另装 Qwen TTS WebUI，完整步骤见根目录 [使用教程.md](../使用教程.md)。

## 安装（发行包）

1. 完整解压 `amadeus-codex-<version>.zip` 到固定目录（路径含空格也可以）。
2. Windows 用户双击解压目录里的 `安装 Amadeus.cmd`。它会完成下述安装、检查/下载角色素材并打开面板；之后重启 Codex Desktop。音色克隆是独立步骤，详见根目录 [使用教程.md](../使用教程.md)。

命令行安装（进阶）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

脚本会依次检查文件、注册连接、配置启动项并启动服务：

1. **前置检查**：Node 版本 + 分发清单里 `requiredForInstall` 的每个文件是否存在。
   缺件会一次性全部列出，并在动配置之前退出（退出码 1）。
2. 备份 `%CODEX_HOME%\config.toml`（若存在），然后在**临时文件**里追加注册块，
   用 `Move-Item -Force` 覆盖目标——中断不会截断原配置。
3. 注册 `[mcp_servers.amadeus]`。已注册时保持原样，重复执行不会写第二份。
4. 用 Windows 的 .NET Framework C# 编译器和包内 WebView2 SDK 现编译 `Amadeus.exe`。缺少编译器或 WebView2 SDK 时明确失败，不会静默退回浏览器窗口。
5. 接管 Codex 的 `notify`：原本已有 notify 时把旧命令存到
   `%LOCALAPPDATA%\Amadeus\notify-chain.json`，我们的脚本每次先转发旧命令、再通知 Amadeus
   （卸载时还原）。这样任务真正完成时面板才会出声。
6. 启动 daemon 并打印面板地址。

安装完成后**重启 Codex Desktop**，MCP 才会被加载。
Codex 建立 Amadeus MCP 连接时会直接打开面板；安装脚本也会在「启动」文件夹放一个
快捷方式（`Amadeus Panel.lnk` → `Amadeus-watch.vbs`），由隐藏的 `wscript` 守护
`bin\amadeus-watch.mjs`，作为备用唤起路径。watcher 异常退出后 5 秒重启。面板在一次
Codex 会话中只自动打开一次；手动关闭后不会因为新的 MCP 连接再次弹出。
不需要 Codex 的 hook 机制，也不需要你在 `/hooks` 里信任任何东西。
不想要开机自启就加 `-NoAutoStart`。

双击发行包的安装入口还会立即启动本次登录的 watcher，不用等到下次重启电脑。`Amadeus.exe` 是独立 WinForms 应用窗口，界面内容由 WebView2 从本机 `127.0.0.1` 服务渲染；不会打开 Edge/Chrome 标签页。需要排查页面时，才手动运行 `node bin/amadeus.mjs open --browser`。

发行包已附带默认图标 `scripts/Amadeus.ico`。安装时构建器将其同时用于 EXE 文件和应用窗口。若要换成自己的图标，可在源码层替换该文件，关闭正在运行的 Amadeus 窗口，再执行 `powershell -ExecutionPolicy Bypass -File scripts/build-launcher.ps1`。重新分发替换后的图标前，请确认其授权。

如果已经在 `%LOCALAPPDATA%\Amadeus\qwen-service.json` 配好本地克隆音色，安装脚本还会创建当前用户的计划任务 `Amadeus Qwen TTS`。它在登录后隐藏启动 Qwen API，进程退出后尝试重启；`-NoAutoStart` 或 `-Uninstall` 会移除这项任务，不删除克隆音色或配置。首次加载模型可能需要几十秒。若使用自定义 `AMADEUS_DATA_DIR`，此任务不会自动创建，需自行启动 Qwen。任务调用的是配置中的本地 Python 和 `launch.py`，不会改用其他声线。

## 用 Codex 插件市场安装（可选）

除了上面的脚本，也可以把本项目注册成 Codex 插件市场，让 Codex 自己管理插件：

```powershell
node scripts\make-dist.mjs                      # 生成 dist\marketplace（只含发行文件）
codex plugin marketplace add dist\marketplace    # 注册市场
codex plugin add amadeus@amadeus                 # 安装插件
codex plugin list --available                    # 应看到 amadeus@amadeus
```

安装脚本也支持一步到位：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Marketplace
```

它会在 `config.toml` 里追加（幂等、先备份、原子写入）：

```toml
[marketplaces.amadeus]
source_type = "local"
source = 'C:\path\to\amadeus-codex-0.1.0'

[plugins."amadeus@amadeus"]
enabled = true
```

`source` 用单引号字面量，Windows 路径里的反斜杠不需要转义。

**不要**直接把仓库根注册成市场：插件路径就是仓库根，Codex 会把 `node_modules/`、
`work/`、`dist/` 一起复制进插件缓存。`make-dist` 生成的 `dist\marketplace` 只含发行文件
（约 1 MB），用它注册即可。

## 打开面板

```powershell
node bin\amadeus.mjs open
```

面板是独立本地 Web 应用（Codex 没有内嵌自定义视图的能力），但默认**以应用窗口打开**：
无标签页、无地址栏，**300x520 的小弹窗**，窗口里就是那台翻盖手机本体 —— 手机本身封顶
284x504，窗口被拉大也不会跟着变大（屏幕太矮时还会按可用高度的 72% 自动收窄）。
想要更大/更小就设 `AMADEUS_PANEL_SIZE=W,H`。
用 `--browser` 才退回浏览器标签页（那里的布局是手机浮在页面中间）。
双击插件目录里的 `Amadeus.exe` 等价于"启动 daemon + 弹出面板窗口"。

首次打开会自动换成会话 cookie，长 token 不会留在地址栏。

首次看 Live2D 还需要素材：

```powershell
node bin\amadeus.mjs assets install   # 约 8.6 MB，校验 SHA-256
```

如果你手上已经有模型文件、不想走下载：

```powershell
node bin\amadeus.mjs assets install-file kurisu-model "D:\你自己\kurisu.tar.gz"
```

文件会先按注册表里的 SHA-256 校验，对不上直接拒绝并打印 expected/got，不会写进缓存。

## 升级

覆盖解压到同一目录后重跑 `install.ps1` 即可。注册块幂等，配置不会重复。
用户数据在 `%LOCALAPPDATA%\Amadeus`，模型缓存在 `%LOCALAPPDATA%\Amadeus\cache`，
两者都不在发行包内，覆盖安装不会丢。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
```

会停止 daemon 并从 `config.toml` 里移除注册块（同样先备份），**保留**你的数据目录与模型缓存。
要彻底清掉数据，手动删除 `%LOCALAPPDATA%\Amadeus`。若你用环境变量改过缓存位置，还需检查 `AMADEUS_CACHE_DIR` 指向的目录。

## 手工注册（Linux / macOS）

安装脚本只覆盖 Windows。其它平台在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.amadeus]
command = "node"
args = ["/绝对路径/amadeus-codex/bin/amadeus-mcp.mjs"]
startup_timeout_sec = 30
```

## 排查

先跑自检，它会把每个降级项的**原因和动作**列出来：

```powershell
node bin\amadeus.mjs doctor --deep
```

| 现象 | 先看 | 常见原因 |
| --- | --- | --- |
| 安装脚本退出码 1 | 脚本打印的缺件列表 | 发行包没解压完整 |
| Codex 里看不到 amadeus 工具 | 是否重启过 Codex | MCP 只在启动时读取 |
| 面板打不开 | `node bin\amadeus.mjs status` | daemon 没起；或地址不是 127.0.0.1 |
| 面板显示占位图 | 自检里的 `live2dModel` / `live2dRuntime` | 素材没装，或运行时哈希不符 |
| 本地克隆没有声音 / HTTP 500 | Qwen TTS WebUI 的 `127.0.0.1:7860/v1/audio/voices` 与模型合成测试 | WebUI 未启动 API、克隆 ID 未注册、模型未加载或端口被占用；详见 [从零克隆教程](../使用教程.md#6-出问题时逐项检查) |
| 对话一直显示等待 / Codex 模型服务请求超时 | 检查 Codex CLI 登录状态与系统 HTTPS 代理是否可用 | Windows 下 Amadeus 会将已启用的系统代理仅传给 Codex CLI 子进程；不会更改系统设置。仍超时时检查网络或改用自己配置的独立对话 API |
| 麦克风按钮没反应 | 自检里的 `语音输入` | 通道设成 `api` 但没配密钥（会退回浏览器识别）；或浏览器本身不带识别服务 |
| 克隆模式下面板没开时听不到播报 | 面板是否连接 | 克隆模式禁用系统音色补播，须打开面板才会用同一克隆声线播报 |
| 对话没反应 | 自检里的 `codexCli` | 找不到 codex，可改用独立 API key 通道 |
| 面板里出现错误提示 | 自检页底部的"最近的客户端错误" | 前端异常会经 `/amadeus/report` 落到 daemon |
| 日志出现 `renames are refused ... EXDEV` | 数据目录所在卷 | 该目录是 EFS 加密的（`%LOCALAPPDATA%` 在部分机器上如此），同一目录内的 rename 会被拒绝；已自动改用复制写入，无需处理 |

日志与状态：

| 内容 | 位置 |
| --- | --- |
| 配置 / 记忆 / 会话 / 审计 | `%LOCALAPPDATA%\Amadeus` |
| 调度状态 | `%LOCALAPPDATA%\Amadeus\proactive.json` |
| 运行态（端口 / token / pid） | `%LOCALAPPDATA%\Amadeus\runtime\daemon.json` |
| 客户端错误 | `GET /amadeus/logs`（需 token），或自检页 |

daemon 是分离进程，stderr 不可见，所以**降级都会写进审计日志**（`audit.jsonl`），
包括调度器的生成失败与素材下载失败。
