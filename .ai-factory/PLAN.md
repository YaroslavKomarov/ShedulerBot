# Implementation Plan: Шаг 8 — Голосовые сообщения

Branch: master
Created: 2026-04-07

## Settings
- Testing: yes
- Logging: structured via `src/lib/logger.ts`, LOG_LEVEL env var

---

## Tasks

### Phase 1: Модель + Middleware
- [x] Task 1: Добавить `WHISPER_MODEL` в `src/llm/client.ts` и реализовать `src/bot/middleware/voice.ts`
- [x] Task 2: Рефакторинг `src/bot/handlers.ts` — выделить `handleText(ctx, text)`

### Phase 2: Интеграция
- [x] Task 3: Подключить voice handler в `src/bot/index.ts`

### Phase 3: Тесты
- [x] Task 4: Написать тесты `src/bot/__tests__/voice.test.ts`

---

## Task Details

### Task 1: WHISPER_MODEL + `src/bot/middleware/voice.ts`

**`src/llm/client.ts`** — добавить константу после STRONG_MODEL:
```typescript
// Whisper: audio transcription
export const WHISPER_MODEL = 'openai/whisper-large-v3'
```

**`src/bot/middleware/voice.ts`** — функция транскрибирования голосового сообщения.

**Алгоритм:**
1. Получить `file_id` из `ctx.message.voice.file_id`
2. Вызвать `ctx.getFile()` → получить `file_path`
3. Скачать OGG буфер через `fetch`:
   ```
   https://api.telegram.org/file/bot${token}/${file_path}
   ```
4. Создать `File` из буфера (имя `voice.ogg`, тип `audio/ogg`)
5. Вызвать `llmClient.audio.transcriptions.create({ model: WHISPER_MODEL, file })` через OpenRouter
6. Вернуть транскрипцию (`transcription.text`)

**Интерфейс:**
```typescript
export async function transcribeVoice(ctx: BotContext): Promise<string>
// Выбрасывает ошибку если транскрипция не удалась
```

**LOGGING:**
- `[voice] transcribeVoice start` `{ userId, fileId }` — DEBUG
- `[voice] file downloaded` `{ userId, fileId, sizeBytes }` — DEBUG
- `[voice] transcription done` `{ userId, charCount }` — INFO
- `[voice] transcription failed` `{ userId, error }` — ERROR

Files: `src/llm/client.ts`, `src/bot/middleware/voice.ts`

---

### Task 2: Рефакторинг `src/bot/handlers.ts`

Текущий `handleFreeText` читает текст напрямую из `ctx.message.text`. Нужно вынести логику в отдельную экспортируемую функцию, чтобы её можно было вызвать с произвольным текстом (из голосового сообщения).

**Изменения:**
1. Переименовать внутреннюю логику в `handleText(ctx: BotContext, text: string): Promise<void>`
   - Принимает текст как параметр вместо чтения из `ctx.message.text`
   - Экспортировать
2. `handleFreeText` остаётся как обёртка:
   ```typescript
   export async function handleFreeText(ctx: BotContext): Promise<void> {
     if (!ctx.from || !ctx.message?.text) return
     await handleText(ctx, ctx.message.text)
   }
   ```

**LOGGING:** не менять — все логи уже внутри `handleText`.

Files: `src/bot/handlers.ts`

---

### Task 3: Voice handler в `src/bot/index.ts`

Добавить обработчик `message:voice` **перед** строкой `bot.on('message:text', handleFreeText)`.

```typescript
import { transcribeVoice } from './middleware/voice.js'
import { handleText } from './handlers.js'

// Voice message handler — must be before the text handler
bot.on('message:voice', async (ctx) => {
  logger.info('[bot] voice message received', { userId: ctx.from?.id })
  try {
    const transcription = await transcribeVoice(ctx)
    logger.info('[bot] voice transcribed, routing as text', {
      userId: ctx.from?.id,
      charCount: transcription.length,
    })
    await handleText(ctx, transcription)
  } catch (err) {
    logger.error('[bot] voice transcription failed', {
      userId: ctx.from?.id,
      error: err instanceof Error ? err.message : String(err),
    })
    await ctx.reply('Не удалось распознать голосовое сообщение, попробуй текстом.')
  }
})
```

Files: `src/bot/index.ts`

---

### Task 4: Тесты `src/bot/__tests__/voice.test.ts`

**Vitest, vi.mock для `llmClient` и Telegram Bot API.**

**Настройка:**
- Mock `ctx.getFile()` → `{ file_path: 'voice/file_123.ogg' }`
- Mock `fetch` → возвращает ArrayBuffer с фейковыми байтами
- Mock `llmClient.audio.transcriptions.create` → `{ text: 'купить молоко' }`
- `process.env.TELEGRAM_BOT_TOKEN = 'test_token'`

**Тесты `transcribeVoice`:**
- Test: успешная транскрипция → возвращает строку из `transcription.text`
- Test: `ctx.getFile()` бросает ошибку → `transcribeVoice` пробрасывает её
- Test: `fetch` возвращает non-ok статус → бросает ошибку с кодом статуса
- Test: `llmClient.audio.transcriptions.create` бросает ошибку → пробрасывает её

Files: `src/bot/__tests__/voice.test.ts`
