# Order Pricing Demo

这是 RepoForge 视频演示专用的零依赖小项目。初始实现故意包含边界与输入校验缺陷，验收测试应当失败；它不是 RepoForge 主项目测试失败。

## 演示任务

> 修复 `calculateShippingFee`：普通会员订单满 99 元免邮，高级会员满 59 元免邮；`subtotal` 必须是非负有限数字，`membership` 只能是 `standard` 或 `premium`。不要修改或删除现有测试，运行测试并根据真实结果完成修复。

## 初始基线

在本目录执行：

```powershell
pnpm test
```

预期 6 项测试中 2 项通过、4 项失败。边界测试和参数校验测试用于让视频稳定展示“读取—运行—失败—修改—再运行”的 Agent 闭环。

项目同时包含 `.localforge/skills/test-first-demo.md`。用 RepoForge 打开本目录后，可选择 `Test-first demo verification`，让模型明确遵守“先取得失败基线、只修改实现、不得削弱测试、使用相同命令复验”的演示规范。Skill 不包含代码，也不会绕过权限和命令审批。

## 重置

录制前使用 Git 恢复本演示目录到已提交状态。RepoForge 本身不会自动提交、推送或重置文件。

恢复后先运行 `pnpm test`，只有结果严格为 2 pass / 4 fail 才开始录制。彩排建议复制本目录到临时位置，或在 RepoForge 的变更区使用“恢复全部”，不要把一次修复后的实现误当作下一轮故障基线。
