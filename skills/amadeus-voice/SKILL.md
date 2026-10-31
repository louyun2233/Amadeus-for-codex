---
name: amadeus-voice
description: 让 Amadeus 用日语说话、检查语音通道、处理没有声音的问题。当用户要求「让她说话」「语音」「朗读」「没声音」时使用。
---

# Amadeus 语音

## 让她说话

使用 `amadeus_say`，参数是**日语**文本：

```
amadeus_say({ text: "おはよう。今日も頑張りましょう。", emotion: "happy" })
```

要点：

- 默认需要预先授权。若返回 `code: "needs_confirmation"`，如实告诉用户需要在面板设置里打开「允许 Codex 发声」，不要重试。
- 语音通过原生 Windows 面板播放。检查面板连接、语音开关及所选合成服务；原生面板没有浏览器自动播放授权步骤。
- emotion 只能取：`happy excited elated sad angry furious question soft blush annoyed thinking surprised disappointed eyes_closed indifferent side winking neutral`。

## 让她主动打过来

```
amadeus_call({ reason: "用户半小时前说想被提醒" })
```

和 `amadeus_say` 一样默认需要预先授权（面板设置里的「允许 Codex 来电」）。
来电会显示 CONNECT 接听按钮；底部圆键用于拒接，铃声由本机独立提示音提供。

## 没声音时

依次确认，并报告具体是哪一步失败：

1. `amadeus_status` 查看语音 provider 与缓存状态，`amadeus_capabilities` 查看能力诊断。
2. 深层自检会真实合成一句 `テスト`，能直接区分「网络不通」和「音色/参数问题」。
3. 原生面板是否连接、语音是否启用、Windows 音量与输出设备是否可用。

## 设计约束

- 声线必须稳定：**不要**为了情绪切换音色或音高基准，情绪只通过 prosody（音调/音量）表达。
- 不要静默降级到浏览器语音；失败就明确报告。
