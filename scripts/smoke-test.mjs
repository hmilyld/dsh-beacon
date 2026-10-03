#!/usr/bin/env node
/**
 * dsh-beacon 冒烟测试。
 *
 * 用假 ctx（on / logger / effect）加载编译产物 lib/index.js，配合本地 HTTP
 * server 接收 webhook，逐条验证：
 *   - 各触发路径（idle / turn-end 兜底 / waterfall 提问 / 计划确认 / 审批 /
 *     tool-call 与 tool-result 兜底）；
 *   - 幂等去重、子代理过滤、summary 提取与截断；
 *   - waterfall 的 next() 透传、非法模板跳过、非 2xx 告警；
 *   - 全字段 volatile（界面配置的前提）、空 URL 不发送但仍注册监听、
 *     模拟 Loader `_commitVolatile` 的热更新立即生效；
 *   - 浏览器半边 `lib/client.js` 的 ModuleLoader 包装格式与导出。
 *
 * 运行：npm test（先 build 再跑本脚本）。
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { apply, name, inject, Config, DEFAULT_PAYLOAD_TEMPLATE } from '../lib/index.js'

// ---------------------------------------------------------------- 基础设施

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
function ok(condition, label) {
  if (condition) {
    passed += 1
    console.log(`ok - ${label}`)
  } else {
    failed += 1
    console.error(`FAIL - ${label}`)
  }
}

/** 收到的 webhook 记录。 */
const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    received.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body,
    })
    if (req.url === '/fail') {
      res.writeHead(500)
      res.end('boom')
    } else {
      res.writeHead(204)
      res.end()
    }
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/** 假 Cordis ctx：记录监听器 / 日志 / effect 清理器。 */
function makeCtx() {
  const listeners = new Map()
  const logs = []
  const disposers = []
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event)
      if (list) list.push(handler)
      else listeners.set(event, [handler])
    },
    logger(loggerName) {
      const make = (level) => (message) =>
        logs.push({ level, name: loggerName, message: String(message) })
      return { error: make('error'), info: make('info'), warn: make('warn'), debug: make('debug') }
    },
    effect(execute) {
      const dispose = execute()
      disposers.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    logs,
    /** 按注册顺序调用某事件的全部监听器，返回结果数组（waterfall 返回 Promise）。 */
    emit(event, ...args) {
      return (listeners.get(event) ?? []).map((handler) => handler(...args))
    },
    hasListeners: () => listeners.size > 0,
    dispose() {
      for (const dispose of disposers) dispose()
    },
  }
}

const baseConfig = (overrides = {}) => ({
  webhookUrl: `http://127.0.0.1:${port}/hook`,
  payloadTemplate:
    '{"event": "{{eventType}}", "success": true, "msg": "{{summary}}", "sessionId": "{{sessionId}}", "time": "{{time}}"}',
  headers: { 'Content-Type': 'application/json', 'X-Beacon': 'smoke' },
  triggerOnUserQuestion: true,
  dedupWindowMs: 500,
  skipSubagents: true,
  ...overrides,
})

const mainSession = { id: 'ses-main', header: { cwd: '/tmp', origin: undefined } }
const mainAgent = { id: 'ses-main', session: mainSession }
const subSession = { id: 'ses-sub', header: { cwd: '/tmp', origin: 'subagent' } }
const subAgent = { id: 'ses-sub', session: subSession }

const lastBody = () => JSON.parse(received[received.length - 1].body)

// ---------------------------------------------------------------- 测试用例

