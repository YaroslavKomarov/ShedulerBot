# Implementation Plan: queue_slug — общая очередь задач для нескольких периодов

Created: 2026-04-22

## Settings
- Testing: no
- Logging: standard
- Docs: no

## Контекст

Добавляем поле `queue_slug` в `sch_periods`. По умолчанию = `slug` периода. Если два периода должны делить одну очередь задач (например, "Работа утро" и "Работа вечер"), им выставляется одинаковый `queue_slug`. Задачи в `sch_tasks.period_slug` хранят `queue_slug` периода — это и есть ключ очереди.

**Принцип изменений:**
- `sch_periods.slug` — остаётся уникальным идентификатором периода (не трогаем)
- `sch_periods.queue_slug` — ключ очереди задач (новое поле, default = slug)
- `sch_tasks.period_slug` — теперь хранит `queue_slug`, а не `slug` периода
- Все запросы задач используют `period.queue_slug` вместо `period.slug`

---

## Tasks

### Phase 1: БД и типы

- [x] Task 1: DB-миграция — добавить `queue_slug` в `sch_periods`
  - Создать файл `supabase/migrations/002_period_queue_slug.sql`
  - `ALTER TABLE sch_periods ADD COLUMN queue_slug text;`
  - `UPDATE sch_periods SET queue_slug = slug WHERE queue_slug IS NULL;`
  - `ALTER TABLE sch_periods ALTER COLUMN queue_slug SET NOT NULL;`
  - LOG: INFO "Migration 002: added queue_slug to sch_periods"

- [x] Task 2: Обновить TypeScript-типы для периодов
  - `src/types/database.types.ts` — добавить `queue_slug: string` в Row/Insert/Update для `sch_periods`
  - Проверить все интерфейсы Period в проекте

### Phase 2: Слой данных

- [x] Task 3: Обновить `src/db/periods.ts`
  - Убедиться что `queue_slug` включён в SELECT-запросы
  - В `createPeriods()` — передавать `queue_slug` (default = slug если не задан)
  - В `updatePeriod()` — поддержать обновление `queue_slug`
  - LOG: DEBUG `[periods.createPeriods] slug={slug}, queue_slug={queue_slug}`

- [x] Task 4: Обновить онбординг — выставлять `queue_slug` при создании периодов
  - `src/bot/conversations/onboarding.ts` — в маппинге добавить `queue_slug: p.slug`

<!-- 🔄 Commit checkpoint: tasks 1-4 — "feat: add queue_slug to sch_periods schema and types" -->

### Phase 3: Создание задач

- [x] Task 5: Обновить `add_task` в `src/llm/agent-query.ts`
  - После валидации `periodSlug` (slug периода) — найти период и взять его `queue_slug`
  - Сохранять в `sch_tasks.period_slug` значение `period.queue_slug`, а не `period.slug`
  - `const period = periods.find(p => p.slug === periodSlug)` → `taskPeriodSlug = period.queue_slug`
  - LOG: DEBUG `[add_task] period.slug={periodSlug}, stored period_slug={taskPeriodSlug}`

### Phase 4: Выборка задач

- [x] Task 6: Обновить `src/cron/period-notify.ts`
  - В `sendPeriodPreview`, `sendPeriodStart`, `sendPeriodEnd` заменить `period.slug` → `period.queue_slug` при вызове `getTaskQueue`
  - LOG: INFO `[period-notify] period={period.slug}, queue_slug={period.queue_slug}`

- [x] Task 7: Обновить `src/cron/morning-plan.ts` — группировка по queue_slug
  - **Проблема**: при общем queue_slug два периода получат одинаковые задачи — дублирование.
  - **Новая логика**:
    1. Получить периоды дня (без изменений)
    2. Сгруппировать по `queue_slug` (Map<queue_slug, Period[]>), сохранить порядок по времени
    3. Для каждой группы — получить задачи один раз по `queue_slug`
    4. Распределить последовательно: первый период заполняется до capacity, остаток — в следующий
  - Backlog: также по `period.queue_slug`
  - LOG: INFO `[morning-plan] queue_slug={qSlug}, periods_in_group={n}, total_tasks={m}`

<!-- 🔄 Commit checkpoint: tasks 5-7 — "feat: use queue_slug for task assignment and retrieval" -->

### Phase 5: Управление периодами

- [x] Task 8: Обновить инструменты агента для работы с queue_slug
  - `get_periods` — добавить `queue_slug` в вывод каждого периода
  - `create_period` — добавить опциональный параметр `queue_slug` (default = slug)
  - `update_period` — добавить опциональный параметр `queue_slug`
  - Системный промпт — объяснить: "queue_slug — ключ общей очереди; чтобы объединить очереди двух периодов, выстави им одинаковый queue_slug через update_period"
  - LOG: INFO `[update_period] period={slug}, new queue_slug={qSlug}`

<!-- 🔄 Commit checkpoint: task 8 — "feat: expose queue_slug management in agent tools" -->

---

## Commit Plan

- **Commit 1** (tasks 1-4): `feat: add queue_slug to sch_periods schema and types`
- **Commit 2** (tasks 5-7): `feat: use queue_slug for task assignment and retrieval`
- **Commit 3** (task 8): `feat: expose queue_slug management in agent tools`

---

## Важные нюансы

- **Обратная совместимость**: существующие задачи имеют `period_slug = period.slug`. После миграции `queue_slug = slug` по умолчанию — ничего не ломается.
- **Миграция данных задач не нужна**: пока `queue_slug = slug`, это одно и то же значение.
- **SoloLeveling sync** — синхронизирует периоды по `slug`, не задачи. Изменений не требует.
