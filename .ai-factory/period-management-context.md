# Контекст: управление периодами активности через свободный текст

## Инициатива

Пользователь хочет изменять периоды активности через обычный текст или голос в любой момент — без команды `/settings`.

**Примеры запросов:**
- "Сдвинь Работу на 10:00"
- "Измени конец Проектов на 22:00"
- "Удали период Тренировка"
- "Добавь новый период Вечер с 21:00 до 23:00 по будням"
- "Работа теперь начинается в 10, заканчивается в 18"

---

## Архитектура

### Новый Intent: `modify_period`

В `src/llm/intent.ts` добавить:

```typescript
export type Intent =
  | 'add_task'
  | 'modify_task'
  | 'show_plan'
  | 'show_backlog'
  | 'mark_done'
  | 'update_progress'
  | 'modify_period'   // ← новый
  | 'query'           // (если уже реализован)
  | 'other'
```

Обновить системный промпт:
> modify_period: пользователь хочет изменить, удалить или добавить период активности (сдвинуть время, поменять дни недели, переименовать, удалить)

### Новый LLM-парсер: `src/llm/parse-period.ts`

Функция `parsePeriodChange(text, existingPeriods)` — принимает текст и список текущих периодов, возвращает:

```typescript
interface PeriodChange {
  action: 'update' | 'delete' | 'create'
  period_slug?: string        // для update/delete — slug существующего периода
  changes?: {
    name?: string
    start_time?: string       // HH:MM
    end_time?: string         // HH:MM
    days_of_week?: number[]   // 1=Пн, 7=Вс
  }
  new_period?: {              // для action=create
    name: string
    slug: string
    start_time: string
    end_time: string
    days_of_week: number[]
  }
  needs_clarification?: boolean
  clarification_question?: string
}
```

### Новые DB-функции в `src/db/periods.ts`

```typescript
export async function updatePeriod(id: string, data: Partial<DbPeriodInsert>): Promise<DbPeriod>
export async function deletePeriod(id: string): Promise<void>
// createPeriods уже есть
```

### Обработчик в `src/bot/handlers.ts`

```typescript
case 'modify_period':
  await handleModifyPeriod(ctx, user)
  break
```

Функция `handleModifyPeriod`:
1. Получить текущие периоды пользователя
2. Вызвать `parsePeriodChange(text, periods)`
3. Если `needs_clarification` — уточнить у пользователя
4. Показать что изменится, попросить подтверждение
5. Применить изменение в БД
6. Перерегистрировать cron-джобы: `unregisterUserCrons(user.id)` → `registerUserCrons(updatedUser)`
7. Ответить пользователю

### Подтверждение перед применением

Изменение расписания — необратимое действие, поэтому обязательно показывать что именно изменится:

```
User: сдвинь работу на 10:00

Bot:  Работа: 11:00–19:00 → 10:00–18:00
      (длительность сохраняется)
      
      Применить?  [✅ Да]  [❌ Нет]
```

Либо через `InlineKeyboard`, либо просто ждать "да/нет" текстом.

---

## Важные детали

**Cron-джобы:** после любого изменения периодов нужно перерегистрировать все джобы пользователя. В `src/cron/manager.ts` уже есть `unregisterUserCrons` и `registerUserCrons`.

**Конфликты времён:** если новое время пересекается с другим периодом — предупредить пользователя. Проверка на уровне логики (не БД).

**Slug при создании нового периода:** генерировать из имени (транслитерация или латиница). Например "Вечер" → "evening", или просто kebab-case от имени.

**История диалога:** если реализована `sch_chat_history`, контекст предыдущих сообщений поможет — пользователь может написать "измени начало на 10" после "поговорим про Работу" в предыдущем сообщении.

---

## Файлы для чтения в новом чате

- `src/llm/intent.ts` — добавить `modify_period`
- `src/bot/handlers.ts` — добавить `case 'modify_period'`
- `src/db/periods.ts` — добавить `updatePeriod`, `deletePeriod`
- `src/cron/manager.ts` — `unregisterUserCrons`, `registerUserCrons`
- `src/llm/parse-task.ts` — паттерн для нового LLM-парсера
- `.ai-factory/DESCRIPTION.md` — стек и архитектура

---

## Как начать новый чат

```
Читай .ai-factory/DESCRIPTION.md и .ai-factory/period-management-context.md.

Нужно добавить управление периодами активности через свободный текст:
изменение времени, дней недели, удаление и создание периодов.

Начни с добавления intent 'modify_period' и парсера src/llm/parse-period.ts,
затем обработчик в handlers.ts и новые DB-функции в periods.ts.
```