// 1. 导出形状与 schema 行为
ok(name === 'dsh-beacon', '导出 name')
// 不能注入 'logger'：ctx.logger 是 cordis 内置属性、没人 provide，注入它会让
// entry 永远 pending（设置镜像里就看不到这个插件，界面自然没有配置区）。
ok(Array.isArray(inject) && inject.length === 0, '导出 inject = []（不依赖任何外部服务）')
ok(Config != null && (typeof Config === 'object' || typeof Config === 'function'), '导出 Config schema')
let filled = null
try {
  filled = Config({ webhookUrl: 'https://example.com/hook' })
} catch {
  filled = null
}
ok(
  filled !== null
    && filled.webhookUrl.get() === 'https://example.com/hook'
    && filled.payloadTemplate.get() === DEFAULT_PAYLOAD_TEMPLATE
    && filled.headers.get()['Content-Type'] === 'application/json'
    && filled.triggerOnUserQuestion.get() === true
    && filled.dedupWindowMs.get() === 5000
    && filled.skipSubagents.get() === true,
  'Config schema 校验通过并填充全部默认值（输出为 volatile 包装）',
)
let threwOnMissingUrl = false
try {
  Config({})
} catch {
  threwOnMissingUrl = true
}
ok(threwOnMissingUrl, 'Config schema 拒绝缺失的必填 webhookUrl')

// 1b. 全字段 volatile——`dsh-settings.describe()` 只收录 volatile 字段，
//     这是「在界面上配置」的前提；同时 Loader 才会走 _commitVolatile 热写。
{
  const root = Config.toJSON()
  const node = root.refs[root.uid]
  const names = [
    'webhookUrl',
    'payloadTemplate',
    'headers',
    'triggerOnUserQuestion',
    'dedupWindowMs',
    'skipSubagents',
  ]
  const plain = names.filter((key) => root.refs[node.dict[key]]?.meta?.volatile !== true)
  ok(plain.length === 0, `六个配置字段全部声明为 volatile（${plain.join(',') || '无遗漏'}）`)
}

// 2. 空 webhookUrl：监听照常注册，但一条都不发（配置稍后可在界面上热填）
const idle = makeCtx()
const idleConfig = Config(baseConfig({ webhookUrl: '' }))
apply(idle.ctx, idleConfig)
ok(idle.hasListeners(), 'webhookUrl 为空时仍注册监听（否则界面补填地址也收不到信号）')
const n2 = received.length
idle.emit('agent/status', { agent: mainAgent, status: 'idle' })
await wait(200)
ok(received.length === n2, '空 webhookUrl 不发送任何请求')
ok(
  idle.logs.some((l) => l.level === 'info' && l.message.includes('webhookUrl')),
  '空 webhookUrl 记录 info 提示',
)

// 2b. volatile 热更新：把新值写进同一个包装对象，等价于 Loader 的
//     _commitVolatile——apply 捕获的 config 不换、监听不重挂，但读到新地址。
updateVolatile(idleConfig.webhookUrl, createVolatile(`http://127.0.0.1:${port}/hook`))
const n2b = received.length
idle.emit('agent/status', { agent: mainAgent, status: 'idle' })
await wait(250)
ok(received.length === n2b + 1, '热更新 webhookUrl 后无需重启插件即可发送')
ok(received.length > 0 && lastBody().event === 'task_completed', '热更新后发送的 payload 正确')

// 3. 主路径：agent/status → idle
const app = makeCtx()
apply(app.ctx, baseConfig())
const n3 = received.length
app.emit('agent/status', { agent: mainAgent, status: 'running' })
await wait(100)
ok(received.length === n3, 'running 状态不发送')
app.emit('agent/status', { agent: mainAgent, status: 'idle' })
await wait(200)
ok(received.length === n3 + 1, 'agent/status idle 触发 task_completed')
const req3 = received[received.length - 1]
const p3 = lastBody()
ok(req3.method === 'POST', '请求方法为 POST')
ok(req3.headers['content-type'] === 'application/json', '携带 Content-Type 请求头')
ok(req3.headers['x-beacon'] === 'smoke', '携带自定义请求头')
ok(p3.event === 'task_completed', 'eventType = task_completed')
ok(p3.success === true, 'payload 与模板一致（success=true）')
ok(p3.sessionId === 'ses-main', 'sessionId 取自 agent.id')
ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(p3.time), 'time 为 YYYY-MM-DD HH:mm:ss 本地格式')
ok(p3.msg === '任务已完成', '无历史时 summary 使用默认文案')

// 4. 幂等去重（同会话同事件类型、窗口内）
app.emit('agent/status', { agent: mainAgent, status: 'idle' })
await wait(150)
ok(received.length === n3 + 1, '去重窗口内重复 idle 被合并')

