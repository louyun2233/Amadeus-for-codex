# 随仓库分发的第三方运行时

这两个文件是 MIT 许可，随仓库分发，用于在面板里渲染 Live2D。

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `pixi-7.4.2.min.js` | https://cdn.jsdelivr.net/npm/pixi.js@7.4.2/dist/pixi.min.js | MIT（`LICENSE.pixi.txt`） |
| `pixi-live2d-display-0.4.0-cubism2.min.js` | https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism2.min.js | MIT（`LICENSE.pixi-live2d-display.txt`） |

哈希（供人工核对，变更需同步更新 `config/assets.registry.json`）：

```
pixi-7.4.2.min.js                          9DDBA9CD78BC8610A1D445EC939393888BE83925C78E40D66D9A17E98450228D
pixi-live2d-display-0.4.0-cubism2.min.js   0E86A36540FB487D463904FC5E295316A3130DFC8AC345F37F29B34BED48BBA3
```

**不在此目录**：`live2d.min.js`（Live2D Cubism 2 运行时）。它不属于 MIT，也非本项目所有，
因此不随仓库或发行物分发：由 `core/assets` 在用户机器上按需下载到本地缓存，或由用户自备。
