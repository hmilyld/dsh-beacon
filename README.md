# dsh-beacon（DSH 信标）

DSH（DeepSeek Harness）Web 插件：当**任务完成**，或 Agent 需要用户**选择 / 确认 / 审批**时，向预设 URL 发送一次带变量替换的 JSON POST webhook。

- 技术栈：TypeScript + `@deepseek-ai/cordis`（插件/服务）+ `@deepseek-ai/schemastery`（Config schema）+ `@deepseek-ai/cosmokit`（`isVolatile` 判定）（对照 DSH `0.2.0-rc.2` 类型包开发）。
- 所有发送均为 fire-and-forget：模板渲染、fetch、日志全部 `try/catch` 包裹，**webhook 故障绝不影响 agent 主循环**。
- 未配置 `webhookUrl` 时不发送任何请求（监听仍注册，填上地址**热保存即生效**）。
- 配置既可在 **profile 的 YAML** 里写，也可在 **DSH 界面**里改（插件管理页 → `@hmilyld/dsh-beacon` 详情），见下文「配置」。

## 触发的事件

| `{{eventType}}` | 触发时机 | 主路径 | 兜底路径 |
| --- | --- | --- | --- |
| `task_completed` | 一轮任务完成、agent 归空 | `agent/status` → `idle` | `session/event` → `turn/end`（延迟 1s，出现权威信号即让位） |
| `user_question` | Agent 提问等待用户选择/回答 | `user-questions/request`（waterfall） | `tool/call` `ask_user_question`（延迟 500ms）→ `tool/result` |
| `plan_confirmation` | 计划提交待确认（`exit_plan_mode` / plan-review 意图） | `user-questions/request`（`intent.kind === 'plan-review'`） | `tool/call` `exit_plan_mode` → `tool/result` |
| `approval_request` | 工具需要审批 | `approval/request`（waterfall） | —（审批只此一条权威路径） |

说明：

- 两条 waterfall 监听器都**同步 `return next()`**，只旁路通知、不打断 DSH 的应答链。
- 兜底路径按 `callId` 配对 `tool/call` / `tool/result`，并被主路径随时接管（取消定时器），不会双发。
- 幂等去重：`sessionId|eventType` 在 `dedupWindowMs` 窗口内只发一次，主路径与兜底靠它合并。
- 子代理（`session.header.origin === 'subagent'`）默认不发完成通知与工具兜底通知（`skipSubagents`）；**审批与提问的权威路径不过滤**——它们在等真人拍板。

## 安装

npm 包名为 **`@hmilyld/dsh-beacon`**；仓库名为 `hmilyld/dsh-beacon`（两者不同，见下）。

```bash
# npm 安装（推荐，可带版本号）
dsh plugin --profile <name> add @hmilyld/dsh-beacon

# GitHub 安装（prepare 脚本自动执行 tsc + esbuild 构建 lib/）
dsh plugin --profile <name> add github:hmilyld/dsh-beacon

# 锁到某个发布标签
dsh plugin --profile <name> add github:hmilyld/dsh-beacon#v0.2.0

# 本地 checkout（pnpm link: 符号链接，需先自行 npm install + npm run build）
dsh plugin --profile <name> add /path/to/dsh-beacon
```

> pnpm 默认拦下安装脚本（本包的 `prepare` 与 esbuild 的安装脚本）。首次安装若被拦，
> 按 pnpm 提示把包名加入 `profiles/<name>/pnpm-workspace.yaml` 的 `allowBuilds` 后重试；
> 在桌面版插件管理页里则是点「允许这些脚本并重试」。
> 从 npm 装的是已构建好的包，不触发 `prepare`。

安装会把本包的 bundle 层（`cordis.patch.yml`）加入 profile。验证组合结果：

```bash
dsh --profile <name> --dump-config   # 应能看到 "# == @hmilyld/dsh-beacon" 层
```

> 包名与 Loader 条目 id 是两个东西：包名是 `@hmilyld/dsh-beacon`，而 `cordis.patch.yml`
> 里的条目 `id`（= 设置命名空间）固定为 `dsh-beacon`。所以 profile 里按 id 覆盖配置、
> 以及界面上已保存的配置，都不会因为包名带 scope 而失效。