// 5. assistant 文本作为 summary
const ses2 = { id: 'ses-2', header: { origin: undefined } }
app.emit('session/event', ses2, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '重构完成，共修改 3 个文件' }] } },
})
app.emit('agent/status', { agent: { id: 'ses-2', session: ses2 }, status: 'idle' })
await wait(200)
ok(received.length === n3 + 2, '新会话 idle 触发 task_completed')
ok(lastBody().msg === '重构完成，共修改 3 个文件', '{{summary}} 取最后一条 assistant 文本')

// 6. turn/end 兜底：无权威状态时延迟 1s 发送
const ses3 = { id: 'ses-3', header: { origin: undefined } }
app.emit('session/event', ses3, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '任务收尾完成' }] } },
})
const n6 = received.length
app.emit('session/event', ses3, { type: 'turn/end', data: { turn: 1, reason: {} } })
await wait(300)
ok(received.length === n6, 'turn/end 兜底有 1s 延迟，不立即发送')
await wait(950)
ok(received.length === n6 + 1, '1s 内无权威信号 → 兜底发送 task_completed')
ok(lastBody().msg === '任务收尾完成', '兜底路径同样带上 assistant summary')

// 7. turn/end 让位：已有权威状态时交给 agent/status
const ses4 = { id: 'ses-4', header: { origin: undefined } }
const agent4 = { id: 'ses-4', session: ses4 }
app.emit('agent/status', { agent: agent4, status: 'running' })
const n7 = received.length
app.emit('session/event', ses4, { type: 'turn/end', data: { turn: 1, reason: {} } })
await wait(1300)
ok(received.length === n7, '已有 agent/status 状态时 turn/end 兜底不发送')
app.emit('agent/status', { agent: agent4, status: 'idle' })
await wait(200)
ok(received.length === n7 + 1, '随后的 idle 权威信号正常发送')

// 8. 子代理过滤（skipSubagents=true）
const n8 = received.length
app.emit('agent/status', { agent: subAgent, status: 'idle' })
app.emit('session/event', subSession, {
  type: 'tool/call',
  data: { callId: 'call-sub', name: 'ask_user_question', arguments: '{}' },
})
app.emit('session/event', subSession, { type: 'turn/end', data: { turn: 1, reason: {} } })
await wait(300)
ok(received.length === n8, 'skipSubagents=true 时子代理的完成/工具/兜底路径均不发送')

// 9. user-questions waterfall 主路径 + next() 透传
const ANSWER = { answers: [{ id: 'q1', selected: ['方案A'] }] }
const n9 = received.length
const [answer9] = app.emit(
  'user-questions/request',
  {
    agent: mainAgent,
    questions: [
      {
        id: 'q1',
        question: '选哪个方案？',
        options: [{ label: '方案A' }, { label: '方案B' }],
      },
    ],
  },
  async () => ANSWER,
)
ok((await answer9) === ANSWER, 'user-questions waterfall 同步透传 next() 的返回值')
await wait(200)
ok(received.length === n9 + 1, 'user-questions/request 触发 user_question')
const p9 = lastBody()
ok(p9.event === 'user_question', 'eventType = user_question')
ok(p9.msg.includes('选哪个方案？') && p9.msg.includes('方案A'), 'summary 拼出问题与选项')

// 10. 去重合并 + waterfall 接管 tool/call 兜底 + tool/result 不重发
app.emit(
  'user-questions/request',
  { agent: mainAgent, questions: [{ id: 'q2', question: '再来一个？' }] },
  async () => ANSWER,
)
await wait(150)
ok(received.length === n9 + 1, '去重窗口内重复提问被合并')

