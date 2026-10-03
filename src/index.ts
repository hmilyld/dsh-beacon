/**
 * dsh-beacon（DSH 信标）
 *
 * 当 DSH 任务完成，或 Agent 需要用户选择 / 确认 / 审批时，向配置的 URL
 * 发送一次带变量替换的 JSON POST webhook。
 *
 * 触发点（对照 DSH 0.2.0-rc.2 类型包源码验证）：
 *   1. `agent/status` → `idle`：任务完成的权威信号（一轮结束、driver 归空）。
 *   2. `session/event` → `turn/end`：完成信号的兜底——仅当拿不到该 agent 的
 *      `agent/status`（如插件中途加载）时延迟 1s 发送，期间一旦出现权威
 *      信号就让位；与主路径之间靠去重窗口合并。
 *   3. `user-questions/request`（Cordis waterfall）：Agent 提问 / 计划确认
 *      （`intent.kind === 'plan-review'`）的权威信号。监听器必须同步
 *      `return next()`，否则会否决后续应答者。
 *   4. `approval/request`（Cordis waterfall）：工具审批的权威信号，同样
 *      同步 `return next()`。审批一律发送（含子代理）——它在等真人拍板。
 *   5. `session/event` → `tool/call` / `tool/result`：上述 waterfall 缺席时
 *      的兜底，覆盖 `ask_user_question` / `exit_plan_mode`，按 callId 配对；
 *      `tool/call` 延迟 500ms 让 waterfall 主路径优先发送。
 *
 * 所有发送都是 fire-and-forget：模板渲染、fetch、日志全部 try/catch 包裹，
 * webhook 故障绝不影响 agent 主循环。
 */

import Schema from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AskUserQuestionItem,
  AskUserQuestionRequestEvent,
} from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'

/** 插件名（Loader 取命名导出 `name`）。 */
export const name = 'dsh-beacon'

/**
 * 不依赖任何外部服务——**尤其不要写 `'logger'`**：
 * `ctx.logger` 是 cordis 在根 `Context` 构造器里 `new LoggerService(self)` 装好的
 * 内置属性，从未 `ctx.provide('logger')`，inject 会一直 `pending (waiting for
 * service: logger)`，导致整条 entry 不激活、设置镜像里也看不到这个插件。
 * （官方插件的 `inject` 只列真由别的插件提供的服务，如 `["llm"]`、`["sessions"]`。）
 */
export const inject: string[] = []

/** 写入 payload 的事件类型（{{eventType}} 变量取值）。 */
export type BeaconEventType =
  | 'task_completed'
  | 'user_question'
  | 'plan_confirmation'
  | 'approval_request'

/**
 * 插件配置（由同名 `Config` schema 校验并填充默认值）。
 *
 * 全部字段声明为 `volatile()`：Loader 判定为「仅 volatile 变更」时走
 * `_commitVolatile` 原地热写（不重启插件），因此
 *   - 运行时值是 `Volatile<T>` 包装，**必须在使用时 `.get()` 读取**，
 *     绝不能在 apply 时把值取出来缓存（那样热更新就失效了）；
 *   - `dsh-settings.describe()` 自动把含 volatile 字段的插件收录进
 *     设置镜像，客户端由此拿到 schema 并渲染出配置表单。
 */
export interface Config {
  /** 必填：接收 webhook 的 URL（POST 目标）。留空则每次发送前静默跳过（监听仍注册，填上即可生效）。 */
  webhookUrl: Volatile<string>
  /** JSON 模板；支持 {{eventType}} / {{summary}} / {{sessionId}} / {{time}} 变量。 */
  payloadTemplate: Volatile<string>
  /** 随请求发送的 HTTP 请求头。 */
  headers: Volatile<Record<string, string>>
  /** 是否在 Agent 向用户提问（user_question）时发送；计划确认与审批不受此开关影响。 */
  triggerOnUserQuestion: Volatile<boolean>
  /** 幂等去重窗口（毫秒）：同一会话同一事件类型在窗口内只发一次。 */
  dedupWindowMs: Volatile<number>
  /** 是否跳过子代理（header.origin === 'subagent'）的任务完成与工具路径通知；审批与提问不过滤。 */
  skipSubagents: Volatile<boolean>
}

