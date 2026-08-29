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

## 重置

录制前使用 Git 恢复本演示目录到已提交状态。RepoForge 本身不会自动提交、推送或重置文件。
