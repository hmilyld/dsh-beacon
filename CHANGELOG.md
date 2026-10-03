# Changelog

本文件记录 dsh-beacon 的发布历史，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 变更

- npm 发布改用 **Trusted Publishing（OIDC）**，不再使用 `NPM_TOKEN` secret。
  原因：npm 正在淘汰 bypass-2FA 的 granular token，2026-07 起其已不能做账号/包管理，
  官方公告 2027-01 起连 direct publish 也会取消。

## [0.2.0] - 2026-10-03

### 变更

- 包名由 `dsh-beacon` 改为 **`@hmilyld/dsh-beacon`**：npm 上的 `dsh-beacon` 已被他人占用，
  改用带 scope 的名字才能发布。Loader 条目 id 与设置命名空间仍是 `dsh-beacon`，**已保存的配置不受影响**。
- 发版流程加入 npm 发布（GitHub Actions，`id-token: write`，provenance 自动生成）。

### 新增

- `peerDependencies` 声明 `@deepseek-ai/dsh-*`（`0.2.0-rc.2`），供插件管理器做版本兼容判定。
- `prepublishOnly`（typecheck + 冒烟测试）与 CI / Release 两个工作流。

## 0.1.0 - 2026-10-03

首个版本。**未发布到 npm**：包名随 0.2.0 改为 `@hmilyld/dsh-beacon`，原 tag 与 Release 已删除。

### 新增

- 四类事件通知：`task_completed`、`user_question`、`plan_confirmation`、`approval_request`。
- 每条事件都有权威路径（`agent/status`、`user-questions/request`、`approval/request`）
  与兜底路径（`turn/end`、`tool/call` → `tool/result`），按 `callId` 配对、由去重窗口合并成一次发送。
- `payloadTemplate` 变量替换：`{{eventType}}`、`{{summary}}`、`{{sessionId}}`、`{{time}}`，
  变量值做 JSON 字符串转义，渲染结果非法 JSON 时跳过并记错误日志。
- 六个 `volatile` 配置项，可在插件管理页或 profile patch 中配置，保存后热生效、无需重启。
- 客户端半边：插件管理页 `plugins.bundle.config` 插槽上的配置表单（暂存 + 保存 + 恢复默认）。
- fire-and-forget 发送：模板渲染、fetch、日志全部 `try/catch`，webhook 故障不影响 agent 主循环。
- 冒烟测试（76 项）与真实端点联调脚本（`npm run send-test`）。

[未发布]: https://github.com/hmilyld/dsh-beacon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/hmilyld/dsh-beacon/releases/tag/v0.2.0
