# Implementation Plan: Urgent Flag Rules and Constraints

Branch: master
Created: 2026-04-26

## Settings
- Testing: no
- Logging: structured, existing convention `[module/function] message {data}`

## Context

`is_urgent` не имеет ограничений:
1. Срочная задача может одновременно иметь `scheduled_date` или `deadline_date`
2. В одной очереди (`queue_slug`) может быть несколько срочных задач

Ожидаемое поведение:
- `is_urgent=true` → задача плавающая: без `scheduled_date`, без `deadline_date`
- В очереди одновременно допускается ровно одна срочная задача

## Tasks

### Phase 1: DB

- [x] Task 1: Добавить `getUrgentTask` в `src/db/tasks.ts`

### Phase 2: Agent tool validation

- [ ] Task 2: Валидация `is_urgent` в `add_task` (`src/llm/agent-query.ts`)
- [ ] Task 3: Валидация `is_urgent` в `update_task` (`src/llm/agent-query.ts`)
- [ ] Task 4: Обновить системный промпт и описание инструмента `add_task`

## Task Details

### Task 1 — `getUrgentTask` в `src/db/tasks.ts`

```ts
export async function getUrgentTask(
  userId: string,
  queueSlug: string,
  excludeTaskId?: string,
): Promise<DbTask | null>
```

Запрос: `user_id=userId`, `period_slug=queueSlug`, `is_urgent=true`, `status=pending`.
Если `excludeTaskId` передан — добавить `.neq('id', excludeTaskId)`.
Возвращает `maybeSingle()`.

Логирование:
```
[db/tasks] getUrgentTask { userId, queueSlug, excludeTaskId }
[db/tasks] getUrgentTask result { userId, queueSlug, found }
```

### Task 2 — Валидация `is_urgent` в `add_task`

После проверки `scheduledDate && deadlineDate` добавить:

```
if (isUrgent && (scheduledDate || deadlineDate)) {
  return { error: '...' }
}
if (isUrgent) {
  const existing = await getUrgentTask(userId, queueSlug)
  if (existing) {
    return {
      urgent_conflict: true,
      existing_title: existing.title,
      message: 'В очереди уже есть срочная задача...'
    }
  }
}
```

### Task 3 — Валидация `is_urgent` в `update_task`

Если `patch['is_urgent'] === true`:
- Авто-очищать `scheduled_date` и `deadline_date` (аналогично авто-очистке дат)
- Проверить нет ли другой срочной задачи в той же очереди (через `task.period_slug`)
- При конфликте вернуть `urgent_conflict: true` с именем существующей задачи

Если `patch['is_urgent'] === false` — просто снять флаг, без доп. проверок.

### Task 4 — Системный промпт и описание инструмента

В `is_urgent` description добавить:
- взаимоисключаемость с `scheduled_date` и `deadline_date`
- ограничение: одна срочная задача на очередь

В системный промпт: добавить пункт 6 в секцию `add_task` про правила `is_urgent`.
