#!/usr/bin/env node
/**
 * dsh-beacon 真实端点联调：用编译产物向配置的真实 webhook 地址发送四类事件。
 *
 * 结构：插件 → 本地代理（记录请求 + 原样转发上游）→ 真实接口。
 * 这样既能走插件真实的渲染/发送代码路径，又能打印上游返回内容。
 *
 * 配置来源：scripts/send-test.config.json（git-ignored，含真实 URL 与 token）。
 * `targetUrl` 缺失时回落到环境变量 DSH_BEACON_TEST_URL；`payloadTemplate` 缺失
 * 时回落到插件内置的默认模板。
 *
 * 运行：npm run send-test
 */

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { apply, DEFAULT_PAYLOAD_TEMPLATE } from '../lib/index.js'

// ---------------------------------------------------------------- 测试配置

let fileCfg = {}
try {
  fileCfg = JSON.parse(
    readFileSync(new URL('./send-test.config.json', import.meta.url), 'utf8'),
  )
} catch {
  /* 没有本地配置文件就走环境变量与内置默认模板 */
}
const targetUrl = fileCfg.targetUrl || process.env.DSH_BEACON_TEST_URL
const payloadTemplate = fileCfg.payloadTemplate || DEFAULT_PAYLOAD_TEMPLATE
if (!targetUrl) {
  console.error(
    '缺少目标地址：请创建 scripts/send-test.config.json（{ "targetUrl", "payloadTemplate"? }）' +
      '或设置环境变量 DSH_BEACON_TEST_URL。',
  )
  process.exit(2)
}

// ---------------------------------------------------------------- 本地代理

const forwarded = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', async () => {
    console.log(`[proxy 收到] ${new Date().toISOString()} ${body.slice(0, 80)}...`)
    let upstream = { status: 0, body: '(转发失败)' }
    try {
      const r = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20000),
      })
      upstream = { status: r.status, body: await r.text() }
    } catch (err) {
      upstream = { status: 0, body: String(err) }
    }
    console.log(`[proxy 上游返回] ${new Date().toISOString()} HTTP ${upstream.status}`)
    forwarded.push({ request: body, upstream })
    res.writeHead(upstream.status || 502, { 'Content-Type': 'application/json' })
    res.end(upstream.body)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const proxyUrl = `http://127.0.0.1:${server.address().port}/hook`

// ---------------------------------------------------------------- 假 ctx

function makeCtx() {
  const listeners = new Map()
  const logs = []
  const ctx = {
    on(event, handler) {
      const list = listeners.get(event)
      if (list) list.push(handler)
      else listeners.set(event, [handler])
    },
    logger(name) {
      const make = (level) => (message) =>
        logs.push({ level, name, message: String(message) })
      return { error: make('error'), info: make('info'), warn: make('warn'), debug: make('debug') }
    },
    effect(execute) {
      return execute()
    },
  }
  return {
    ctx,
    logs,
    emit(event, ...args) {
      return (listeners.get(event) ?? []).map((handler) => handler(...args))
    },
  }
}

const app = makeCtx()
apply(app.ctx, {
  webhookUrl: proxyUrl,
  payloadTemplate,
  headers: { 'Content-Type': 'application/json' },
  triggerOnUserQuestion: true,
  dedupWindowMs: 5000,
  skipSubagents: true,
})

// ---------------------------------------------------------------- 四类事件

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const session = (id) => ({ id, header: { origin: undefined } })

// 1. task_completed
const ses1 = session('wx-task-1')
app.emit('session/event', ses1, {
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text: '测试：构建通过，typecheck 与冒烟测试全部通过。' }] } },
})
app.emit('agent/status', { agent: { id: 'wx-task-1', session: ses1 }, status: 'idle' })
console.log('[emit] task_completed 已触发')

// 2. user_question
await wait(300)
const ANSWER = { answers: [{ id: 'q1', selected: ['测试'] }] }
await app.emit(
  'user-questions/request',
  {
    agent: { id: 'ses2', session: session('wx-question-2') },
    questions: [
      { id: 'q1', question: '部署到哪台服务器？', options: [{ label: '测试' }, { label: '生产' }] },
    ],
  },
  async () => ANSWER,
)[0]

// 3. plan_confirmation
await wait(300)
await app.emit(
  'user-questions/request',
  {
    agent: { id: 'ses3', session: session('wx-plan-3') },
    questions: [
      { id: 'p1', question: '是否执行发布计划？', intent: { kind: 'plan-review', approve: '同意执行' } },
    ],
  },
  async () => ANSWER,
)[0]

// 4. approval_request
await wait(300)
await app.emit(
  'approval/request',
  { agent: { id: 'ses4', session: session('wx-approval-4') }, toolName: 'bash', reason: '执行部署脚本 deploy.sh' },
  async () => 'allowed-once',
)[0]

// ---------------------------------------------------------------- 结果

await wait(1500)

let allOk = true
console.log(`\n目标接口：${targetUrl}\n`)
forwarded.forEach((record, i) => {
  console.log(`—— 第 ${i + 1} 条 ——`)
  console.log('插件发送：', record.request)
  console.log('接口返回：', `HTTP ${record.upstream.status} ${record.upstream.body}`)
  console.log()
  if (!(record.upstream.status >= 200 && record.upstream.status < 300)) allOk = false
})
console.log(
  allOk && forwarded.length === 4
    ? `✅ 4 类事件全部发送成功（上游均返回 2xx）`
    : `❌ 存在失败项：共发送 ${forwarded.length} 条`,
)
if (app.logs.some((l) => l.level === 'warn' || l.level === 'error')) {
  console.log('插件日志告警：', app.logs.filter((l) => l.level !== 'debug'))
}

server.closeAllConnections?.()
server.close()
setTimeout(() => process.exit(allOk && forwarded.length === 4 ? 0 : 1), 300)
