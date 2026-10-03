# AGENTS.md

本文件面向在本仓库工作的编码 agent 与维护者，记录架构、开发、测试与发版约定。
使用者文档见 [README.md](README.md)。

## 项目概览

`@hmilyld/dsh-beacon` 是 DSH（DeepSeek Harness）插件：监听 DSH 事件，向配置的 URL 推送 JSON webhook。

| 半边 | 入口 | 产物 | 职责 |
| --- | --- | --- | --- |
| 宿主 | `src/index.ts` | `lib/index.js`、`lib/index.d.ts` | 注册事件监听、渲染 payload、发送请求 |
| 客户端 | `src/client/index.tsx` | `lib/client.js` | 插件管理页上的配置表单 |

技术栈：TypeScript + `@deepseek-ai/cordis`（插件/服务）+ `@deepseek-ai/schemastery`（Config schema）
+ `@deepseek-ai/cosmokit`（`isVolatile`）。开发对照 DSH `0.2.0-rc.2` 的类型包。

## 关键标识符（改名或换 scope 时必须同步）

这块最容易改错，四个名字含义不同：

| 名称 | 当前值 | 定义位置 | 说明 |
| --- | --- | --- | --- |
| 包名 | `@hmilyld/dsh-beacon` | `package.json` `name` | ModuleLoader id、`plugins.bundle.config` 的 key、Loader 解析用的 specifier |
| Loader 条目 id / 设置命名空间 | `dsh-beacon` | `cordis.patch.yml` 的 `id:` | `dsh-settings` 用 `ns: entry.options.id` 建命名空间。**不要跟着包名改**，否则用户已保存的配置会失联 |
| 客户端 `ENTRY_ID` | `dsh-beacon` | `src/client/index.tsx` | 必须等于 Loader 条目 id（`configForms.get` / `whileServed` 的键） |
| 客户端 `BUNDLE_KEY` | `@hmilyld/dsh-beacon` | `src/client/index.tsx` | 插件管理页用 `ledger.bundles.has(pkg.name)` 匹配，所以必须是**包名** |
| 宿主 `export const name` | `dsh-beacon` | `src/index.ts` | cordis 的短插件名，官方惯例（如 `dsh-tool-ask-user` 用 `tool-ask-user`），与包名无关 |

换 scope 的完整清单：`package.json` 的 `name`、`cordis.patch.yml` 的 `name:`、客户端 `BUNDLE_KEY`、
`src/client/index.tsx` 顶部注释里的例子。冒烟测试会校验「包名 == patch 的 name」与
「patch 的 id 仍是 `dsh-beacon`」，改漏了会红。

## 目录结构

```
src/index.ts                     宿主插件：volatile Config schema、render/sendWebhook、全部触发监听
src/client/index.tsx             客户端配置表单（plugins.bundle.config 插槽）
scripts/build-client.mjs         esbuild 打包客户端 → lib/client.js（ModuleLoader 包装）
scripts/smoke-test.mjs           冒烟测试（npm test）
scripts/send-test.mjs            真实端点联调（npm run send-test）
scripts/send-test.config.json    联调配置，git-ignored，含真实地址/密钥
cordis.patch.yml                 bundle 层：安装时向 profile 插入插件行（id=dsh-beacon, name=包名）
examples/profile.cordis.patch.yml        配置示例（profile 层按 id 覆盖）
examples/send-test.config.example.json   联调配置示例
.github/workflows/ci.yml         CI：typecheck + 冒烟测试
.github/workflows/release.yml    发版：校验标签 → 测试 → OIDC 发布 → GitHub Release
README.md                        使用者文档（安装 / 配置 / 常见问题）
AGENTS.md                        本文件：架构、开发、测试、发版约定
CHANGELOG.md                     版本历史，发版前更新
LICENSE                          MIT
tsconfig.json                    NodeNext / strict / 宿主输出 lib
tsconfig.client.json             Bundler / react-jsx / noEmit，客户端类型检查
lib/                             构建产物，git-ignored
```

## 架构

### 触发路径

每类事件都有「权威路径」和「兜底路径」，靠去重窗口合并成一次发送：

| `eventType` | 权威路径 | 兜底路径 |
| --- | --- | --- |
| `task_completed` | `agent/status` → `idle` | `session/event` → `turn/end`（延迟 1s，期间出现权威信号即让位） |
| `user_question` | `user-questions/request`（waterfall） | `tool/call` `ask_user_question`（延迟 500ms）→ `tool/result` |
| `plan_confirmation` | `user-questions/request`（`intent.kind === 'plan-review'`） | `tool/call` `exit_plan_mode` → `tool/result` |
| `approval_request` | `approval/request`（waterfall） | —（只有这一条路径） |

约束与要点：

- 两条 waterfall 监听器必须**同步 `return next()`**，只旁路通知、不得打断 DSH 的应答链。
  发送逻辑整体包在 `try/catch` 里，异常只记日志。
- 兜底路径按 `callId` 配对 `tool/call` / `tool/result`；权威路径一旦覆盖该 `callId`
  就取消兜底定时器（`coverCall`），迟到的 `tool/result` 不再补发。
