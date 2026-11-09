# dsh-schedule-admin

> Cross-session scheduled-task tools: list every session's tasks, edit title/prompt, and delete behind an explicit confirm gate.

## 这是什么

DeepSeek Harness 自带的定时任务工具（`schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`）有一个共同前提：**它们只作用于当前会话**。宿主侧的 `list` / `update` / `delete` 三个方法都把 `agent.session.id` 硬编码进调用里，模型拿不到、也传不进别的 `sessionId`。

这就造成一个很实际的坑。自动化任务（每天早报、账号池保活、定时巡检这类）并不是挂在你正在聊天的会话上，而是挂在一条**专门的自动化会话**上——那是个你平时根本不会打开的会话。于是：

- 你在工作会话里说「看看都有哪些定时任务」，`schedule_list` 返回空数组；任务其实活得好好的，只是不在「你的」名下。
- 你想停掉某条跑歪的任务，工具说「找不到这个 id」；任务确实存在，只是属于另一条会话。
- 界面里能看到它，但界面上没有「改提示词」这种细粒度操作；想改一句话就得删了重建，重建就换了 id、丢了投递历史。

本插件补的就是这个缺口。它把宿主**服务层**那一层直接包成工具——服务层没有这个限制：`ctx.schedule.catalog()` 能列出**全机器**的定时任务（每条带 `sessionId`），`ctx.schedule.delete({ sessionId, id })` 只要你给得出 `sessionId` 就能删任意会话的任务，`ctx.schedule.update` 同理。插件不发明新机制、不写任何配置文件，只做三件事：列出来、按 id 反查归属、把 `sessionId` 补进调用。

给谁用：需要在一条会话里统管全机器定时任务的人（或者说，让 agent 自己统管）。它和自动化任务插件是互补关系——那个负责「建在哪」，这个负责「建完之后怎么收」。

## 前置条件

**诚实地说明**：这是 **DeepSeek Harness Desktop 的插件**，不是独立 npm 库。它需要宿主提供的 `ctx`（cordis 运行时）以及 `tools` / `schedule` 两个服务；没有宿主，`import` 进来只是一个导出了 `apply` 的空模块，跑不起来任何东西。

具体依赖：

- `tools` 服务（硬依赖，写在 `export const inject = ['tools']` 里）：没有注册器就什么都不做。
- `schedule` 服务（软依赖，`apply` 里按作用域解析）：可能被宿主编排关掉。拿不到时插件只打一条 warning、不注册任何工具，不会让整个装载失败。
- 服务方法：`catalog()` / `list({sessionId})` / `update({sessionId,id,expected,...})` / `delete({sessionId,id})`。

## 安装

DSH 的插件靠「目录 link 进 profile 的 `node_modules` + 在 composition 里加一条」两步生效。以 `<dsh-home>` 表示 DSH 的数据目录（Windows 通常是 `%USERPROFILE%\.dsh-beta`，桌面版 profile 多在 `<dsh-home>\profiles\desktop`）：

```powershell
# 1. 把插件目录链接进 profile 的 node_modules（Windows 用 junction，Mac/Linux 用 ln -s）
$src = '<dsh-home>\plugins\dsh-schedule-admin'
$dst = '<dsh-home>\profiles\desktop\node_modules\@local\dsh-schedule-admin'
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
cmd /c mklink /J "$dst" "$src"
```

```yaml
# 2. 在 profile 的 composition patch 里加一条把它挂上去
#    （或者加进你自用 preset 的 composition，二选一，别重复挂）
- insert:
    - id: dsh-schedule-admin
      name: '@local/dsh-schedule-admin'
```

改 composition 是 **load-once** 的：必须整个 App 重启才会重读。改插件自身的 `index.js` 则可以只重建宿主侧插件（宿主自带刷新按钮），不用请人重启。

装完验证：启动日志里出现

```
[schedule-admin] 已注册 schedule_admin_list / schedule_admin_update / schedule_admin_delete（跨会话，delete 需 confirm）
```

工具没出现时，先翻宿主日志找注册失败原文——`tools.register` 会因为 schema 不合法**静默失败**（`output` 必须是 `{ schema, render }`，只给 `render` 会报 `unsupported JSON schema` 然后工具直接不出现）。

## 配置

**无配置项。** 行为完全由调用参数决定，插件本身不读任何配置文件，也不写任何文件。

## 对外能力

