/**
 * dsh-beacon 的浏览器端：插件管理页里那一节配置表单。
 *
 * 走的是官方插件同一套机制：
 *   - 宿主半边 `src/index.ts` 的 `Config` 全部标了 `.volatile()`，
 *     `dsh-settings.describe()` 因此自动把它收进设置镜像（命名空间 = Loader
 *     条目 id = `dsh-beacon`），schema 与当前值都从镜像里读；
 *   - `configForms.whileServed([ENTRY_ID], …)` 只在宿主真正在提供该命名空间
 *     时才注册插槽——部署里没装宿主半边时，页面上一点痕迹都不会留；
 *   - 注册进 `plugins.bundle.config`（按包名 keyed），配置显示在插件管理页
 *     的 bundle 详情页上，位于描述与 rows 之间；
 *   - 表单用官方 `SettingsFormModel` + `SettingsForm`：编辑先暂存，只有点
 *     「保存」才写回，离开页面自动丢弃。
 *
 * 双槽/双挂载点只注册 `plugins.bundle.config` 一个：它是「一个 bundle 自己的
 * 配置」的官方归属位置（`plugins.item` 的契约里明确写了 bundle 的配置放
 * `plugins.bundle.config` 或 `plugins.row.config`）。
 *
 * 由 `package.json` 的 `dsh.client` 声明，`npm run build` 用 esbuild 打成
 * ModuleLoader 能加载的 `lib/client.js`。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CSSProperties } from 'react'
import {
  SettingsForm,
  SettingsFormModel,
  SettingsValueField,
  Switch,
  settingsNumberField,
  settingsTextField,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  SettingsFieldSpec,
  SettingsFieldState,
  SettingsFormActions,
  SettingsFormScope,
  SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

// ---------------------------------------------------------------- 服务形状

/**
 * 本包只声明自己用得到的两个服务形状，不去 import 官方客户端包的类型：
 * `@deepseek-ai/dsh-api-remotes`（ui-settings 的类型链依赖它）没有与
 * 0.2.0-rc.2 同步的发布版本。两者都是结构化子集，运行时传进来的对象是超集。
 */
interface SlotEntryOptions {
  name: string
  /** keyed 插槽的键：这里用包名。 */
  key?: string
  /** list 插槽的 id。 */
  id?: string
  order?: number
  priority?: number
  label?: () => string
  /** 由 renderer 调用，返回的 face 会转成组件 props（`hooks.x` → `useX`）。 */
  inject?: () => object
}

interface SlotRegistryService {
  /** 插槽被声明后再执行注册；返回的函数注销本次贡献。 */
  inject(key: string, register: () => (() => void) | Iterable<() => void>): () => void
  register(options: SlotEntryOptions, component: unknown): () => void
}

interface ConfigFormsService {
  /** 按 Loader 条目 id 取该命名空间的表单（读镜像 + 写队列）。 */
  get<T>(entryId: string): SettingsFormScope<T>
  /** 宿主任提供这些命名空间之一时才注册；全部不再提供时自动注销。 */
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotRegistryService
    configForms: ConfigFormsService
  }
}

// ---------------------------------------------------------------- 常量与文案

/** Loader 条目 id = 设置命名空间 = 插件包名（三者恰好一致）。 */
const ENTRY_ID = 'dsh-beacon'
/** `plugins.bundle.config` 的键：bundle 的包名。 */
const BUNDLE_KEY = 'dsh-beacon'
/** 注册的插槽名。 */
const CONFIG_SLOT = 'plugins.bundle.config'

/** `SettingsForm` 框架自带文案（读-only 提示、保存按钮等）。 */
const FORM_LABELS = {
  unavailable: '设置暂不可用：宿主没有提供这个命名空间。',
  readOnly: '当前部署以只读方式保存设置。',
  saveFailed: '保存未被接受，请检查取值后重试。',
  save: '保存',
  saving: '保存中…',
}
/** 覆盖徽标与「恢复默认」按钮。 */
const OVERRIDDEN_LABEL = '已覆盖默认值'
const RESET_LABEL = '恢复默认'
/** 草稿非法时替代 hint 显示。 */
const INVALID_LABEL = '这个值不合法，保存被拦下了。'

