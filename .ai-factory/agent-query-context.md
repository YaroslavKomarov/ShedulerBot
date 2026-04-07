# Контекст: агентный режим — произвольные запросы к данным

## Инициатива

Сейчас бот распознаёт только фиксированный список намерений через `detectIntent()`:
`add_task | modify_task | show_plan | show_backlog | mark_done | update_progress | other`

Всё что не попало в эти категории — падает в `other` → "Не понял."

Нужно добавить полноценный агентный режим: пользователь задаёт любой вопрос или запрос на чтение данных в свободной форме, LLM сама решает что запросить из БД и формирует ответ.

**Примеры запросов которые должны работать:**
- "Какие у меня настроены периоды активности?"
- "К какому периоду относятся мои задачи?"
- "Что у меня запланировано на среду?"
- "Сколько задач без срока?"
- "Покажи все срочные задачи"
- "Что я добавил за последние три дня?"
- "Есть ли у меня задачи с дедлайном на этой неделе?"

---

## Архитектурный выбор: два подхода

### Вариант А — Tool Calling (рекомендуется)

LLM получает описание доступных функций (tools) и данные о пользователе. Сама решает какие функции вызвать, вызывает их, формирует ответ.

**Плюсы:** гибко, расширяемо, LLM сама строит логику
**Минусы:** требует модели с поддержкой function calling (Gemini, GPT-4, Claude — всё поддерживают)

**Схема:**
```
user message
    ↓
LLM (STRONG_MODEL) с tools: [getUserPeriods, getTasksByDate, getBacklog, getTaskQueue, ...]
    ↓
LLM вызывает нужные функции
    ↓
Результаты функций → обратно в LLM
    ↓
LLM формирует финальный ответ пользователю
```

### Вариант Б — Context Injection (проще)

Загружаем весь контекст пользователя (периоды + задачи за N дней + бэклог) и отправляем LLM как единый промпт.

**Плюсы:** проще реализовать, работает с любой моделью
**Минусы:** большой контекст → дороже, медленнее; не масштабируется при сотнях задач

---

## Рекомендуемый план реализации (Вариант А)

### Шаг 1: Добавить `query` в Intent

В `src/llm/intent.ts` добавить новый тип:
```typescript
export type Intent =
  | 'add_task'
  | 'modify_task'
  | 'show_plan'
  | 'show_backlog'
  | 'mark_done'
  | 'update_progress'
  | 'query'       // ← новый: произвольный запрос к данным
  | 'other'
```

Обновить системный промпт — добавить описание `query`:
> query: пользователь хочет узнать информацию о своих задачах, периодах, расписании (вопросы вида "какие задачи?", "что на завтра?", "покажи периоды" и т.д.)

### Шаг 2: Создать `src/llm/agent-query.ts`

Функция `handleAgentQuery(userId, userMessage, userContext)`:

```typescript
// Доступные инструменты (описание для LLM):
const tools = [
  {
    name: 'get_periods',
    description: 'Получить все периоды активности пользователя',
    parameters: {}
  },
  {
    name: 'get_tasks_by_date',
    description: 'Получить задачи на конкретную дату',
    parameters: { date: 'string (YYYY-MM-DD)' }
  },
  {
    name: 'get_backlog',
    description: 'Получить задачи без даты (бэклог)',
    parameters: { period_slug: 'string (опционально)' }
  },
  {
    name: 'get_task_queue',
    description: 'Получить очередь задач для периода на дату с учётом приоритетов',
    parameters: { period_slug: 'string', date: 'string' }
  },
]
```

Логика:
1. LLM (STRONG_MODEL) получает вопрос + описание tools + текущую дату/таймзону
2. LLM возвращает JSON с вызовом tool: `{ tool: 'get_periods', args: {} }`
3. Код выполняет запрос к БД
4. Результат передаётся обратно в LLM
5. LLM формирует финальный читаемый ответ

### Шаг 3: Подключить в `handlers.ts`

```typescript
case 'query':
  await handleAgentQuery(ctx, user)
  break
```

---

## Текущее состояние кода

### `src/llm/intent.ts`
- 7 типов намерений, классификация через FAST_MODEL (`google/gemini-2.0-flash-001`)
- Fallback → `other` при ошибке LLM (не бросает ошибку наружу)

### `src/bot/handlers.ts` — `handleText()`
- Switch по `detected.intent`
- `default` → "Не понял. Чтобы добавить задачу — просто напиши её."
- Нужно добавить `case 'query'`

### Доступные DB-функции в `src/db/`

| Функция | Файл | Описание |
|---------|------|---------|
| `getUserPeriods(userId)` | periods.ts | Все периоды пользователя |
| `getPeriodsForDay(userId, dayOfWeek)` | periods.ts | Периоды на день недели |
| `getTaskQueue(userId, periodSlug\|null, date)` | tasks.ts | Очередь задач на дату |
| `getBacklog(userId)` | tasks.ts | Задачи без scheduled_date |
| `getTasksByDate(userId, date)` | tasks.ts | Все задачи на дату |
| `findTasksByTitle(userId, query)` | tasks.ts | Поиск задач по названию |

### `src/bot/conversations/settings.ts`
- Уже создан (добавлен в этом сеансе)

---

## Как начать новый чат

```
Читай .ai-factory/DESCRIPTION.md и .ai-factory/agent-query-context.md.

Нужно добавить агентный режим в бот — пользователь должен иметь возможность задавать
произвольные вопросы о своих задачах и периодах на естественном языке.

Реализуй через tool calling: добавь intent 'query', создай src/llm/agent-query.ts
и подключи в handlers.ts.
```
