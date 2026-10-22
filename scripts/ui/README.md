# UI 回归验证

面板的复杂度已经超过"看一眼就对"的程度，所以截图与渲染检查也进了仓库，而不是留在临时目录。

```bash
npm install                 # 只为 playwright-core（不下载浏览器）
node bin/amadeus.mjs start  # 需要先装好素材：node bin/amadeus.mjs assets install
npm run verify:ui
```

脚本用系统已安装的 Edge / Chrome 无头运行，检查：

1. 面板加载无脚本错误、无异常 console 输出
2. Live2D 运行时真的起来了，且可见的是 Live2D 画布而不是占位画布
3. 画布后备尺寸与容器一致（缩放不改比例、不拉伸）
4. 窗口尺寸变化后画布跟随容器（这是之前的真实缺陷）
5. 页面上抛出的错误会经由 `/amadeus/report` 进入 daemon 的日志
6. 输出截图到 `docs/screenshots/`

可用 `AMADEUS_BROWSER` 指定浏览器可执行文件路径。

## 双窗口验收（`npm run verify:tabs`）

默认启动一套使用临时数据的 daemon，再开两个隔离浏览器上下文中的真实页面（模拟双窗口）；模型回复和语音均由测试替身生成，不会使用现有会话、密钥或在线服务。校验：

1. 两个标签拿到不同的 client id
2. daemon 看到两个客户端,且**只有一个**语音归属者
3. 一句语音只让归属者去取音频（两个都取 = 双声道重音,就是修复前的症状）
4. 切换焦点后归属权转移,新归属者播放、旧的不出声
5. 跨窗口会话同步与取消回复
6. 状态播报语义、输入框名称与键盘焦点提示

需要验证已安装、正在运行的 daemon 时，才执行旧版现场脚本：

```powershell
npm run verify:tabs:live
$env:AMADEUS_TWO_TAB_CHAT = '1'; npm run verify:tabs:live
```

现场脚本会请求真实语音；第二行还会消耗一次真实模型调用。日常回归优先用隔离版。