/** 一页说明：`view === 'summary'` 时插件管理页只要这一行。 */
const DESCRIPTION = '任务完成、Agent 提问、计划确认、工具审批时向预设地址推送提醒。'

/** 与宿主 `Config` 同构的 section 视图（describe 镜像里已是普通值）。 */
interface BeaconConfig {
  webhookUrl: string
  payloadTemplate: string
  headers: Record<string, string>
  triggerOnUserQuestion: boolean
  dedupWindowMs: number
  skipSubagents: boolean
}

/** 表单投影：框架壳 + 六个字段的草稿状态。 */
type BeaconCardState = SettingsFormShell & {
  webhookUrl: SettingsFieldState
  payloadTemplate: SettingsFieldState
  headers: SettingsFieldState
  triggerOnUserQuestion: SettingsFieldState
  dedupWindowMs: SettingsFieldState
  skipSubagents: SettingsFieldState
}

// ---------------------------------------------------------------- 字段转换

/** 布尔字段：草稿就是 `"true"` / `"false"`，与官方 `settingsTextField` 同一套语义。 */
function booleanSpec(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      if (text === 'true') return { kind: 'set', value: true }
      if (text === 'false') return { kind: 'set', value: false }
      return undefined
    },
  }
}

/** 请求头字段：草稿是 JSON 对象字面量；清空即恢复 schema 默认值。 */
const headersSpec: SettingsFieldSpec = {
  field: 'headers',
  format: (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? JSON.stringify(value)
      : '',
  parse: (text) => {
    if (text.trim() === '') return { kind: 'clear' }
    try {
      const parsed: unknown = JSON.parse(text)
      const isStringDict =
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Object.values(parsed as Record<string, unknown>).every((v) => typeof v === 'string')
      if (isStringDict) return { kind: 'set', value: parsed }
    } catch {
      /* 非法 JSON → undefined，草稿被标为 invalid 并拦下保存 */
    }
    return undefined
  },
}

// ---------------------------------------------------------------- 内联样式

/**
 * 直接抄 `dsh-client-ui-primitives` 的 `fields.module.css`，改用全局 `--dsw-*`
 * 设计令牌内联：CSS module 的类名在各自 bundle 里是哈希过的，跨包拿不到。
 */
const divider: CSSProperties = { borderTop: '0.5px solid var(--dsw-alias-border-l2)' }
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' }
const label: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-primary)',
}
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const hint: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary)',
}
const invalidText: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-state-error-primary)',
}
const badges: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 }
const badge: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' }
const reset: CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
}

/** 覆盖徽标 +「恢复默认」按钮：多行文本字段与开关行共用。 */
function OverrideBadges(props: {
  overridden: boolean
  disabled: boolean
  onReset: () => void
}) {
  return (
    <div style={badges}>
      {props.overridden ? <span style={badge}>{OVERRIDDEN_LABEL}</span> : null}
      <button
        type="button"
        style={reset}
        disabled={props.disabled || !props.overridden}
        onClick={props.onReset}
      >
        {RESET_LABEL}
      </button>
    </div>
  )
}

/** 多行文本框（模板 / 请求头）：单行 input 装不下一段 JSON。 */
function TextareaField(props: {
  id: string
  label: string
  hint: string
  text: string
  overridden: boolean
  invalid: boolean
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  rows?: number
  /** 与上一个字段之间画分隔线（官方 `.field + .field` 只认自己的类名）。 */
  spaced?: boolean
}) {
  const { id, invalid, disabled } = props
  const hintId = `${id}-hint`
  return (
    <div style={{ ...field, ...(props.spaced === true ? divider : null) }}>
      <div style={head}>
        <label style={{ ...label, flex: '1 1 auto', minWidth: 0 }} htmlFor={id}>
          {props.label}
        </label>
        <OverrideBadges
          overridden={props.overridden}
          disabled={disabled}
          onReset={props.onReset}
        />
      </div>
      <textarea
        id={id}
        rows={props.rows ?? 4}
        spellCheck={false}
        aria-invalid={invalid}
        aria-describedby={hintId}
        disabled={disabled}
        value={props.text}
        onChange={(event) => props.onEdit(event.target.value)}
        onFocus={(event) => {
          event.target.style.borderColor = 'var(--dsw-alias-state-business-primary)'
        }}
        onBlur={(event) => {
          event.target.style.borderColor = invalid
            ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-border-l4)'
        }}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 12px',
          border: `0.5px solid var(${invalid ? '--dsw-alias-state-error-primary' : '--dsw-alias-border-l4'})`,
          borderRadius: 'var(--dsw-radius-md)',
          background: 'var(--dsw-alias-bg-layer-3)',
          fontFamily: 'inherit',
          fontSize: 13,
          lineHeight: 1.5,
          color: 'var(--dsw-alias-label-primary)',
          resize: 'vertical',
        }}
      />
      <p id={hintId} style={invalid ? invalidText : hint}>
        {invalid ? INVALID_LABEL : props.hint}
      </p>
    </div>
  )
}