### 在 DSH 桌面版里安装

桌面版的 `desktop` profile 由 Electron 独占，npm 版 CLI 会拒绝管理它
（`dsh plugin --profile desktop ...` 报 `profile "desktop" is managed exclusively by the Electron application`），
请改用应用内的**插件管理页 → 添加插件**。该页面支持四种来源，按推荐程度：

| 来源 | 填法 | 说明 |
| --- | --- | --- |
| npm 包名 | `@hmilyld/dsh-beacon` | 最省事，走 npm 源（可切国内镜像）；装的是已构建产物 |
| GitHub 仓库地址 | `github:hmilyld/dsh-beacon` | 需要那台机器能直连 github.com 或配好代理，装完按提示允许安装脚本 |
| 压缩包 | `npm pack` 产出的 `hmilyld-dsh-beacon-<版本>.tgz` 的**绝对路径** | 包内已带 `lib/`，不触发构建脚本；适合离线或网络受限的机器 |
| 本地目录 | 解压/克隆后的目录**绝对路径** | 该目录需自带 `lib/` 且运行时依赖可解析（目录里保留 `node_modules`，或先 `npm install --legacy-peer-deps`） |

安装/升级后按页面提示重启（「更改将在下次启动生效」），再到插件详情里填 `webhookUrl`。

> npm 上的 `dsh-beacon`（不带 scope）已被他人占用，所以本项目发布在 `@hmilyld/dsh-beacon`。
> 该 scope 必须与你的 npm 账号或组织一致；若 npm 用户名不是 `hmilyld`，需要把
> `package.json` 的 `name`、`cordis.patch.yml` 的 `name:` 与客户端 `BUNDLE_KEY` 三处一起改成你的 scope。

## 配置

### 方式一：界面上配置（推荐）

打开 DSH 的**插件管理页** → 找到 `@hmilyld/dsh-beacon` → 点开详情，即可编辑六个配置项并保存。

- 表单由插件自带的客户端半边（`src/client/index.tsx` → `lib/client.js`）渲染，挂在官方的 `plugins.bundle.config` 插槽上，位于 bundle 描述与 rows 之间。
- 编辑先暂存，**点「保存」才写回**；离开页面自动丢弃未保存的改动。字段旁的「已覆盖默认值 / 恢复默认」标出哪些值是自己改过的。
- 配置项全部声明为 `volatile`：保存后 Loader 走热写路径，**不重启插件、不重挂监听**，下一次触发立即读到新值（包括补填此前留空的 `webhookUrl`）。
- 只有改动 `package.json` 的 `dsh.client` 声明（新增依赖服务）才需要重启 DSH。

### 方式二：profile 的 patch 文件

在 profile 的 patch 文件中按 id 覆盖插件行：

```
$DSH_HOME/profiles/<name>/cordis.patch.yml     # $DSH_HOME 默认 ~/.dsh
```

最小配置（其余字段回落到 schema 默认值）：

```yaml
- id: dsh-beacon
  config:
    webhookUrl: 'https://example.com/api/dsh-beacon'
```

全部字段的完整示例见 [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml)：

```yaml
- id: dsh-beacon
  config:
    webhookUrl: 'https://example.com/api/dsh-beacon'
    payloadTemplate: '{"event": "{{eventType}}", "success": true, "msg": "{{summary}}", "sessionId": "{{sessionId}}", "time": "{{time}}"}'
    headers:
      Content-Type: application/json
    triggerOnUserQuestion: true
    dedupWindowMs: 5000
    skipSubagents: true
```