- `triggerOnUserQuestion` 只过滤 `user_question`：判断 `plan-review` 要**先于**该开关，
  否则计划确认会被误拦（曾出现过的 bug，冒烟测试有回归用例）。
- `skipSubagents` 只作用于完成通知与工具兜底；审批与提问的权威路径不过滤——它们在等真人拍板。

### 状态与内存

宿主闭包内维护这几张表，都有上界：

| 结构 | 键 | 上界 |
| --- | --- | --- |
| `statuses` | agent id | 随 `agent/disposed` 清理 |
| `lastAssistant` | session id | 随 `agent/disposed` 清理 |
| `recent`（去重） | `sessionId\|eventType` | 超过 1024 条时清理过期项 |
| `pendingCalls` | `callId` | 2048，超出淘汰最旧 |
| `notified` | `callId` | 2048，超出淘汰最旧 |
| `timers` / `fallbackTimers` | — | `ctx.effect` 卸载时全部 `clearTimeout` |

### 客户端半边

- 宿主 `Config` 六个字段全部 `volatile()`：`dsh-settings` 因此把它们收进设置镜像，
  客户端由此拿到 schema；Loader 走热写路径，保存不重启插件。**运行时必须每次 `.get()` 读**，
  不能在 `apply` 时缓存。
- 注册链：`configForms.whileServed([ENTRY_ID], () => slots.inject('plugins.bundle.config', () => slots.register({ name, key: BUNDLE_KEY, inject: () => controller.face() }, BeaconCard)))`。
  宿主没提供该命名空间时页面上不留痕迹。
- 表单模型与宿主 fiber 同生命周期：`ctx.effect(() => () => controller.dispose())`；
  `form.bind()` 只调一次并复用（反复 bind 会在同一个 form 上叠加订阅）。
- 服务类型是**手写的结构化子集**，不 import 官方客户端包：`@deepseek-ai/dsh-api-remotes`
  没有与 `0.2.0-rc.2` 同步的发布版本，`dsh-client-ui-settings` 的类型链会断。
- 字段控件：`webhookUrl` / `dedupWindowMs` 用官方 `SettingsValueField`；
  `payloadTemplate` / `headers` 用自写的 `TextareaField`（官方控件只有单行 input）；
  两个布尔值用 `Switch` + 自写 `ToggleField`。内联样式抄自 primitives 的 `fields.module.css`，
  因为 CSS module 类名在各 bundle 里是哈希过的，跨包拿不到。

## 开发

```bash
npm install --legacy-peer-deps   # dsh rc 系列包之间有 peer 冲突，需要这个旗标
npm run typecheck                # tsc --noEmit（宿主）+ tsc -p tsconfig.client.json（客户端）
npm test                         # build + 冒烟测试
npm run build                    # tsc → lib/ + esbuild → lib/client.js
npm run send-test                # 可选：向真实端点发四类事件
```

- 本机调试用 `dsh plugin --profile <name> add /path/to/dsh-beacon`（pnpm `link:` 符号链接）。
  改完宿主代码后重启一次 DSH；客户端 bundle 改动同样以重启为最可靠。
- 客户端产物必须是 `window.__ModuleLoader__.load({ id: <包名>, factory })` 包装，
  `@deepseek-ai/*` 与 react 全部 external（跨插件只能通过 cordis 服务协作）。

### 测试

`scripts/smoke-test.mjs` 用假 ctx 加载编译产物 + 本地 HTTP server，覆盖：
各触发路径、去重、waterfall `next()` 透传、兜底取消、子代理过滤、`triggerOnUserQuestion` 只拦提问、
schema 默认值与时间格式、summary 截断、非法模板跳过、非 2xx 告警、空 URL 不发送、全字段 volatile、
模拟 `_commitVolatile` 热更新、客户端 bundle 的 ModuleLoader 包装与导出、卸载清理，
以及发版元数据（peer 依赖 / repository / files / LICENSE / patch 与 manifest 一致性）。

> 断言数量随功能增长，**不要在其他文档里写死数字**（曾因写死「56 项」而过期）。

`scripts/send-test.mjs` 的结构是「插件 → 本地代理（记录 + 原样转发）→ 真实接口」，
依次发送四类事件、打印上游返回，以「上游全部 2xx」判定成功。需要一份 git-ignored 配置：

```bash
cp examples/send-test.config.example.json scripts/send-test.config.json
# 填好 targetUrl 后：
npm run send-test
```

`targetUrl` 必填（也可用环境变量 `DSH_BEACON_TEST_URL`）；`payloadTemplate` 省略时用内置默认模板。

## 发版

### 版本与兼容性

- `package.json` 的 `peerDependencies` 声明 `@deepseek-ai/dsh-*`（当前 `0.2.0-rc.2`）。
  DSH 插件管理器**只认这个字段**做版本兼容判定（`evaluatePluginCompatibility` 只看
  `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`），DSH 版本变更时必须同步上调。
- npm 包名 `@hmilyld/dsh-beacon`；`dsh-beacon`（不带 scope）已被他人占用，不要尝试改回去。

