/**
 * dsh-schedule-admin —— 跨会话的定时任务管理工具（list / update / delete）
 *
 * 为什么需要它：
 *   官方 `@deepseek-ai/dsh-tool-schedule` 的 list/delete/update 全部硬绑
 *   `agent.session.id`（源码 dsh-tool-schedule/lib/index.js L562/L593/L636），
 *   所以任何一个会话只能管"自己名下"的提醒。而自动化任务（automation-zone 建的那些）
 *   挂在一条独立的自动化会话上，业务会话永远够不到 —— 想停掉一个自动化任务，
 *   只能请人去界面上点。
 *
 *   但服务层不是这样：`ctx.schedule.delete({ sessionId, id })` 只要给得出 sessionId
 *   就能删任意会话的任务，`ctx.schedule.catalog()` 能列全部（官方 update 就是用
 *   catalog 去区分 schedule_ended / schedule_not_found 的）。本插件只把这一层
 *   包成模型可调的工具，不发明新机制。
 *
 * 安全设计：
 *   1. delete 必须显式 confirm:true，缺了直接拒绝且零副作用。
 *   2. 只按 id 精确操作，不接受通配/批量；id 必须非空且不含空白。
 *   3. 全部 fail-open：任何异常都变成结构化错误返回，绝不 throw（红线：
 *      工具里抛异常会打断整个回合）。
 *   4. 不写配置文件、不碰 storages\schedule.json —— 只走服务层，避免踩
 *      "手改 schedule.json 被内存副本覆盖" 那个坑。
 *
 * 契约来源：@local/dsh-edit-and-check 的实测笔记 + asar 里官方插件源码。
 *   - 只用具名导出（name / inject / apply），绝不 `export default`。
 *   - tools.register 的 output.render 是硬要求，缺了直接 TypeError。
 *   - render 的调用形态是 render(args, value)，返回值必须是 content blocks 数组。
 *   - ctx.schedule.update 需要 `expected`（该会话里当前的 record）做乐观并发。
 */

export const name = 'dsh-schedule-admin'

/** tools 是硬依赖；schedule 在 apply 里按作用域解析（可能被宿主编排关掉）。 */
export const inject = ['tools']

export const TOOLS = {
  list: 'schedule_admin_list',
  update: 'schedule_admin_update',
  delete: 'schedule_admin_delete',
}

/**
 * output.schema：tools.register 要求每个工具的 output 必须带一组标准 JSON Schema
 * （`output: { schema, render }`）。缺了 schema，注册会报
 * 「unsupported JSON schema: schema must be a schema object」并**静默失败**——工具直接不出现。
 * 这里列全 execute 可能返回的顶层字段，additionalProperties:true 放行额外键，
 * 数组字段（tasks/changed）只校验是 array、不深入 items，避免任务里 null 字段触发校验失败。
 */
const SCHEDULE_ADMIN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    count: { type: 'integer' },
    tasks: { type: 'array' },
    code: { type: 'string' },
    error: { type: 'string' },
    id: { type: 'string' },
    sessionId: { type: 'string' },
    changed: { type: 'array' },
    result: { type: 'string' },
    deleted: { type: 'boolean' },
  },
  required: ['ok'],
  additionalProperties: true,
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errText(err) {
  if (err === null || err === undefined) return '未知错误'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || String(err)
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function text(line) {
  return [{ type: 'text', text: String(line) }]
}

function clamp(s, n) {
  const str = typeof s === 'string' ? s : String(s ?? '')
  return str.length > n ? `${str.slice(0, n)}…` : str
}

/** id 校验：非空、无首尾空白、不含内部空白（防止误传一整行）。 */
function normalizeId(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'id 必须是字符串' }
  const id = raw.trim()
  if (id.length === 0) return { ok: false, error: 'id 不能为空' }
  if (/\s/.test(id)) return { ok: false, error: 'id 不能包含空白字符' }
  return { ok: true, id }
}

/** 从 catalog 里把 id 反查成 sessionId —— 这是跨会话操作的关键一步。 */
async function locate(schedule, id) {
  const catalog = await schedule.catalog()
  const entries = Array.isArray(catalog) ? catalog : []
  const hit = entries.find((entry) => entry && entry.id === id)
  if (hit === undefined) {
    return { ok: false, code: 'schedule_not_found', error: `没有 id 为 ${id} 的定时任务（可能已被删除）` }
  }
  if (typeof hit.sessionId !== 'string' || hit.sessionId.length === 0) {
    return { ok: false, code: 'schedule_no_session', error: `任务 ${id} 没有归属会话，拒绝操作` }
  }
  return { ok: true, entry: hit, sessionId: hit.sessionId }
}

