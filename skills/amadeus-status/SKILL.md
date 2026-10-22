---
name: amadeus-status
description: 检查 Amadeus 的运行状态、能力可用性与降级原因，用于排障。当用户说「Amadeus 怎么了」「为什么没反应」「自检」时使用。
---

# Amadeus 自检

## 快速检查

```
amadeus_status()
amadeus_capabilities()
```

返回的是**脱敏**摘要：不会有任何 API key 或 token。

## 素材与调度状态

```
amadeus_assets_status()     // 模型 / Cubism 2 运行时是否装好、哈希是否匹配
amadeus_assets_install()    // 缺失时安装或修复（只从注册表登记的来源下载并校验 SHA-256）
amadeus_proactive()         // 主动交互开关、距上次互动多久、现在有几个面板连着
```

面板显示占位插画、或"她一直不主动说话"时，先用这三个确认，而不是猜。

## 需要更细的结论时

```powershell
node bin/amadeus.mjs doctor --deep
```

深层自检会真实合成一句测试音频，因此能区分「网络不可达」与「音色参数问题」。

## 结果怎么读

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `codexCli.ok = false` | 找不到 Codex CLI | 对话通道不可用；可改配置用独立 API key |
| `live2dModel.ok = false` | 模型未安装 | **预期降级**，面板显示占位插画；按需下载即可 |
| `edgeTts.ok = false` | 合成失败 | 报告具体 reason，不要假装正常 |
| `checks.secrets.*.configured = false` | 未配置相应密钥 | 只有可选能力需要密钥，主链路不需要 |
| 有 `degrade` 数组 | 存在降级项 | 逐条说明 capability / reason / 建议动作 |

## 报告原则

报出具体失败点与可行的下一步。不要说「可能网络问题」这种无法验证的结论——自检里已经有明确的 reason 字段。
