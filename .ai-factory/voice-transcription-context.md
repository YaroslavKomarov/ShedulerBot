# Контекст: доработка транскрипции голосовых сообщений

## Текущее состояние

Голосовые сообщения реализованы, но транскрипция нестабильна — нужно выбрать и закрепить провайдера.

### Как работает пайплайн

1. Grammy перехватывает `message:voice`
2. `src/bot/middleware/voice.ts` — скачивает `.ogg` файл с серверов Telegram, отправляет в Whisper API
3. Транскрипция возвращается как текст, передаётся в обычный `handleText()`
4. Внутри conversations — `src/bot/conversations/helpers.ts` → `waitForText()` принимает оба типа сообщений

### Что было сломано и исправлено в этом чате

**Проблема 1:** Голосовые внутри conversations не обрабатывались.
- Все `conversation.waitFor('message:text')` заменены на `waitForText()` из helpers
- Файлы изменены: `onboarding.ts` (2 места), `add-task.ts` (2 места)
- Создан: `src/bot/conversations/helpers.ts`

**Проблема 2:** OpenRouter **не поддерживает** `/audio/transcriptions` endpoint — только chat completions.
- Попытка использовать `llmClient.audio.transcriptions.create()` падала с `Connection error`
- Временно переключено на **Groq** (`api.groq.com/openai/v1`, модель `whisper-large-v3`)
- Groq — бесплатный, OpenAI-совместимый, 2000 мин/день на Whisper

### Текущий код voice.ts

```typescript
// src/bot/middleware/voice.ts
// Использует отдельный OpenAI-клиент направленный на Groq
function getGroqClient(): OpenAI {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('Missing required env var: GROQ_API_KEY must be set')
  return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey })
}
const WHISPER_MODEL = 'whisper-large-v3'
```

Требует `GROQ_API_KEY` в `.env`.

---

## Задача для нового чата

### Что нужно сделать

1. **Исследовать альтернативы Groq** и выбрать лучший вариант:

| Провайдер | Модель | Бесплатно | Совместимость |
|-----------|--------|-----------|---------------|
| **Groq** | whisper-large-v3 | 2000 мин/день | OpenAI SDK |
| **OpenAI** | whisper-1 | Нет ($0.006/мин) | OpenAI SDK |
| **Cloudflare Workers AI** | whisper | ~бесплатно (10k req/день) | REST API |
| **AssemblyAI** | Universal-2 | 100 часов бесплатно | REST API |
| **Deepgram** | nova-2 | $200 кредитов при регистрации | REST API |
| **fal.ai** | whisper-large-v3 | Pay-per-use, дешевле OpenAI | REST API |

2. **Сделать провайдера конфигурируемым** через env:
   ```
   WHISPER_PROVIDER=groq   # groq | openai | deepgram
   ```
   Так можно менять без изменения кода.

3. **Протестировать** что голосовые работают сквозно:
   - Внутри онбординга (описание периодов голосом)
   - Добавление задачи голосом
   - Обычные команды голосом ("покажи план")

4. **Добавить язык** в запрос транскрипции:
   ```typescript
   groq.audio.transcriptions.create({
     model: WHISPER_MODEL,
     file,
     language: 'ru',  // явно указывать русский — быстрее и точнее
   })
   ```

### Файлы для чтения в новом чате

- `src/bot/middleware/voice.ts` — текущая реализация
- `src/bot/conversations/helpers.ts` — `waitForText()` хелпер
- `src/bot/conversations/onboarding.ts` — использует `waitForText()`
- `.env.example` — список env vars
- `PLAN.md` → Шаг 8 (Голосовые сообщения)

### Как начать чат

```
Читай .ai-factory/DESCRIPTION.md, .ai-factory/voice-transcription-context.md и src/bot/middleware/voice.ts.

Нужно доработать транскрипцию голосовых сообщений — выбрать лучшего провайдера (сейчас стоит Groq как временное решение), сделать его конфигурируемым и протестировать сквозной сценарий.
```
