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

- 默认需要预先授权。若返回 `code: "needs_confirmation"`，如实告诉用户需要在面板设置里打开「允许模型主动发声」，不要重试。
- 语音只在面板打开且浏览器允许播放时出声。第一次播放可能被浏览器的自动播放策略拦截，面板会提示点击启用。
- emotion 只能取：`happy excited elated sad angry furious question soft blush annoyed thinking surprised disappointed eyes_closed indifferent side winking neutral`。

## 让她主动打过来

```
amadeus_call({ reason: "用户半小时前说想被提醒" })
```

和 `amadeus_say` 一样默认需要预先授权（面板设置里的「允许模型触发来电」）。
区别是它会拉起来电浮层，铃声与接听/拒接按钮都会出现。

## 没声音时

依次确认，并报告具体是哪一步失败：

1. `amadeus_capabilities` → 语音 provider 与缓存状态。
2. 深层自检会真实合成一句 `テスト`，能直接区分「网络不通」和「音色/参数问题」。
3. 面板是否打开、是否处于静音、浏览器是否拦截自动播放。

## 设计约束

- 声线必须稳定：**不要**为了情绪切换音色或音高基准，情绪只通过 prosody（音调/音量）表达。
- 不要静默降级到浏览器语音；失败就明确报告。