const sesQ = { id: 'ses-q', header: { origin: undefined } }
const n10 = received.length
app.emit('session/event', sesQ, {
  type: 'tool/call',
  data: { callId: 'call-101', name: 'ask_user_question', arguments: '{}' },
})
// ask_user_question 执行时必经 waterfall：主路径应立即发送并接管（取消兜底）
const [answer10] = app.emit(
  'user-questions/request',
  {
    agent: { id: 'ses-q', session: sesQ },
    questions: [{ id: 'q3', question: '接管哪条路径？' }],
    wait: { callId: 'call-101', timed: true },
  },
  async () => ANSWER,
)
await answer10
await wait(200)
ok(received.length === n10 + 1, 'waterfall 主路径立即发送并覆盖该 callId')
await wait(650)
ok(received.length === n10 + 1, 'waterfall 接管后 500ms 兜底定时器已取消')
app.emit('session/event', sesQ, {
  type: 'tool/result',
  data: { message: { toolCallId: 'call-101', content: [] } },
})
await wait(200)
ok(received.length === n10 + 1, 'waterfall 已覆盖的 callId 在 tool/result 不重发')

// 11. plan-review intent → plan_confirmation
const n11 = received.length
app.emit(
  'user-questions/request',
  {
    agent: mainAgent,
    questions: [
      {
        id: 'p1',
        question: '是否执行该计划？',
        intent: { kind: 'plan-review', approve: '同意执行' },
      },
    ],
  },
  async () => ANSWER,
)
await wait(200)
ok(received.length === n11 + 1, 'plan-review intent 触发通知')
ok(lastBody().event === 'plan_confirmation', 'eventType = plan_confirmation')

// 12. approval waterfall：透传 next()、正常发送、子代理不过滤
const OUTCOME = 'allowed-once'
const n12 = received.length
const [outcome12] = app.emit(
  'approval/request',
  { agent: mainAgent, toolName: 'bash', reason: '允许执行清理命令' },
  async () => OUTCOME,
)
ok((await outcome12) === OUTCOME, 'approval waterfall 同步透传 next() 的返回值')
await wait(150)
ok(received.length === n12 + 1, 'approval/request 触发 approval_request')
ok(lastBody().event === 'approval_request', 'eventType = approval_request')
ok(lastBody().msg.includes('bash') && lastBody().msg.includes('允许执行清理命令'), 'summary 含工具名与原因')
const [outcome12b] = app.emit(
  'approval/request',
  { agent: subAgent, toolName: 'fs-write' },
  async () => OUTCOME,
)
await outcome12b
await wait(150)
ok(received.length === n12 + 2, '子代理审批不过滤，照常发送')

// 13. waterfall 缺席时的 tool/call 兜底（延迟 500ms）+ tool/result 不重发
const sesT = { id: 'ses-tool', header: { origin: undefined } }
const n13 = received.length
app.emit('session/event', sesT, {
  type: 'tool/call',
  data: { callId: 'call-201', name: 'ask_user_question', arguments: '{}' },
})
await wait(250)
ok(received.length === n13, 'waterfall 缺席时 tool/call 兜底延迟 500ms')
await wait(550)
ok(received.length === n13 + 1, '500ms 后兜底发送 user_question')
app.emit('session/event', sesT, {
  type: 'tool/result',
  data: { message: { toolCallId: 'call-201', content: [] } },
})
await wait(200)
ok(received.length === n13 + 1, 'tool/result 不重复发送已覆盖的提问')

// 14. tool/result 先于兜底到达：提前发送且取消兜底定时器
// （换独立会话，避免与用例 13 的发送落在同一个去重窗口边界上）
const sesT2 = { id: 'ses-tool-2', header: { origin: undefined } }
const n14 = received.length
app.emit('session/event', sesT2, {
  type: 'tool/call',
  data: { callId: 'call-202', name: 'ask_user_question', arguments: '{}' },
})
app.emit('session/event', sesT2, {
  type: 'tool/result',
  data: { message: { toolCallId: 'call-202', content: [] } },
})
await wait(200)
ok(received.length === n14 + 1, 'tool/result 先到时直接发送')
await wait(600)
ok(received.length === n14 + 1, '原兜底定时器已取消，不产生第二次发送')

// 15. exit_plan_mode → plan_confirmation（从参数提取计划）
const n15 = received.length
app.emit('session/event', sesT, {
  type: 'tool/call',
  data: {
    callId: 'call-301',
    name: 'exit_plan_mode',
    arguments: JSON.stringify({ plan: '1. 编码\n2. 测试' }),
  },
})
await wait(800)
ok(received.length === n15 + 1, 'exit_plan_mode 触发 plan_confirmation')
ok(lastBody().event === 'plan_confirmation', 'exit_plan_mode 的 eventType 正确')
ok(lastBody().msg.includes('1. 编码'), 'summary 从工具参数提取了计划正文')

