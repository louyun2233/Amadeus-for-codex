---
name: amadeus-panel
description: 打开、启动或排障 Amadeus 翻盖手机面板（Live2D + 聊天）。当用户提到 Amadeus 面板、想看红莉栖、或面板打不开时使用。
---

# Amadeus 面板

Amadeus 的面板是一个**独立本地 Web 应用**，不是 Codex 内嵌视图。Codex 没有在主界面注入自定义视图的能力，所以面板通过系统浏览器打开。

## 打开面板

1. 先用 `amadeus_status` 确认 daemon 在线。若返回 `ok: false`，说明 daemon 未启动。
2. 调用 `amadeus_open_panel` 取回带一次性 token 的地址。
3. 把地址交给用户，或用系统命令在默认浏览器打开。

想查看她有哪些会话（面板左侧的记录）时用 `amadeus_sessions`。

命令行的等价操作：

```powershell
node bin/amadeus.mjs start --open
```

## 面板打不开时

按顺序检查，每一步都给出具体结论而不是笼统道歉：

1. `amadeus_status` 是否返回 daemon 信息。
2. `amadeus_capabilities` 里 `live2dModel.ok` 是否为 true；为 false 时面板会显示占位插画，这是**预期降级**而非故障。
3. 地址必须是 `http://127.0.0.1:<port>`；daemon 只监听回环，局域网地址会被拒绝。
4. token 只能用一次；再次打开请重新取地址。

## 边界

- 不要在 Codex 对话里复述面板内容。
- 不要尝试把面板嵌入 Codex 或修改 Codex 主题。
