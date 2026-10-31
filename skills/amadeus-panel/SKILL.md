---
name: amadeus-panel
description: 打开、启动或排障 Amadeus 翻盖手机面板（Live2D + 聊天）。当用户提到 Amadeus 面板、想看红莉栖、或面板打不开时使用。
---

# Amadeus 面板

Amadeus 的面板是独立的 **Windows 原生 Qt/OpenGL 窗口**，由项目内的 `Amadeus.exe` 启动。面板通过本机回环接口连接 daemon。

## 打开面板

1. 先用 `amadeus_status` 确认 daemon 在线。若返回 `ok: false`，说明 daemon 未启动。
2. 调用 `amadeus_open_panel`。工具直接打开原生面板，返回 `window`、`already-open`、`launching` 等状态。
3. 若返回 `ok: false`，按下方步骤检查依赖与素材；不要尝试打开旧网页地址。

想查看已保存的伴侣会话时用 `amadeus_sessions`；单句模式开机显示空白对话，历史仍留在本机。

命令行的等价操作：

```powershell
node bin/amadeus.mjs start --open
```

## 面板打不开时

按顺序检查，每一步都给出具体结论而不是笼统道歉：

1. `amadeus_status` 是否返回 daemon 信息。
2. `amadeus_capabilities` 返回的 `checks.panelNative.ok` 是否为 true；失败时运行项目目录中的 `安装 Amadeus.cmd`。
3. `checks.live2dModel.ok` 是否为 true；缺失时可用 `amadeus_assets_status` 与 `amadeus_assets_install` 检查、安装。
4. `amadeus_status` 的 `status.events.nativeClients` 是否大于 0；为 0 时说明窗口尚未连接，结合自检与本机日志排查。

## 边界

- 不要在 Codex 对话里复述面板内容。
- 不要尝试把面板嵌入 Codex 或修改 Codex 主题。
- 不要将 daemon token、带凭据的本机地址或用户聊天原文贴进诊断回复。