// 16. 非法 payloadTemplate → 跳过并记错误日志
const bad = makeCtx()
apply(bad.ctx, baseConfig({ payloadTemplate: 'event={{eventType}}' }))
const n16 = received.length
bad.emit('agent/status', { agent: mainAgent, status: 'idle' })
await wait(200)
ok(received.length === n16, '非法 JSON 模板不发送')
ok(
  bad.logs.some((l) => l.level === 'error' && l.message.includes('JSON')),
  '非法 JSON 模板记录错误日志',
)

// 17. triggerOnUserQuestion=false：提问不发、审批照发
const off = makeCtx()
apply(off.ctx, baseConfig({ triggerOnUserQuestion: false }))
const n17 = received.length
off.emit(
  'user-questions/request',
  { agent: mainAgent, questions: [{ id: 'q', question: '还问吗？' }] },
  async () => ANSWER,
)
off.emit('session/event', sesT, {
  type: 'tool/call',
  data: { callId: 'call-401', name: 'ask_user_question', arguments: '{}' },
})
await wait(800)
ok(received.length === n17, '关闭提问开关后提问与工具兜底均不发送')
off.emit('approval/request', { agent: mainAgent, toolName: 'bash' }, async () => OUTCOME)
await wait(150)
ok(received.length === n17 + 1, '提问开关不影响审批通知')

// 17b. triggerOnUserQuestion=false 不影响计划确认：主路径照发 plan_confirmation
//      （开关只过滤 user_question，见 Config.triggerOnUserQuestion 的说明）。
const off2 = makeCtx()
apply(off2.ctx, baseConfig({ triggerOnUserQuestion: false }))
const planOnlyAgent = { id: 'ses-plan-off', session: { id: 'ses-plan-off', header: { origin: undefined } } }
const n17b = received.length
off2.emit(
  'user-questions/request',
  {
    agent: planOnlyAgent,
    questions: [{ id: 'p2', question: '是否执行该计划？', intent: { kind: 'plan-review', approve: '同意执行' } }],
  },
  async () => ANSWER,
)
await wait(200)
ok(received.length === n17b + 1, '关闭提问开关后计划确认仍由主路径发送')
ok(lastBody().event === 'plan_confirmation', '关闭提问开关时 eventType 仍为 plan_confirmation')

// 18. 非 2xx → warn 日志
const fail = makeCtx()
apply(fail.ctx, baseConfig({ webhookUrl: `http://127.0.0.1:${port}/fail` }))
fail.emit('agent/status', { agent: mainAgent, status: 'idle' })
await wait(250)
ok(
  fail.logs.some((l) => l.level === 'warn' && l.message.includes('500')),
  'webhook 返回非 2xx 时记录 warn',
)

// 19. summary 截断到 200 字符
const sesLong = { id: 'ses-long', header: { origin: undefined } }
app.emit('session/event', sesLong, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: 'x'.repeat(500) }] } },
})
app.emit('agent/status', { agent: { id: 'ses-long', session: sesLong }, status: 'idle' })
await wait(200)
ok(lastBody().msg.length <= 200, 'summary 截断到 200 字符')

// 20. 卸载清理：effect 清理器可执行（定时器集合清空）
try {
  app.dispose()
  idle.dispose()
  bad.dispose()
  off.dispose()
  off2.dispose()
  fail.dispose()
  ok(true, 'fiber 卸载清理（effect）正常执行')
} catch (err) {
  ok(false, `fiber 卸载清理（effect）正常执行：${err}`)
}

// 21. 浏览器半边：dsh.client 声明 + ModuleLoader 包装格式 + 导出
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
ok(pkg.dsh?.client?.platform === 'web', 'package.json 声明 dsh.client.platform = web')
ok(
  Array.isArray(pkg.dsh?.client?.inject)
    && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings')
    && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'),
  'package.json 的 dsh.client.inject 先于 configForms / 插件管理页就位',
)
ok(pkg.exports?.['./client']?.default === './lib/client.js', 'exports["./client"] 指向 lib/client.js')

