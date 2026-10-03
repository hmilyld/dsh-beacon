# dsh-beacon

[![npm](https://img.shields.io/npm/v/@hmilyld%2Fdsh-beacon?label=npm&color=blue)](https://www.npmjs.com/package/@hmilyld/dsh-beacon)
[![license](https://img.shields.io/npm/l/@hmilyld%2Fdsh-beacon)](LICENSE)
[![CI](https://github.com/hmilyld/dsh-beacon/actions/workflows/ci.yml/badge.svg)](https://github.com/hmilyld/dsh-beacon/actions/workflows/ci.yml)

DSH（DeepSeek Harness）通知插件：当 **任务完成**，或 Agent 需要你做**选择 / 确认 / 审批**时，
向指定 URL 推送一条 JSON webhook。适合接到企业微信、钉钉、Slack、Bark、ntfy 之类的接收端。

- 四类事件：任务完成、Agent 提问、计划确认、工具审批。
- 发送是 fire-and-forget：**接收端出错绝不影响 Agent 运行**。
- 配置可在 DSH 界面里改，**保存即生效**，不用重启。

## 事件

| `eventType` | 触发时机 |
| --- | --- |
| `task_completed` | 一轮任务完成、Agent 归空 |
| `user_question` | Agent 提问，等待你选择或回答 |
| `plan_confirmation` | Agent 提交计划，等待你确认 |
| `approval_request` | 工具调用需要你审批 |

## 环境要求

- DSH `0.2.0-rc.2`。插件声明了所需的 DSH 版本，插件管理器会在版本不匹配时提示。
- 用 DSH 的 Web 界面或桌面版配置时需要客户端半边（已随插件打包）。

## 安装

```bash
# npm（推荐）
dsh plugin --profile <name> add @hmilyld/dsh-beacon

# 或从 GitHub 安装
dsh plugin --profile <name> add github:hmilyld/dsh-beacon
```

安装后重启一次 DSH。卸载：`dsh plugin --profile <name> remove @hmilyld/dsh-beacon`。

> pnpm 默认会拦下安装脚本。从 npm 装的是已构建好的包，不受影响；从 GitHub 或本地目录安装时，
> 若被拦，按 pnpm 提示把包名加入 `profiles/<name>/pnpm-workspace.yaml` 的 `allowBuilds` 后重试。

### 在 DSH 桌面版里安装

桌面版的 profile 由应用独占，命令行无法管理，请在应用内**插件管理页 → 添加插件**里填写：

| 来源 | 填法 |
| --- | --- |
| npm 包名（推荐） | `@hmilyld/dsh-beacon` |
| GitHub 仓库地址 | `github:hmilyld/dsh-beacon` |
| 压缩包 | `hmilyld-dsh-beacon-<版本>.tgz` 的**绝对路径**（可从 [Releases](https://github.com/hmilyld/dsh-beacon/releases) 下载） |
| 本地目录 | 已构建的插件目录**绝对路径** |

安装后按页面提示重启，再到插件详情里填写 `webhookUrl`。

## 配置

### 在界面里配置（推荐）

打开 DSH 的**插件管理页 → dsh-beacon → 详情**，编辑并保存即可。
编辑先暂存，点「保存」才写回；字段旁的「已覆盖默认值 / 恢复默认」标出哪些值是你改过的。
保存后**立即生效，无需重启**（包括刚填上此前留空的 `webhookUrl`）。

### 在 profile 里配置

也可以直接写 profile 的 patch 文件（`$DSH_HOME/profiles/<name>/cordis.patch.yml`，`$DSH_HOME` 默认 `~/.dsh`）：

```yaml
- id: dsh-beacon
  config:
    webhookUrl: 'https://example.com/api/dsh-beacon'
```

只写 `webhookUrl` 即可，其余字段回落到默认值。全部字段的示例见
[`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml)。

> 官方 patch 是**按 id 覆盖整行 config**（没有深合并）：省略的字段回落到默认值，
> 所以改配置时不要假设未写的字段还保留之前的值。这里的 `id: dsh-beacon` 是固定值，与包名无关。

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `webhookUrl` | string | 空（即停用） | 接收 webhook 的 URL（POST）。为空时不发送任何请求，之后填上也立即生效 |
| `payloadTemplate` | string | [内置模板](examples/profile.cordis.patch.yml) | JSON 模板，支持下面的变量；渲染结果必须是合法 JSON，否则跳过该次发送并记错误日志 |
| `headers` | object | `{"Content-Type": "application/json"}` | 随请求发送的 HTTP 请求头，界面上以 JSON 文本编辑 |
| `triggerOnUserQuestion` | boolean | `true` | 是否发送 `user_question`；计划确认与审批**不受**这个开关影响 |
| `dedupWindowMs` | number | `5000` | 去重窗口（毫秒）：同一会话同一类事件在窗口内只发一次 |
| `skipSubagents` | boolean | `true` | 是否跳过子代理的任务完成通知；审批与提问不受影响 |

### 模板变量

| 变量 | 含义 |
| --- | --- |
| `{{eventType}}` | `task_completed` / `user_question` / `plan_confirmation` / `approval_request` |
| `{{summary}}` | 事件摘要（任务完成 = 最后一条回复文本；提问 = 问题与选项；审批 = 工具名与原因），最多 200 字符 |
| `{{sessionId}}` | 会话 id |
| `{{time}}` | 发送时刻，`YYYY-MM-DD HH:mm:ss`（本机时区） |

变量值做了 JSON 转义，可以安全地嵌进模板的字符串里；未知变量原样保留。

例如只关心任务完成，可以这样最小化推送内容：

```yaml
payloadTemplate: '{"event": "{{eventType}}", "msg": "{{summary}}", "time": "{{time}}"}'
```

## 行为说明

- 请求超时 10 秒；HTTP 非 2xx、网络失败、模板非法都只记日志，**不影响 Agent 运行**。
- 发送成功记 `debug` 日志，默认日志级别下不可见，调低级别可以看到每次发送的完整内容。
- 同一会话的同类事件在 `dedupWindowMs` 内合并成一次；主触发路径与兜底路径靠它去重，不会双发。
- 子代理默认不打扰你（`skipSubagents`）；但**审批与提问始终发送**——它们在等你拍板。

## 常见问题

**装好了但一条都没收到？**
检查 `webhookUrl` 是否为空——bundle 层预置的是空串，**不填地址就不会发送**（这是刻意的安全默认）。
填好保存后立即生效。

**想确认到底发出去了什么？**
把日志级别调到 `debug`，每次发送都会打印完整 payload。也可以先在本机起个接收端验证
（另开一个终端）：

```bash
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);s.writeHead(204).end()})}).listen(8080)"
```

然后把 `webhookUrl` 指向 `http://127.0.0.1:8080`，触发一次就能看到原始 JSON。

**收到重复通知？**
把 `dedupWindowMs` 调大（默认 5 秒）。同一会话里快速连续完成/提问的情况可以调大一些。

**子代理也想通知？**
把 `skipSubagents` 设为 `false`。

## 许可

[MIT](LICENSE) © 2026 hmilyld

## 开发

本仓库的开发、测试与发版约定见 [AGENTS.md](AGENTS.md)。
