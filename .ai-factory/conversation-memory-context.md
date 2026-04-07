# Контекст: память диалога (conversation history)

## Проблема

Каждое сообщение обрабатывается изолированно. `handleText()` получает только текущий текст — никакого контекста предыдущих сообщений. Это ломает многошаговые диалоги:

```
User: удали активную задачу
Bot:  Какую именно задачу отменить?       ← спрашивает уточнение

User: тесты к авторизации
Bot:  Не понял. Чтобы добавить задачу...  ← забыл что спрашивал
```

## Архитектура решения

### Хранить последние N сообщений в Supabase

Новая таблица `sch_chat_history`:

```sql
CREATE TABLE sch_chat_history (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES sch_users(id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sch_chat_history_user_created_idx ON sch_chat_history (user_id, created_at DESC);
```

Хранить последние **10 сообщений** (5 пар user/assistant) — достаточно для контекста, не раздувает промпт.

### Изменения в `handleText()`

```typescript
// СЕЙЧАС:
const detected = await detectIntent(text)

// НУЖНО:
const history = await getChatHistory(user.id, 10)  // последние 10 сообщений
const detected = await detectIntent(text, history)  // передаём историю
// ... обработка ...
await saveChatMessage(user.id, 'user', text)
await saveChatMessage(user.id, 'assistant', botReply)
```

### Изменения в `detectIntent()`

```typescript
// src/llm/intent.ts
export async function detectIntent(
  text: string,
  history: ChatMessage[] = []   // ← добавить параметр
): Promise<DetectedIntent>
```

История передаётся в LLM как предыдущие сообщения — модель сама понимает контекст:

```typescript
messages: [
  { role: 'system', content: SYSTEM_PROMPT },
  ...history,           // ← последние N сообщений
  { role: 'user', content: text },
]
```

### Изменения в agent query (если реализован)

Та же история передаётся в `handleAgentQuery()` — LLM понимает что пользователь имеет в виду под "активной задачей" из предыдущего контекста.

## Что нужно создать

### 1. Миграция БД
Файл `supabase/migrations/002_chat_history.sql` с таблицей `sch_chat_history`.

### 2. `src/db/chat-history.ts`

```typescript
export async function getChatHistory(userId: string, limit = 10): Promise<ChatMessage[]>
export async function saveChatMessage(userId: string, role: 'user' | 'assistant', content: string): Promise<void>
export async function clearChatHistory(userId: string): Promise<void>  // для /start или сброса
```

### 3. Обновить `src/llm/intent.ts`
Добавить параметр `history: ChatMessage[]` в `detectIntent()`.

### 4. Обновить `src/bot/handlers.ts`
- `handleText()` загружает историю перед вызовом `detectIntent()`
- После каждого ответа сохраняет пару user/assistant в историю

### 5. Обновить `src/llm/agent-query.ts` (если уже реализован)
Передавать историю в LLM-запрос.

## Тонкости

**Когда очищать историю:**
- При `/start` — сброс контекста
- После завершения structured conversation (onboarding, add-task) — они сами управляют состоянием через Grammy
- Автоматически через TTL или лимит записей (хранить только последние 10)

**Structured conversations (Grammy) не трогать:**
- `onboardingConversation`, `addTaskConversation`, `settingsConversation` — уже имеют встроенную память через Grammy conversations plugin
- История нужна только для free-form `handleText()` режима

**Не сохранять в историю:**
- Уведомления от бота (утренний план, уведомления периодов, ретроспектива) — это не диалог
- Команды `/plan`, `/tomorrow`, `/backlog` — разовые запросы

## Файлы для чтения в новом чате

- `src/bot/handlers.ts` — `handleText()`, основная точка изменений
- `src/llm/intent.ts` — `detectIntent()`, нужно добавить параметр history
- `src/db/users.ts` — паттерн для создания нового db-модуля
- `supabase/migrations/001_init.sql` — паттерн миграции
- `.ai-factory/DESCRIPTION.md` — стек и архитектура

## Как начать новый чат

```
Читай .ai-factory/DESCRIPTION.md и .ai-factory/conversation-memory-context.md.

Нужно добавить память диалога — бот должен помнить последние 10 сообщений и передавать
их в LLM при обработке каждого нового сообщения. Без этого многошаговые диалоги
("удали задачу" → "какую?" → "тесты к авторизации") не работают.

Начни с создания миграции и db/chat-history.ts, затем обнови handlers.ts и intent.ts.
```