// 21b. 发版元数据：插件管理器只认 peerDependencies 里的 @deepseek-ai/dsh* 做版本兼容判定，
//      仓库 / 许可 / files 是公开发布的必要信息。
const dshPeers = Object.keys(pkg.peerDependencies ?? {}).filter(
  (peer) => peer === '@deepseek-ai/dsh' || peer.startsWith('@deepseek-ai/dsh-'),
)
ok(dshPeers.length > 0, `声明 DSH peer 依赖（兼容性门禁）：${dshPeers.join(', ') || '缺失'}`)
ok(pkg.publishConfig?.access === 'public', 'package.json 声明 publishConfig.access = public')
ok(
  typeof pkg.repository?.url === 'string' && pkg.repository.url.includes('github.com/hmilyld/dsh-beacon'),
  'package.json 声明 repository 指向公开仓库',
)
ok(
  Array.isArray(pkg.files) && pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'),
  'package.json 的 files 带上 lib 与 cordis.patch.yml',
)
const licenseSource = await readFile(new URL('../LICENSE', import.meta.url), 'utf8').catch(() => null)
ok(licenseSource?.includes('MIT License') === true, '仓库根存在 MIT LICENSE')

// 21c. 包名与 bundle 层的一致性：`name` = package.json 的包名（Loader 按它解析），
//      `id` 固定为 dsh-beacon（= 设置命名空间，改名会丢掉用户已保存的配置）。
const patchSource = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
ok(pkg.name === '@hmilyld/dsh-beacon', `包名为 scoped 名：${pkg.name}`)
ok(
  patchSource.includes(`name: '${pkg.name}'`),
  'cordis.patch.yml 的 name 与 package.json 的 name 一致',
)
ok(
  /^\s+- id: dsh-beacon$/m.test(patchSource),
  'cordis.patch.yml 的 Loader 条目 id 仍为 dsh-beacon（设置命名空间不变）',
)

let clientSource = null
try {
  clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
} catch {
  clientSource = null
}
ok(clientSource !== null, '构建产出 lib/client.js（缺它 dsh 启动即抛 MissingClientBundleError）')

if (clientSource !== null) {
  let registration = null
  try {
    new Function('window', clientSource)({
      __ModuleLoader__: { load: (entry) => (registration = entry) },
    })
  } catch (err) {
    registration = null
    console.error(`      lib/client.js 顶层执行失败：${err}`)
  }
  ok(registration !== null, 'lib/client.js 通过 window.__ModuleLoader__.load 注册')
  ok(registration?.id === '@hmilyld/dsh-beacon', 'ModuleLoader id = 包名（scoped）')

  // 平台 seed：react / react/jsx-runtime 是前端静态模块表提供的词，不打进产物。
  const seed = new Proxy({}, { get: () => () => null, has: () => true })
  let clientExports = null
  try {
    clientExports = registration.factory((spec) => {
      if (spec === 'react' || spec === 'react/jsx-runtime' || spec.startsWith('@deepseek-ai/')) {
        return seed
      }
      throw new Error(`产物里出现了非 seed 依赖：${spec}`)
    })
  } catch (err) {
    console.error(`      client factory 执行失败：${err}`)
  }
  ok(clientExports !== null, 'factory(require) 顺利求值（external 只剩平台 seed）')
  ok(typeof clientExports?.apply === 'function', '客户端 bundle 导出 apply')
  ok(
    Array.isArray(clientExports?.inject)
      && clientExports.inject.includes('slots')
      && clientExports.inject.includes('configForms'),
    '客户端 bundle 声明 slots / configForms 注入',
  )
}

// ---------------------------------------------------------------- 收尾

console.log(`\n${passed} passed, ${failed} failed`)
server.closeAllConnections?.()
server.close()
// undici 的 keep-alive 连接可能挂住事件循环，兜底强制退出。
setTimeout(() => process.exit(failed > 0 ? 1 : 0), 300)
