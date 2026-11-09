/**
 * dsh-schedule-admin 自测：桩掉 ctx / tools / schedule，验证注册与行为契约。
 * 跑法：node test/selftest.mjs   —— 不需要重启 DSH、不需要真的动任何任务。
 *
 * 覆盖的断言：
 *   1. 只用具名导出（name / inject / apply），没有 default。
 *   2. 三个工具都注册了，且每个都有 output.render（DSH 硬要求）。
 *   3. list 走 catalog()，能看到别的会话的任务。
 *   4. delete 缺 confirm → 拒绝且 schedule.delete 一次都没被调用。
 *   5. delete 带 confirm → 用 catalog 反查出的 sessionId 调服务，而不是调用者会话。
 *   6. delete 不存在的 id → schedule_not_found，且不调用 delete。
 *   7. update 会先 list({sessionId}) 取 expected，再带 expected 调 update。
 *   8. update 两个字段都没给 → nothing_to_change。
 *   9. 服务抛异常 → 返回 ok:false，绝不 throw。
 *  10. render 的返回值是 content blocks 数组。
 */

import assert from 'node:assert/strict'

const mod = await import('../index.js')

const OWN_SESSION = 'session-own-0000'
const OTHER_SESSION = 'session-11111111-2222-3333-4444-555555555555'
const TASK_ID = 'schedule-baaf7905-test'

let pass = 0
const ok = (cond, label) => {
  assert.ok(cond, label)
  pass++
  console.log(`  ✓ ${label}`)
}

// --- 1. 导出形态 -----------------------------------------------------------
ok(!('default' in mod), '没有 default 导出（避免 unwrapExports 丢 name/inject）')
ok(mod.name === 'dsh-schedule-admin', 'name 正确')
ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 含 tools')
ok(typeof mod.apply === 'function', 'apply 是函数')

// --- 桩 -------------------------------------------------------------------
function makeStub({ throwOn = null } = {}) {
  const calls = { catalog: 0, list: [], update: [], delete: [] }
  const schedule = {
    async catalog() {
      calls.catalog++
      return [
        { id: TASK_ID, sessionId: OTHER_SESSION, title: '每日保活任务', status: 'active', kind: 'daily' },
        { id: 'schedule-own', sessionId: OWN_SESSION, title: '自己的提醒', status: 'active', kind: 'after' },
      ]
    },
    async list({ sessionId }) {
      calls.list.push(sessionId)
      if (throwOn === 'list') throw new Error('list boom')
      return sessionId === OTHER_SESSION
        ? [{ id: TASK_ID, sessionId: OTHER_SESSION, title: '每日保活任务', status: 'active' }]
        : [{ id: 'schedule-own', sessionId: OWN_SESSION, title: '自己的提醒', status: 'active' }]
    },
    async update(payload) {
      calls.update.push(payload)
      if (throwOn === 'update') throw new Error('update boom')
      return { record: { id: payload.id, sessionId: payload.sessionId, title: payload.title ?? 'x', prompt: payload.prompt ?? 'y' } }
    },
    async delete(payload) {
      calls.delete.push(payload)
      if (throwOn === 'delete') throw new Error('delete boom')
      return { deleted: true }
    },
  }
  const registered = new Map()
  const tools = { register: (def) => registered.set(def.name, def) }
  const ctx = {
    get: (key) => (key === 'tools' ? tools : key === 'schedule' ? schedule : undefined),
  }
  return { ctx, schedule, calls, registered }
}

// --- 2. 注册 ---------------------------------------------------------------
const s1 = makeStub()
mod.apply(s1.ctx)
ok(s1.registered.size === 3, '注册了 3 个工具')
for (const [toolName, def] of s1.registered) {
  ok(typeof def.output?.render === 'function', `${toolName} 有 output.render（DSH 硬要求）`)
  ok(typeof def.execute === 'function', `${toolName} 有 execute`)
  ok(typeof def.description === 'string' && def.description.length > 20, `${toolName} 有像样的描述`)
}

const listTool = s1.registered.get(mod.TOOLS.list)
const updTool = s1.registered.get(mod.TOOLS.update)
const delTool = s1.registered.get(mod.TOOLS.delete)