> ⚠️ 官方 patch 语义是**按 id 覆盖整行 config**（没有深合并层）。省略的字段会回落到插件 schema 的默认值，所以只写 `webhookUrl` 即可工作；但改配置时不要假设未写的字段还保留 bundle 层的值。
>
> `webhookUrl` 属于私密地址（等同密钥），勿提交进公开仓库；含密钥时可用官方 `!!js` 表达式从环境变量读取（示例文件末尾）。YAML 改动**保存后即热生效**，无需重启 DSH（若偏好重启，`dsh --profile <name> --dump-config` 可检查组合结果，应能看到 `# == @hmilyld/dsh-beacon` 层）。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `webhookUrl` | string | **必填字段**（bundle 层预置空串） | 接收 webhook 的 URL（POST）。空串 → 不发送任何请求（监听仍注册，之后填上也生效） |
| `payloadTemplate` | string | 内置默认模板 | JSON 模板；渲染结果必须是合法 JSON，否则跳过该次发送并记错误日志 |
| `headers` | object | `{'Content-Type': 'application/json'}` | 附带的 HTTP 请求头（界面上以 JSON 文本编辑） |
| `triggerOnUserQuestion` | boolean | `true` | **只**控制 `user_question` 是否发送；计划确认与审批不受此开关影响 |
| `dedupWindowMs` | number | `5000` | 幂等去重窗口（毫秒） |
| `skipSubagents` | boolean | `true` | 是否跳过子代理的完成与工具兜底通知；审批与提问的权威路径始终发送 |

六个字段的 schema 元数据里都带 `volatile: true`——这是它们能进设置页、且改动可热写不重启的前提。

### 模板变量

| 变量 | 含义 |
| --- | --- |
| `{{eventType}}` | `task_completed` / `user_question` / `plan_confirmation` / `approval_request` |
| `{{summary}}` | 事件摘要（任务完成 = 最后一条 assistant 文本；提问 = 问题与选项；审批 = 工具名与原因），统一截断至 200 字符 |
| `{{sessionId}}` | 会话 id |
| `{{time}}` | 发送时刻（`YYYY-MM-DD HH:mm:ss`，本机时区，无 T/时区后缀） |

变量值做了 JSON 字符串转义，可安全嵌入模板的任意字符串位置；未知变量原样保留。

### 发送行为

- `fetch` POST，超时 10 秒（`AbortSignal.timeout`），响应体被消费后释放连接。
- HTTP 非 2xx 记 `warn` 日志；网络失败记 `warn`；模板非法 JSON 记 `error` 并跳过——三种情况都**不影响 agent 运行**。
- 成功发送记 `debug` 日志（默认级别下不可见，调低日志级别可看到每次发送内容）。

### 去重与状态跟踪

- 去重表按 `sessionId|eventType` 记最后一次发送时刻；条目超过 1024 条时清理已过期项。
- 按 `callId` 跟踪的两个集合（待配对调用 / 已覆盖调用）上限 2048 条，超出时淘汰最旧一条，保证长期运行内存有界。
- 主路径覆盖某个 `callId` 后，该调用迟到的 `tool/result`（可能间隔数分钟，早已超出去重窗口）不再补发。
- 所有延迟定时器（`turn/end` 1s、工具兜底 500ms）在插件卸载时统一清理，卸载后不会再触发发送。

## 开发

```bash
npm install --legacy-peer-deps   # dsh rc 系列包存在 peer 冲突，需加该旗标
npm run typecheck                # tsc --noEmit（宿主）+ tsc -p tsconfig.client.json（客户端）
npm test                         # build + 冒烟测试
npm run send-test                # 可选：向真实端点发四类事件（见下）
```

`npm run build` = `tsc`（宿主 → `lib/`）+ `npm run build:client`（esbuild 打包浏览器半边 → `lib/client.js`）。
改代码后重启一次 DSH 即可（pnpm `link:` 符号链接，无需重装）。

冒烟测试（`scripts/smoke-test.mjs`，76 项）用假 ctx 加载编译产物，配合本地 HTTP server 验证：各触发路径、去重、waterfall `next()` 透传、兜底取消、子代理过滤、`triggerOnUserQuestion` 只拦提问、schema 默认值与时间格式、summary 截断、非法模板跳过、非 2xx 告警、空 URL 不发送、全字段 volatile、模拟 `_commitVolatile` 的热更新、客户端 bundle 的 ModuleLoader 包装与导出、卸载清理，以及发版元数据（peer 依赖 / repository / files / LICENSE）。