/** 默认 payload 模板：最小可用的 JSON，用户可在 profile 中整值替换。 */
export const DEFAULT_PAYLOAD_TEMPLATE =
  '{"event": "{{eventType}}", "success": true, "msg": "{{summary}}", "sessionId": "{{sessionId}}", "time": "{{time}}"}'

export const Config = Schema.object({
  // volatile() 必须是链尾：schemastery 的 volatile() 即 extra('volatile', true)。
  webhookUrl: Schema.string().role('url').required().volatile(),
  payloadTemplate: Schema.string().default(DEFAULT_PAYLOAD_TEMPLATE).volatile(),
  headers: Schema.dict(Schema.string()).default({ 'Content-Type': 'application/json' }).volatile(),
  triggerOnUserQuestion: Schema.boolean().default(true).volatile(),
  dedupWindowMs: Schema.natural().default(5000).volatile(),
  skipSubagents: Schema.boolean().default(true).volatile(),
})

/** 编译期自检：schema 的校验输出必须与上面的 `Config` 接口一致（volatile 字段输出为 `Volatile<T>`）。 */
type Assert<T extends true> = T
type _ConfigMatchesSchema = Assert<
  Schemastery.TypeT<typeof Config> extends Config
    ? Config extends Schemastery.TypeT<typeof Config>
      ? true
      : false
    : false
>

/**
 * 读取一个配置值。
 *
 * 标了 `volatile()` 的字段在运行时是 `Volatile<T>` 包装，热更新写的是包装
 * 内部的引用——所以每次触发都要重新 `read()`，把 apply 时的值缓存下来会让
 * 界面上的修改永远不生效。这里对非 volatile 字段也保持兼容，方便测试直接
 * 传普通对象。
 */
function read<T>(value: Volatile<T> | T): T {
  return isVolatile(value) ? ((value as Volatile<T>).get() as T) : (value as T)
}

/** tool/call 兜底延迟：给 waterfall 主路径留出优先发送的时间。 */
const FALLBACK_DELAY_MS = 500
/** turn/end 兜底延迟：给 agent/status 权威信号留出出现的时间。 */
const TURN_END_DELAY_MS = 1000
/** webhook 请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 10_000
/** {{summary}} 最大长度（字符）。 */
const SUMMARY_LIMIT = 200
/** callId 跟踪集合的容量上限（防止长期运行无限增长）。 */
const MAX_TRACKED_CALLS = 2048

