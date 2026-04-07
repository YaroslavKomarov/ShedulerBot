# Implementation Plan: Unified LLM Agent with Full Dialog Context

Branch: master
Created: 2026-04-07

## Settings
- Testing: yes
- Logging: verbose (follow existing `[module/function] message {data}` pattern)

## Context

Current architecture is fragmented: each message goes through `detectIntent` (fast LLM) → routing switch → dedicated handler with its own LLM call (`parseTaskMessage`, `parseProgressUpdate`, `handleAgentQuery`). Dialog context is lost between steps.

**Target:** single `STRONG_MODEL` agent with read+write tools, always receiving full conversation history. No intent classification. No separate parsers.

## Commit Plan

- **Commit 1** (after tasks 1–2): `feat: unified agent with write tools and simplified handlers`
- **Commit 2** (after tasks 3–6): `chore: remove obsolete modules, add agent tests`

---

## Tasks

### Phase 1: Core Rewrite

- [x] **Task 1: Extend agent with write tools**

  File: `src/llm/agent-query.ts`

  Add four new tools to the `TOOLS` array:

  - `add_task` — parameters: `title` (required), `period_slug` (optional), `scheduled_date` (optional, YYYY-MM-DD), `is_urgent` (optional bool), `deadline_date` (optional), `estimated_minutes` (optional). Calls `createTask()` from `src/db/tasks.ts`. If `period_slug` or `scheduled_date` is missing — agent asks the user before calling the tool, does not call it with nulls silently.
  - `update_task` — parameters: `title_query` (string, to find task via `findTasksByTitle`), `updates` (object: optional `title`, `period_slug`, `scheduled_date`, `is_urgent`, `deadline_date`, `estimated_minutes`, `status`). Calls `findTasksByTitle` then `updateTask`.
  - `cancel_task` — parameters: `title_query`. Calls `findTasksByTitle` then `updateTask({ status: 'cancelled' })`.
  - `mark_done` — parameters: `title_query`. Calls `findTasksByTitle` then `updateTask({ status: 'done' })`.

  Rename `handleAgentQuery` → `handleAgentMessage`. Update all callers.

  Update system prompt: agent handles ALL user requests — questions, creating tasks, editing, cancelling, completing. Asks clarifying questions when required data is missing. Responds in Russian, concisely.

  LOGGING:
  - Log tool entry: `[llm/agent] tool:add_task {title, period_slug, scheduled_date}`
  - Log tool result: `[llm/agent] task created {taskId, title}`
  - Log tool errors: WARN with `{tool, args, error}`

  Dependencies: none

- [x] **Task 2: Simplify `handlers.ts`**

  File: `src/bot/handlers.ts`

  Remove all private handlers (`handleModifyTask`, `handleMarkDone`, `handleUpdateProgress`, `handleShowBacklog`) and the `detectIntent` routing switch.

  New `handleText`:
  ```typescript
  export async function handleText(ctx: BotContext, text: string): Promise<void> {
    if (!ctx.from) return
    const user = await getUserByTelegramId(ctx.from.id)
    if (!user) return
    const history = await getChatHistory(user.id)
    const reply = await handleAgentMessage(user, text, history)
    await ctx.reply(reply)
    await saveChatMessage(user.id, 'user', text)
    await saveChatMessage(user.id, 'assistant', reply)
  }
  ```

  Remove imports no longer needed: `detectIntent`, `parseTaskMessage`, `parseProgressUpdate`, `getUserPeriods`, `findTasksByTitle`, `updateTask`, `getBacklog`, `sendPlanForDate`.

  Keep `handleFreeText` as thin wrapper.

  LOGGING:
  - Log `[bot/handlers] handleText {userId, textLength, historyLen}`
  - Log `[bot/handlers] reply sent {userId, replyLength}`

  Dependencies: Task 1

<!-- 🔄 Commit checkpoint: tasks 1–2 -->

---

### Phase 2: Cleanup & Tests

- [x] **Task 3: Remove `addTaskConversation` from `index.ts`**

  File: `src/bot/index.ts`

  - Remove `import { addTaskConversation }` line
  - Remove `bot.use(createConversation(addTaskConversation))` line
  - No other changes needed

  Dependencies: Task 2

- [x] **Task 4: Write tests for unified agent**

  File: `src/llm/__tests__/agent-message.test.ts`

  Use vitest + mock `llmClient` (same pattern as existing tests in `src/llm/__tests__/`).

  Test scenarios:
  1. **Single-turn task creation** — user says "добавь задачу написать тесты на завтра", verify agent calls `add_task` tool with correct `title` and `scheduled_date`
  2. **Multi-turn task creation** — history: `[{role: 'user', content: 'добавь задачу'}, {role: 'assistant', content: 'Как называется задача?'}]`, current: "написать тесты" — verify agent uses context and calls `add_task`
  3. **Cancellation via follow-up** — history: `[{role: 'user', content: 'удали задачу'}, {role: 'assistant', content: 'Какую именно?'}]`, current: "тесты к авторизации" — verify agent calls `cancel_task` with `title_query: 'тесты к авторизации'`
  4. **Query** — user asks "какие задачи на сегодня?", verify agent calls `get_tasks_by_date` and returns a formatted answer

  Dependencies: Task 1

- [x] **Task 5: Delete obsolete files and tests**

  Delete:
  - `src/llm/intent.ts`
  - `src/llm/parse-task.ts`
  - `src/llm/parse-progress.ts`
  - `src/bot/conversations/add-task.ts`
  - `src/llm/__tests__/intent.test.ts`
  - `src/llm/__tests__/parse-task.test.ts`
  - `src/llm/__tests__/parse-progress.test.ts`
  - `src/bot/__tests__/handlers-step5.test.ts`

  NOTE: `src/bot/conversations/helpers.ts` is used by `onboarding.ts` and `settings.ts` — do NOT delete.

  Remove any remaining imports of deleted modules.

  Dependencies: Tasks 2, 3

- [x] **Task 6: Final verification**

  Run:
  ```bash
  npx tsc --noEmit
  npx vitest run
  ```

  Both must pass without errors. Fix any remaining type errors or broken imports.

  Dependencies: Tasks 1–5

<!-- 🔄 Commit checkpoint: tasks 3–6 -->