function summarizeEntry(entry) {
  const title = clamp(entry.title ?? entry.name ?? '(无标题)', 42)
  const status = entry.status ?? '?'
  const sid = typeof entry.sessionId === 'string' ? entry.sessionId.replace(/^session-/, '') : '?'
  return `${entry.id}  [${status}]  ${title}  ← 会话 ${sid.slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const LIST_DESCRIPTION =
  '列出这台机器上**所有会话**的定时任务（含其它会话名下的自动化任务）。' +
  '官方 schedule_list 只返回当前会话的提醒，看不到自动化任务；要停/改别人的任务先用这个拿到 id。'

const UPDATE_DESCRIPTION =
  '跨会话修改一个定时任务的标题或提示词（按 id 精确定位，不需要知道它属于哪个会话）。' +
  '只改你显式给出的字段。不能改时间表达（那是 schedule_update 的事），也不能改 sessionId。'

const DELETE_DESCRIPTION =
  '跨会话**删除**一个定时任务（按 id 精确定位）。这是不可逆操作：必须显式传 confirm=true，' +
  '否则直接拒绝且不产生任何副作用。删除会同时移除它的投递历史。'

function registerWith({ tools, schedule, warn }) {
  // ---- list -------------------------------------------------------------
  tools.register({
    name: TOOLS.list,
    description: LIST_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: SCHEDULE_ADMIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        try {
          const v = value !== null && typeof value === 'object' ? value : {}
          if (v.ok === false) return text(`列出失败：${v.error ?? '未知错误'}`)
          const tasks = Array.isArray(v.tasks) ? v.tasks : []
          if (tasks.length === 0) return text('没有任何定时任务。')
          const lines = [`共 ${tasks.length} 个定时任务：`]
          for (const t of tasks) lines.push(`  ${summarizeEntry(t)}`)
          return text(lines.join('\n'))
        } catch (err) {
          return text(`schedule_admin_list 渲染失败：${errText(err)}`)
        }
      },
    },
    async execute() {
      try {
        const catalog = await schedule.catalog()
        const tasks = (Array.isArray(catalog) ? catalog : []).map((entry) => ({
          id: entry.id,
          sessionId: entry.sessionId,
          title: entry.title ?? entry.name ?? null,
          status: entry.status ?? null,
          kind: entry.kind ?? null,
          scheduledAt: entry.scheduledAt ?? null,
          lastDeliveredAt: entry.lastDeliveredAt ?? null,
        }))
        return { ok: true, count: tasks.length, tasks }
      } catch (err) {
        return { ok: false, code: 'list_failed', error: errText(err) }
      }
    },
  })

  // ---- update -----------------------------------------------------------
  tools.register({
    name: TOOLS.update,
    description: UPDATE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'schedule_admin_list 返回的任务 id。' },
        title: { type: 'string', description: '新的任务名（只改标题时给这个）。' },
        prompt: { type: 'string', description: '新的提示词正文（只改内容时给这个）。' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: SCHEDULE_ADMIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        try {
          const v = value !== null && typeof value === 'object' ? value : {}
          if (v.ok === false) return text(`改失败（${v.code ?? 'error'}）：${v.error ?? '未知错误'}`)
          const changed = Array.isArray(v.changed) ? v.changed.join(' / ') : '?'
          return text(`已改 ${v.id}（会话 ${String(v.sessionId ?? '').replace(/^session-/, '').slice(0, 8)}）：${changed}`)
        } catch (err) {
          return text(`schedule_admin_update 渲染失败：${errText(err)}`)
        }
      },
    },
    async execute(args) {
      try {
        const checked = normalizeId(args?.id)
        if (!checked.ok) return { ok: false, code: 'bad_id', error: checked.error }
        const hasTitle = typeof args?.title === 'string' && args.title.length > 0
        const hasPrompt = typeof args?.prompt === 'string' && args.prompt.length > 0
        if (!hasTitle && !hasPrompt) {
          return { ok: false, code: 'nothing_to_change', error: 'title 和 prompt 至少要给一个' }
        }

        const found = await locate(schedule, checked.id)
        if (!found.ok) return found
        const { sessionId } = found

        // update 需要该会话里"当前这条"的 record 做乐观并发基线
        const listed = await schedule.list({ sessionId })
        const expected = (Array.isArray(listed) ? listed : []).find((record) => record && record.id === checked.id)
        if (expected === undefined) {
          return {
            ok: false,
            code: 'schedule_ended',
            error: '这条任务在目标会话里已经不在活动列表里（已过期/已删除），没法改',
          }
        }

        const payload = { sessionId, id: checked.id, expected }
        if (hasTitle) payload.title = args.title
        if (hasPrompt) payload.prompt = args.prompt
        const result = await schedule.update(payload)

        const changed = []
        if (hasTitle) changed.push('标题')
        if (hasPrompt) changed.push('提示词')
        return { ok: true, id: checked.id, sessionId, changed, result: clamp(JSON.stringify(result ?? null), 400) }
      } catch (err) {
        return { ok: false, code: 'update_failed', error: errText(err) }
      }
    },
  })

  // ---- delete -----------------------------------------------------------
  tools.register({
    name: TOOLS.delete,
    description: DELETE_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'schedule_admin_list 返回的任务 id。' },
        confirm: { type: 'boolean', description: '必须显式传 true 才会真的删除。' },
      },
      required: ['id', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SCHEDULE_ADMIN_OUTPUT_SCHEMA,
      render: (_args, value) => {
        try {
          const v = value !== null && typeof value === 'object' ? value : {}
          if (v.ok === false) return text(`没删（${v.code ?? 'error'}）：${v.error ?? '未知错误'}`)
          return text(`已删除 ${v.id}（原属会话 ${String(v.sessionId ?? '').replace(/^session-/, '').slice(0, 8)}）`)
        } catch (err) {
          return text(`schedule_admin_delete 渲染失败：${errText(err)}`)
        }
      },
    },
    async execute(args) {
      try {
        if (args?.confirm !== true) {
          return { ok: false, code: 'confirm_required', error: '这是不可逆操作，必须显式传 confirm=true' }
        }
        const checked = normalizeId(args?.id)
        if (!checked.ok) return { ok: false, code: 'bad_id', error: checked.error }

        const found = await locate(schedule, checked.id)
        if (!found.ok) return found

        await schedule.delete({ sessionId: found.sessionId, id: checked.id })
        return { ok: true, id: checked.id, sessionId: found.sessionId, deleted: true }
      } catch (err) {
        return { ok: false, code: 'delete_failed', error: errText(err) }
      }
    },
  })

  if (typeof warn === 'function') {
    warn(`[schedule-admin] 已注册 ${Object.values(TOOLS).join(' / ')}（跨会话，delete 需 confirm）`)
  }
}

/**
 * 插件入口。
 * schedule 服务按作用域解析：能直接拿到就立刻挂，拿不到就走 inject 等它出现。
 */
export function apply(ctx) {
  const logger =
    typeof ctx?.get === 'function' && ctx.get('logger', false) !== undefined && ctx.get('logger', false) !== null
      ? ctx.get('logger', false)
      : undefined
  const warn = (msg) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(msg)
      else if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(msg)
    } catch {
      /* 日志失败绝不影响注册 */
    }
  }

  const mount = (scope) => {
    try {
      const tools = typeof scope?.get === 'function' ? scope.get('tools', false) : undefined
      const schedule =
        (typeof scope?.get === 'function' ? scope.get('schedule', false) : undefined) ??
        scope?.schedule
      if (!tools || typeof tools.register !== 'function') {
        warn('[schedule-admin] tools 服务不可用：不注册任何工具')
        return
      }
      if (!schedule || typeof schedule.catalog !== 'function' || typeof schedule.delete !== 'function') {
        warn('[schedule-admin] schedule 服务不可用：不注册任何工具')
        return
      }
      registerWith({ tools, schedule, warn })
    } catch (err) {
      warn(`[schedule-admin] 注册失败（不抛异常）：${errText(err)}`)
    }
  }

  try {
    const direct = typeof ctx?.get === 'function' ? ctx.get('schedule', false) : undefined
    if (direct) return mount(ctx)
    if (typeof ctx?.inject === 'function') return ctx.inject(['schedule'], (scope) => mount(scope))
    warn('[schedule-admin] 拿不到 schedule 服务，也没有 inject：不注册任何工具')
  } catch (err) {
    warn(`[schedule-admin] apply 失败（不抛异常）：${errText(err)}`)
  }
}