/**
 * Cordis 插件入口：Loader 取命名导出 `name` / `inject` / `Config` / `apply`，
 * 在按 schema 校验并填充默认值后调用 apply(ctx, config)。
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-beacon')

  /** 统一日志出口：fiber 卸载后 logger 可能抛错，日志失败绝不能影响流程。 */
  function log(level: 'error' | 'info' | 'warn' | 'debug', message: string): void {
    try {
      logger[level](message)
    } catch {
      /* 日志服务不可用时静默忽略 */
    }
  }

  // 注意：这里不因 webhookUrl 为空而早退。配置是 volatile 的——用户稍后在
  // 设置页填上地址时 Loader 只做热写、不重启插件，监听若没注册就永远收不到
  // 信号。改为「始终注册监听，每次发送前再读一次 URL，为空则静默跳过」。
  if (!read(config.webhookUrl)) {
    log('info', '未配置 webhookUrl：dsh-beacon 暂不发送（在插件设置页填好保存后立即生效）')
  }

  /** 各 agent 的最近状态（turn/end 兜底据此判断是否已有权威信号）。 */
  const statuses = new Map<string, AgentStatus>()
  /** 各会话最后一条 assistant 文本（用于 {{summary}}）。 */
  const lastAssistant = new Map<string, string>()
  /** 幂等去重：key = `sessionId|eventType` → 上次发送时刻。 */
  const recent = new Map<string, number>()
  /** 待配对的相关工具调用：callId → { 工具名, 预先算好的 summary }。 */
  const pendingCalls = new Map<string, { toolName: string; summary: string }>()
  /** 已被通知覆盖的 callId：waterfall 或兜底已处理，tool/result 不再重发。 */
  const notified = new Set<string>()
  /** 进行中的 tool/call 兜底定时器：callId → timer（被主路径接管时取消）。 */
  const fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 全部延迟定时器：fiber 卸载时统一清理，避免卸载后仍有回调触发发送。 */
  const timers = new Set<ReturnType<typeof setTimeout>>()

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    fallbackTimers.clear()
  })

  /** 错误 → 一行可读文本。 */
  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  /** {{summary}} 统一截断到 200 字符。 */
  function clamp(text: string): string {
    return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text
  }

  /** 当前时间 → `YYYY-MM-DD HH:mm:ss`（本地时区，按需求不带 T、时区后缀与毫秒）。 */
  function formatTime(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0')
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    )
  }

  /** 注册一个延迟回调，并纳入卸载清理。 */
  function schedule(fn: () => void, delay: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, delay)
    timers.add(timer)
    return timer
  }

  /** 跟踪一个待配对的相关工具调用（超限时淘汰最旧的一条）。 */
  function trackCall(callId: string, info: { toolName: string; summary: string }): void {
    pendingCalls.set(callId, info)
    if (pendingCalls.size <= MAX_TRACKED_CALLS) return
    const oldest = pendingCalls.keys().next().value
    if (oldest !== undefined) pendingCalls.delete(oldest)
  }

  /** 取消某个 callId 尚未触发的兜底定时器。 */
  function cancelFallback(callId: string): void {
    const timer = fallbackTimers.get(callId)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(timer)
    fallbackTimers.delete(callId)
  }

  /**
   * 标记该 callId 的通知已被覆盖：作废兜底定时器并记入 notified，
   * 后续 tool/result 不再重发（应答可能迟到数分钟，早已超出去重窗口）。
   */
  function coverCall(callId: string): void {
    cancelFallback(callId)
    notified.add(callId)
    if (notified.size <= MAX_TRACKED_CALLS) return
    // Set 按插入序迭代，先删最旧的，保证内存有界。
    const oldest = notified.values().next().value
    if (oldest !== undefined) notified.delete(oldest)
  }

  /** 工具名 → 事件类型。 */
  function eventTypeFor(toolName: string): BeaconEventType {
    return toolName === 'exit_plan_mode' ? 'plan_confirmation' : 'user_question'
  }

  /** 从 exit_plan_mode 的原始参数中尽力提取计划正文做 summary。 */
  function planSummary(rawArgs: string): string {
    try {
      const args = JSON.parse(rawArgs) as { plan?: unknown }
      if (typeof args.plan === 'string' && args.plan) return `等待确认计划：${args.plan}`
    } catch {
      /* 参数不是合法 JSON 就用兜底文案 */
    }
    return 'Agent 提交了计划，等待确认'
  }

  /** 把 questions 数组压成一行可读文本：问题（选项1/选项2）；…… */
  function questionsSummary(questions: readonly AskUserQuestionItem[]): string {
    if (questions.length === 0) return 'Agent 正在等待你的输入'
    const parts = questions.map((q) => {
      const options = q.options?.map((o) => o.label).join('/')
      return options ? `${q.question}（${options}）` : q.question
    })
    return parts.join('；')
  }

  /** 从 content blocks 中拼出纯文本（只取 type === 'text' 的块）。 */
  function textOfContent(
    content: readonly { readonly type: string; readonly text?: string }[],
  ): string {
    return content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join(' ')
  }

  /**
   * 渲染 payloadTemplate 并校验结果是合法 JSON。
   * 只替换已知变量（JSON 字符串转义防注入）；未知的 {{xxx}} 原样保留。
   * 非法 JSON 记录错误并返回 undefined（跳过本次发送）。
   */
  function render(
    eventType: BeaconEventType,
    summary: string,
    sessionId: string,
  ): string | undefined {
    const vars: Record<string, string> = {
      eventType,
      summary,
      sessionId,
      time: formatTime(new Date()),
    }
    const body = read(config.payloadTemplate).replace(
      /\{\{\s*(eventType|summary|sessionId|time)\s*\}\}/g,
      (_match, key: keyof typeof vars) => JSON.stringify(vars[key]).slice(1, -1),
    )
    try {
      JSON.parse(body)
    } catch (err) {
      log('error', `payloadTemplate 渲染后不是合法 JSON，已跳过本次发送：${message(err)}`)
      return undefined
    }
    return body
  }

  /** fire-and-forget 发送：任何失败只记日志，绝不向外抛。 */
  async function sendWebhook(url: string, body: string): Promise<void> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: read(config.headers),
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      // 消费响应体，及时释放连接。
      await response.text().catch(() => '')
      if (response.ok) {
        log('debug', `webhook 已发送：${body.slice(0, 300)}`)
      } else {
        log('warn', `webhook 返回非 2xx：HTTP ${response.status}`)
      }
    } catch (err) {
      log('warn', `webhook 发送失败：${message(err)}`)
    }
  }

  /** 记录一次发送时刻；表过大时先清掉过期项，保证长期运行内存有界。 */
  function recordRecent(key: string, now: number): void {
    recent.set(key, now)
    if (recent.size <= 1024) return
    for (const [k, t] of recent) {
      if (now - t >= read(config.dedupWindowMs)) recent.delete(k)
    }
  }

  /**
   * 唯一的发送入口：开关过滤 → 渲染校验 → 幂等去重 → 发送。
   * 多条触发路径（主路径 / 兜底）靠 `sessionId|eventType` + 时间窗合并成一次。
   */
  function fire(eventType: BeaconEventType, summary: string, sessionId: string): void {
    // 每次发送前重新读一遍 URL：配置是 volatile 的，用户在设置页保存后
    // 插件不重启，若在这里缓存 apply 时的值就永远读不到新地址。
    const url = read(config.webhookUrl)
    if (!url) {
      log('debug', 'webhookUrl 为空，已跳过本次发送')
      return
    }
    if (eventType === 'user_question' && !read(config.triggerOnUserQuestion)) return
    const body = render(eventType, clamp(summary), sessionId)
    if (body === undefined) return
    const now = Date.now()
    const key = `${sessionId}|${eventType}`
    const window = read(config.dedupWindowMs)
    const last = recent.get(key)
    if (last !== undefined && now - last < window) {
      log('debug', `去重跳过：${key}（距上次 ${now - last}ms < ${window}ms）`)
      return
    }
    recordRecent(key, now)
    void sendWebhook(url, body)
  }

  // ---------------------------------------------------------------- 触发点

  /**
   * 任务完成（权威路径）：agent 状态转入 idle。
   * 这里同步检查跳过开关——子代理完成不打扰用户。
   */
  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    statuses.set(agent.id, status)
    if (status !== 'idle') return
    if (read(config.skipSubagents) && agent.session.header.origin === 'subagent') return
    fire('task_completed', lastAssistant.get(agent.id) ?? '任务已完成', agent.id)
  })

  /** agent 下线后清理内存状态。 */
  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    statuses.delete(agent.id)
    lastAssistant.delete(agent.id)
  })

  /**
   * 用户提问 / 计划确认（权威路径，waterfall）。
   * 必须同步 `return next()` 把应答链传下去；发送逻辑包在 try 里，
   * 保证任何异常都不会打断 waterfall。
   *
   * 这里不按 `triggerOnUserQuestion` 整体短路：计划确认不受该开关影响，
   * 而 `fire()` 只对 `user_question` 做这个过滤。
   */
  ctx.on('user-questions/request', (request: AskUserQuestionRequestEvent, next) => {
    try {
      const planReview = request.questions.some((q) => q.intent?.kind === 'plan-review')
      fire(
        planReview ? 'plan_confirmation' : 'user_question',
        questionsSummary(request.questions),
        request.agent?.id ?? '',
      )
      // 该 callId 已由主路径覆盖（无论最终是否发送）：作废可能残留的
      // tool/call 兜底，防止应答迟到后重发。
      if (request.wait?.callId) coverCall(request.wait.callId)
    } catch (err) {
      log('error', `处理 user-questions/request 出错：${message(err)}`)
    }
    return next()
  })

  /**
   * 工具审批（权威路径，waterfall）。审批一律发送（含子代理）：
   * 它在等真人拍板，不能被 skipSubagents 过滤。
   */
  ctx.on('approval/request', (req: ApprovalRequestEvent, next) => {
    try {
      const summary = req.reason
        ? `需要批准 ${req.toolName}：${req.reason}`
        : `需要批准工具调用：${req.toolName}`
      fire('approval_request', summary, req.agent.id)
    } catch (err) {
      log('error', `处理 approval/request 出错：${message(err)}`)
    }
    return next()
  })

  /**
   * 会话事件流：assistant 文本缓存、turn/end 完成兜底、
   * ask_user_question / exit_plan_mode 的工具级兜底。
   */
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      handleSessionEvent(session, event)
    } catch (err) {
      log('error', `处理 session/event 出错：${message(err)}`)
    }
  })

  function handleSessionEvent(session: Session, event: SessionEvent): void {
    const sessionId = session.id
    switch (event.type) {
      case 'assistant/message': {
        // 缓存最后一条 assistant 文本，任务完成时作为 {{summary}}。
        const text = textOfContent(event.data.message.content)
        if (text) lastAssistant.set(sessionId, text)
        return
      }
      case 'turn/end': {
        if (read(config.skipSubagents) && session.header.origin === 'subagent') return
        // 该 agent 已有 agent/status 权威信号 → 完成通知交给它；
        // 这里只兜底拿不到状态的场景（如插件中途加载）。
        if (statuses.has(sessionId)) return
        schedule(() => {
          // 这 1s 内出现了权威信号就让位，否则由兜底发送（两条路径靠去重合并）。
          if (statuses.has(sessionId)) return
          fire('task_completed', lastAssistant.get(sessionId) ?? '任务已完成', sessionId)
        }, TURN_END_DELAY_MS)
        return
      }
      case 'tool/call': {
        const { callId, name, arguments: rawArgs } = event.data
        if (name !== 'ask_user_question' && name !== 'exit_plan_mode') return
        // 提问开关关闭时连兜底定时器都不注册；子代理的工具路径直接跳过
        // （未入 pendingCalls，后续 tool/result 也无从触发）。
        if (name === 'ask_user_question' && !read(config.triggerOnUserQuestion)) return
        if (read(config.skipSubagents) && session.header.origin === 'subagent') return
        const summary =
          name === 'exit_plan_mode' ? planSummary(rawArgs) : 'Agent 正在等待你的选择'
        trackCall(callId, { toolName: name, summary })
        const timer = schedule(() => {
          fallbackTimers.delete(callId)
          fire(eventTypeFor(name), summary, sessionId)
          // 无论本次是真发还是被去重合并，该 call 都算已覆盖。
          coverCall(callId)
        }, FALLBACK_DELAY_MS)
        fallbackTimers.set(callId, timer)
        return
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const info = pendingCalls.get(callId)
        if (info === undefined) return
        pendingCalls.delete(callId)
        if (notified.has(callId)) {
          // waterfall 或兜底已处理过：只清理残留状态，绝不重发。
          notified.delete(callId)
          cancelFallback(callId)
          return
        }
        // 结果先于 500ms 兜底到达：直接发送并取消兜底定时器（避免双发）。
        cancelFallback(callId)
        fire(eventTypeFor(info.toolName), info.summary, sessionId)
        return
      }
      default:
        return
    }
  }
}