真实端点联调（`scripts/send-test.mjs`）的结构是「插件 → 本地代理（记录 + 原样转发）→ 真实接口」，
依次发送四类事件、打印上游返回，并以「上游全部 2xx」判定成功。它需要一份 git-ignored 的配置：

```bash
cp examples/send-test.config.example.json scripts/send-test.config.json
# 改好 targetUrl 后：
npm run send-test
```

- `targetUrl`：必填，真实接收端；也可用环境变量 `DSH_BEACON_TEST_URL` 代替。
- `payloadTemplate`：可选，省略时用插件内置的默认模板（`DEFAULT_PAYLOAD_TEMPLATE`）。

## 发版

`package.json` 里声明了针对 `@deepseek-ai/dsh-*` 的 `peerDependencies`（当前 `0.2.0-rc.2`）——
插件管理器只认这个字段做 DSH 版本兼容判定，DSH 大版本变更时应同步上调。

发一个版本：

```bash
# 1. 更新 CHANGELOG.md 与版本号（npm version 会自动打 tag）
npm version patch   # 或 minor / major

# 2. 推送提交与标签，触发 .github/workflows/release.yml
git push --follow-tags
```

标签推送后，`release.yml` 会校验「标签 == package.json 版本」，跑 typecheck 与冒烟测试，然后：

1. **发布到 npm**（`npm publish --access public --provenance`，带构建来源证明）；
2. `npm pack` 出带预构建 `lib/` 的 `.tgz`，创建 GitHub Release 并把它作为附件。

用户随后可以：

```bash
dsh plugin --profile <name> add @hmilyld/dsh-beacon           # npm
dsh plugin --profile <name> add github:hmilyld/dsh-beacon#v0.2.0
```

或在桌面版插件管理页填包名 / GitHub 地址 / Release 附件的 `.tgz` 绝对路径。

### npm 发布的一次性配置

发布需要仓库 secret `NPM_TOKEN`（npm automation token，勾选 publish 权限）：

```bash
# 在 https://www.npmjs.com/settings/<你的用户名>/tokens 生成 Automation token
gh secret set NPM_TOKEN --repo hmilyld/dsh-beacon
```

- 未配置该 secret 时，工作流会**跳过 npm 发布**并打一条 notice，GitHub Release 照常创建；
  配好之后在 Actions 里 **Re-run** 该次运行即可补发。
- scope `@hmilyld` 必须属于你的 npm 账号或组织，否则发布会 403；npm 用户名不同的话，
  按「安装」一节的说明改三处名字。
- 首次发布带 scope 的包需要 `--access public`（已通过 `publishConfig` + 命令行显式给出）。

CI 见 `.github/workflows/ci.yml`（main 推送与 PR 上跑 typecheck + 冒烟测试）。

## 许可

[MIT](LICENSE) © 2026 hmilyld。

## 目录结构

```
src/index.ts                     宿主插件（volatile Config schema、sendWebhook、全部触发监听）
src/client/index.tsx             客户端配置页（插件管理页 bundle 详情里的表单）
scripts/build-client.mjs         esbuild 打包客户端 → lib/client.js（ModuleLoader 包装）
scripts/smoke-test.mjs           冒烟测试（npm test）
scripts/send-test.mjs            真实端点联调（npm run send-test）
scripts/send-test.config.json    联调配置（git-ignored，需自建）
cordis.patch.yml                 bundle 层：安装时向 profile 插入插件行
examples/profile.cordis.patch.yml 配置示例（profile 层按 id 覆盖）
examples/send-test.config.example.json 联调配置示例
.github/workflows/ci.yml         CI：typecheck + 冒烟测试
.github/workflows/release.yml    发版：校验标签 → 打包 → GitHub Release
CHANGELOG.md                     版本历史
LICENSE                          MIT
tsconfig.json                    NodeNext / strict / 宿主输出 lib
tsconfig.client.json             Bundler / react-jsx / noEmit，客户端类型检查
lib/                             构建产物：index.js / index.d.ts（tsc）+ client.js（esbuild）
```

> `lib/` 是 `npm run build` 的产物，已 git-ignore；打包/发布时由 `package.json` 的 `files` 字段带上 `lib` 与 `cordis.patch.yml`。
