---
name: amadeus-memory
description: 读写、检索、删除 Amadeus 的长期记忆。当用户说「记住这件事」「你还记得」「忘掉这个」时使用。
---

# Amadeus 记忆

记忆分两个命名空间，**不要混用**：

| 命名空间 | 来源 | 用途 |
| --- | --- | --- |
| `panel` | 面板对话自动抽取 | 与红莉栖聊天时自然形成的长期事实 |
| `codex` | 模型通过 `amadeus_remember` 主动写入 | 与编码任务相关的用户偏好、决定、进行中的项目 |

## 写入

```
amadeus_remember({ text: "用户偏好把配置放在 %LOCALAPPDATA%", tags: ["preference"] })
```

- 只写**一周后仍然有意义**的内容：稳定偏好、身份信息、重要决定、进行中的项目。
- 不要写临时状态（今天在做什么）、寒暄、一次性命令输出。
- 一句话一条，不超过 500 字。

## 检索

```
amadeus_recall({ query: "配置目录", namespace: "codex", limit: 5 })
```

先检索再回答；找不到就说找不到，不要编造记忆内容。

## 删除

```
amadeus_forget({ query: "配置目录" })     // 按关键词
amadeus_forget({ id: "<memory id>" })     // 按 id
```

删除前先用 `amadeus_recall` 确认命中范围；需要清空整个命名空间时用 `amadeus_memory_clear`，并必须传 `confirm: true`。

## 隐私

- 记忆保存在用户自己的数据目录里，不上传任何地方。
- 用户要求导出时用 `amadeus_export`。
- 不要把记忆内容写进提交信息、issue、PR 或任何外部服务。