/** 开关行：label + Switch + hint +（若被覆盖）恢复默认。 */
function ToggleField(props: {
  id: string
  label: string
  hint: string
  checked: boolean
  overridden: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
  onReset: () => void
  spaced?: boolean
}) {
  return (
    <div style={{ ...field, ...(props.spaced === true ? divider : null) }}>
      <div style={head}>
        <span id={props.id} style={{ ...label, flex: '1 1 auto', minWidth: 0 }}>
          {props.label}
        </span>
        <OverrideBadges
          overridden={props.overridden}
          disabled={props.disabled}
          onReset={props.onReset}
        />
        <Switch
          checked={props.checked}
          label={props.label}
          disabled={props.disabled}
          onChange={props.onToggle}
        />
      </div>
      <p style={hint}>{props.hint}</p>
    </div>
  )
}

// ---------------------------------------------------------------- 控制器

/**
 * 一个 namespace 的暂存表单模型，加上它投影出的快照 store。
 * store 在构造时 `bind` 一次并复用：反复 `bind` 会在同一个 form 上叠加订阅，
 * 每次进出详情页都泄漏一份。
 */
class BeaconController {
  private readonly form: SettingsFormModel<BeaconConfig>
  private readonly store

  constructor(scope: SettingsFormScope<BeaconConfig>) {
    this.form = new SettingsFormModel<BeaconConfig>(scope, [
      settingsTextField('webhookUrl'),
      settingsTextField('payloadTemplate'),
      headersSpec,
      booleanSpec('triggerOnUserQuestion'),
      settingsNumberField('dedupWindowMs'),
      booleanSpec('skipSubagents'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  /** 把 shell 与六个字段一起投影成一个可被 selector 读的快照。 */
  private projection() {
    return {
      ...this.form.shell(),
      webhookUrl: this.form.field('webhookUrl'),
      payloadTemplate: this.form.field('payloadTemplate'),
      headers: this.form.field('headers'),
      triggerOnUserQuestion: this.form.field('triggerOnUserQuestion'),
      dedupWindowMs: this.form.field('dedupWindowMs'),
      skipSubagents: this.form.field('skipSubagents'),
    }
  }

  /** 插槽 entry 的 inject face：`hooks.beaconCard` → 组件的 `useBeaconCard`。 */
  face() {
    return {
      hooks: { beaconCard: this.store },
      ...this.form.actions(),
    }
  }

  dispose(): void {
    this.form.dispose()
  }
}

// ---------------------------------------------------------------- 组件

/**
 * 插槽组件。`view` 来自插件管理页：`summary` 只要一行说明，
 * `page` 渲染完整表单（`SettingsForm` 自带保存、只读与不可用态）。
 */
function BeaconCard(props: {
  view?: 'summary' | 'page'
  useBeaconCard: (selector: (value: BeaconCardState) => BeaconCardState) => BeaconCardState
  edit: SettingsFormActions['edit']
  resetField: SettingsFormActions['resetField']
  save: SettingsFormActions['save']
  discard: SettingsFormActions['discard']
}) {
  const state = props.useBeaconCard((value) => value)
  if (props.view === 'summary') return <>{DESCRIPTION}</>
  const disabled = !state.writable || state.saving
  const edit =
    (field: keyof BeaconConfig) =>
    (text: string): void => {
      props.edit(field, text)
    }
  const reset = (field: keyof BeaconConfig) => (): void => {
    props.resetField(field)
  }

  return (
    <SettingsForm
      labels={FORM_LABELS}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SettingsValueField
        id="plugin-config-dsh-beacon-url"
        label="Webhook 地址"
        hint="任务完成、提问、计划确认、审批时向这里 POST 一条 JSON。留空则不发送。"
        overriddenLabel={OVERRIDDEN_LABEL}
        resetLabel={RESET_LABEL}
        invalidLabel={INVALID_LABEL}
        disabled={disabled}
        {...state.webhookUrl}
        onEdit={edit('webhookUrl')}
        onReset={reset('webhookUrl')}
      />
      <TextareaField
        id="plugin-config-dsh-beacon-template"
        label="Payload 模板"
        hint="支持 {{eventType}} / {{summary}} / {{sessionId}} / {{time}}；渲染结果必须是合法 JSON。"
        rows={5}
        spaced
        disabled={disabled}
        {...state.payloadTemplate}
        onEdit={edit('payloadTemplate')}
        onReset={reset('payloadTemplate')}
      />
      <TextareaField
        id="plugin-config-dsh-beacon-headers"
        label="请求头（JSON 对象）"
        hint='形如 {"Content-Type":"application/json"}；清空即恢复默认。'
        rows={3}
        spaced
        disabled={disabled}
        {...state.headers}
        onEdit={edit('headers')}
        onReset={reset('headers')}
      />
      <ToggleField
        id="plugin-config-dsh-beacon-question"
        label="提问时提醒"
        hint="Agent 向用户提问时推送；计划确认与审批不受这个开关影响。"
        spaced
        checked={state.triggerOnUserQuestion.text === 'true'}
        overridden={state.triggerOnUserQuestion.overridden}
        disabled={disabled}
        onToggle={(next) => edit('triggerOnUserQuestion')(String(next))}
        onReset={reset('triggerOnUserQuestion')}
      />
      <ToggleField
        id="plugin-config-dsh-beacon-subagents"
        label="跳过子代理"
        hint="子代理的任务完成与工具路径通知不推送；审批与提问不过滤。"
        spaced
        checked={state.skipSubagents.text === 'true'}
        overridden={state.skipSubagents.overridden}
        disabled={disabled}
        onToggle={(next) => edit('skipSubagents')(String(next))}
        onReset={reset('skipSubagents')}
      />
      <div style={divider}>
        <SettingsValueField
          id="plugin-config-dsh-beacon-dedup"
          label="去重窗口（毫秒）"
          hint="同一会话同一事件类型在窗口内只发一次。"
          numeric
          overriddenLabel={OVERRIDDEN_LABEL}
          resetLabel={RESET_LABEL}
          invalidLabel={INVALID_LABEL}
          disabled={disabled}
          {...state.dedupWindowMs}
          onEdit={edit('dedupWindowMs')}
          onReset={reset('dedupWindowMs')}
        />
      </div>
    </SettingsForm>
  )
}

// ---------------------------------------------------------------- 入口

/** 服务注入：插槽注册与设置表单。 */
export const inject = ['slots', 'configForms']

/**
 * 挂上配置页：宿主一提供 `dsh-beacon` 命名空间就注册进 `plugins.bundle.config`，
 * 停止提供时自动注销。表单模型与宿主 fiber 同生命周期，卸载时释放订阅。
 */
export function apply(ctx: Context): void {
  const controller = new BeaconController(ctx.configForms.get<BeaconConfig>(ENTRY_ID))
  ctx.effect(() => () => controller.dispose(), 'dsh-beacon: settings form')
  ctx.effect(
    () =>
      ctx.configForms.whileServed([ENTRY_ID], () =>
        ctx.slots.inject(
          CONFIG_SLOT,
          () =>
            ctx.slots.register(
              { name: CONFIG_SLOT, key: BUNDLE_KEY, inject: () => controller.face() },
              BeaconCard,
            ),
        ),
      ),
    'dsh-beacon: plugin config page',
  )
}