### 流程

```bash
# 1. 更新 CHANGELOG.md
# 2. 升版本（会自动改 package.json + package-lock.json 并打 tag）
npm version patch        # 或 minor / major
# 3. 推送提交与标签，触发 release.yml
git push --follow-tags
```

`release.yml` 依次：校验「标签 == package.json 版本」→ `npm install --legacy-peer-deps`
→ typecheck → 冒烟测试 → **OIDC 发布到 npm** → `npm pack` → 创建 GitHub Release 并把 `.tgz` 作为附件。

### npm 发布：Trusted Publishing（OIDC）

CI 里**不使用任何 token**，靠 OIDC 换取短期凭据，provenance 自动生成。

一次性配置（`npm trust` 比网页可靠，网页入口[出了名的难找](https://github.com/npm/cli/issues/8910)）：

```bash
npm trust github @hmilyld/dsh-beacon \
  --file release.yml --repo hmilyld/dsh-beacon \
  --registry=https://registry.npmjs.org/ --yes
npm trust list @hmilyld/dsh-beacon --registry=https://registry.npmjs.org/   # 核对
```

- `--file` 只填文件名（`release.yml`），不能带 `.github/workflows/` 前缀；
- `--repo` 是 `owner/repo`；
- **不要加 `--env`**（workflow 里没有 environment，填了反而不匹配）；
- 两条命令都需要浏览器 2FA 授权，只能人工在本机执行。

**首次发布必须人工 bootstrap**：Trusted Publisher 的设置入口只存在于已发布的包上，
所以新包要先本地带 2FA 发一次，再配 OIDC。注意 npm 当前（2026）的 2FA 行为：

- `npm login` 给的是 **2 小时 session token**，期间发布仍强制 2FA；
- 但 registry 对未带 OTP 的发布会返回 **403**（而非 `EOTP`），npm CLI 的 `otplease`
  只在 `EOTP`/`E401` 时弹提示，于是表现为「没让你输 OTP 就直接 403」
  （[npm/cli#9268](https://github.com/npm/cli/issues/9268)）。此时用
  `npm publish --registry=https://registry.npmjs.org/ --access public --otp=<动态码>`。

**npm token 的演进**（决定我们为什么不再用 token）：

- 2025-11-19：classic token 永久吊销；
- 2026-07-31：bypass-2FA 的 granular token 不能再做账号/包管理；
- 2027-01（官方计划）：连 direct publish 也会取消，只保留「读私有包 + 暂存发布」。

### 本机 registry 是镜像时

`~/.npmrc` 里的 `registry=https://registry.npmmirror.com` 只适合**安装**——它是只读镜像，
没有登录/发布端点。本机登录或发布必须显式指向官方源：

```bash
npm login --registry=https://registry.npmjs.org/
npm publish --registry=https://registry.npmjs.org/ --access public
```

同样注意**不要让它污染 lockfile**：`package-lock.json` 的 `resolved` 必须都是
`https://registry.npmjs.org/...`。重新生成时要在干净目录里做，否则 npm 会复用
`node_modules/.package-lock.json` 里的镜像地址：

```bash
mkdir -p .lockgen && cp package.json .lockgen/ && cd .lockgen
npm install --package-lock-only --legacy-peer-deps --registry=https://registry.npmjs.org/
cp package-lock.json ../
```

（本机仍走镜像不受影响：npm 的 `replace-registry-host` 默认会把规范的 npmjs 地址换成配置的镜像。）

## 踩坑记录

- **`npm view` 会骗人**：它读的是 CDN 缓存的 packument，刚发布的版本可能几分钟内查不到，
  甚至出现「版本端点 404 但 tarball 200」的矛盾。要立刻确认真实状态，绕过缓存：

  ```bash
  curl -sS -H "Cache-Control: no-cache" "https://registry.npmjs.org/@hmilyld%2Fdsh-beacon?t=$(date +%s)"
  ```

- **OIDC 失败的定位顺序**：先看 workflow 里 `Print environment` 步骤打的
  `ACTIONS_ID_TOKEN_REQUEST_URL` 是否 present（缺 → 权限问题，检查 `id-token: write`）；
  再在 `NPM_CONFIG_LOGLEVEL: verbose` 的日志里找 `oidc` 行。
  交换接口返回 `404 package not found` 表示 **npm 侧没有匹配的 Trusted Publisher**；
  用假 token 探测同一接口会得到 `401 unauthorized`，可用来排除「接口/转义」问题。
- **DSH 桌面版**：`desktop` profile 由 Electron 独占，npm 版 CLI 会拒绝
  （`dsh plugin --profile desktop ...` 报错），必须在应用内的插件管理页操作。
- **宿主 `inject` 不要写 `'logger'`**：`ctx.logger` 是 cordis 在根 Context 构造器里装好的内置属性，
  从未 `provide`，写了会让整条 entry 永远 pending，设置镜像里也就看不到这个插件。
- **仓库里的敏感信息**：`scripts/send-test.config.json`（真实 URL + token）已在 `.gitignore` 中，
  提交前确认它没被带进去。