| 工具 | 入参 | 行为 |
|---|---|---|
| `schedule_admin_list` | 无 | 走 `schedule.catalog()` 列出**全机器所有会话**的定时任务，每条给 `id` / `sessionId` / `title` / `status` / `kind` / `scheduledAt` / `lastDeliveredAt`。 |
| `schedule_admin_update` | `id`（必填）、`title?`、`prompt?` | 先用 `catalog()` 把 `id` 反查出真正归属的 `sessionId`，再用 `list({sessionId})` 取该会话里当前这条 record 作为 `expected` 基线，最后带 `expected` 调 `update`。只改你显式给出的字段；两个都不给直接拒绝（`nothing_to_change`）。 |
| `schedule_admin_delete` | `id`（必填）、`confirm`（必填布尔） | 先用 `catalog()` 反查 `sessionId`，再 `delete({sessionId, id})`。**`confirm` 不等于 `true` 时直接拒绝，且一次服务调用都不发**（零副作用）。 |

关键设计：`update` / `delete` 都**不接受** `sessionId` 参数——那是插件自己查出来的。调用方只需要一个 `id`，不用先搞清楚任务属于哪条会话。这一条同时避免了「手滑传错 `sessionId` 就删掉别人任务」的可能。

### 错误码

所有失败都以 `{ ok: false, code, error }` 结构化返回，**绝不 throw**（工具里抛异常会打断整个回合）。

| code | 含义 |
|---|---|
| `confirm_required` | delete 没传 `confirm: true`，什么都没做 |
| `bad_id` | id 为空、非字符串，或含空白字符（防止把一整行描述当 id 传进来） |
| `schedule_not_found` | catalog 里没有这个 id（可能已被删） |
| `schedule_no_session` | 任务存在但没有归属会话，拒绝操作 |
| `schedule_ended` | update 时目标会话的活动列表里已经没有这条（已过期/已删） |
| `nothing_to_change` | update 的 `title` 和 `prompt` 都没给 |
| `list_failed` / `update_failed` / `delete_failed` | 服务层抛出异常，`error` 里是原文 |

## 已知限制

- **不能改时间表达，也不能换绑会话。** 时间（几点、多久一次）归官方 `schedule_update` 管，`sessionId` 归宿主内部管；本插件只改标题与提示词。想「把任务挪到另一条会话」，宿主没有改绑 API，只能新建一条再删旧的——代价是**新任务的 id 会变**，投递历史也会重新开始。
- **删除是不可逆的，且会连投递历史一起删。** 这就是 `confirm: true` 那个闸存在的唯一理由：不看错误码就当成功，是这类工具最容易踩的坑。
- **只按 id 精确操作，没有通配、没有批量。** 不支持「删掉所有以 scheduled- 开头的」。批量删除需要调用方自己循环，还得自己承担误删。
- **不写宿主的状态文件。** 全部走服务层。手改运行态的 schedule 存储会被宿主的内存副本覆盖（它是 load-once 读进来的），这是本插件刻意绕开的一条歧路。
- **`schedule` 服务缺席时工具整体不出现。** 只留一条 warning，不影响其它插件。看到「工具不存在」先确认这个服务在不在，而不是怀疑插件没装上。
- **`catalog()` 给的是摘要，不是完整 record。** `update` 必须再去 `list({sessionId})` 取一次 `expected`——`catalog()` 的字段够列表展示，不够做乐观并发基线。

## 开发

```bash
node test/selftest.mjs      # 或 npm test
```

自测**不依赖 DSH 宿主**：它把 `ctx` / `tools` / `schedule` 全部桩掉，验证注册形态与行为契约，跑完不会碰到任何真实任务。36 条断言，覆盖：

- 只用具名导出（`name` / `inject` / `apply`），没有 `export default`（有 default 会让 unwrapExports 丢掉 `name`）；
- 三个工具都注册成功，且每个都有 `output.render`（宿主硬要求）；
- `list` 能看到**别的会话**的任务；
- delete 缺 `confirm` → 拒绝，且 `schedule.delete` 调用次数为 0；
- delete 带 `confirm` → 用的是任务真正归属的 `sessionId`，不是调用者会话；
- 不存在的 id → `schedule_not_found` 且不发 delete；
- update 先按目标会话 `list` 取 `expected` 再调 `update`，且只改给了的字段；
- 服务抛异常 → 结构化失败，不 throw；render 在失败态也返回 content blocks 数组；
- 拿不到 `schedule` 服务时不抛异常也不注册。

结构很简单，一个文件：

```
index.js            # 全部逻辑：工具定义 + 注册 + 入口
test/selftest.mjs   # 桩驱动自测
```

读的时候按这个顺序：`apply()` 看服务是怎么解析的（直接 `get` → 否则 `ctx.inject` 软订阅）→ `locate()` 看 id 怎么反查 `sessionId` → 三个 `execute()`。

## 许可

MIT。