// --- 3. list 能跨会话 ------------------------------------------------------
const listed = await listTool.execute({})
ok(listed.ok === true && listed.count === 2, 'list 返回两个任务')
ok(listed.tasks.some((t) => t.sessionId === OTHER_SESSION), 'list 能看到别的会话（自动化会话）的任务')
const renderedList = listTool.output.render({}, listed)
ok(Array.isArray(renderedList) && renderedList[0]?.type === 'text', 'list 的 render 返回 content blocks')

// --- 4. delete 缺 confirm ---------------------------------------------------
const noConfirm = await delTool.execute({ id: TASK_ID })
ok(noConfirm.ok === false && noConfirm.code === 'confirm_required', 'delete 缺 confirm 被拒')
ok(s1.calls.delete.length === 0, '缺 confirm 时 schedule.delete 一次都没被调用（零副作用）')

// --- 5. delete 带 confirm 用目标会话 ---------------------------------------
const del = await delTool.execute({ id: TASK_ID, confirm: true })
ok(del.ok === true && del.deleted === true, 'delete 成功')
ok(s1.calls.delete.length === 1, 'delete 被调用一次')
ok(s1.calls.delete[0].sessionId === OTHER_SESSION, '用的是任务真正归属的 sessionId，不是调用者会话 ✅')
ok(s1.calls.delete[0].id === TASK_ID, 'id 原样传下去')

// --- 6. delete 不存在的 id -------------------------------------------------
const s2 = makeStub()
mod.apply(s2.ctx)
const miss = await s2.registered.get(mod.TOOLS.delete).execute({ id: 'schedule-nope', confirm: true })
ok(miss.ok === false && miss.code === 'schedule_not_found', '不存在的 id → schedule_not_found')
ok(s2.calls.delete.length === 0, '找不到时也没调用 delete')

// --- 7. update 带 expected -------------------------------------------------
const s3 = makeStub()
mod.apply(s3.ctx)
const upd = await s3.registered.get(mod.TOOLS.update).execute({ id: TASK_ID, title: '新标题' })
ok(upd.ok === true, 'update 成功')
ok(s3.calls.list[0] === OTHER_SESSION, 'update 先按目标会话 list 取基线')
ok(s3.calls.update.length === 1 && s3.calls.update[0].expected !== undefined, 'update 带了 expected（乐观并发）')
ok(s3.calls.update[0].title === '新标题' && s3.calls.update[0].prompt === undefined, '只改了给的字段')
ok(s3.calls.update[0].sessionId === OTHER_SESSION, 'update 用的是目标会话')

// --- 8. update 空改动 ------------------------------------------------------
const empty = await updTool.execute({ id: TASK_ID })
ok(empty.ok === false && empty.code === 'nothing_to_change', 'update 两个字段都没给 → nothing_to_change')

// --- 9. 服务抛异常不冒泡 ---------------------------------------------------
const s4 = makeStub({ throwOn: 'delete' })
mod.apply(s4.ctx)
const boom = await s4.registered.get(mod.TOOLS.delete).execute({ id: TASK_ID, confirm: true })
ok(boom.ok === false && boom.code === 'delete_failed', '服务抛异常 → 结构化失败，不 throw')
const boomRender = s4.registered.get(mod.TOOLS.delete).output.render({}, boom)
ok(Array.isArray(boomRender), '失败态 render 也返回数组')

// --- 10. 非法 id ----------------------------------------------------------
const badId = await delTool.execute({ id: '  ', confirm: true })
ok(badId.ok === false && badId.code === 'bad_id', '空 id 被拒')
const spaceId = await delTool.execute({ id: 'a b', confirm: true })
ok(spaceId.ok === false && spaceId.code === 'bad_id', '含空白 id 被拒')

// --- 11. 没有 schedule 服务时不注册也不抛 ----------------------------------
const toolsOnly = { register: () => { throw new Error('不该被调用') } }
let threw = false
try {
  mod.apply({ get: (k) => (k === 'tools' ? toolsOnly : undefined) })
} catch {
  threw = true
}
ok(!threw, '拿不到 schedule 服务时不抛异常也不注册')

console.log(`\n全部通过：${pass} 项断言`)
