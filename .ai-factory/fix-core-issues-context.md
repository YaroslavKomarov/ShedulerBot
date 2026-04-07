# Контекст: три критических бага

## Проблема 1 — Google Calendar не подключается

**Корень:** `src/bot/conversations/onboarding.ts` строка 145 — заглушка вместо реального URL:

```typescript
// СЕЙЧАС (строка 145):
await ctx.reply('Ссылка для подключения будет доступна после полного запуска сервиса. Пока что пропустим.')

// НУЖНО:
const authUrl = getAuthUrl(user.id)  // user уже сохранён в БД на этом шаге
await ctx.reply(`Для подключения Google Calendar перейди по ссылке:\n${authUrl}`)
// Затем ждать подтверждения или пропуска
```

**Инфраструктура уже готова:**
- `src/calendar/auth.ts` — `getAuthUrl(userId)` возвращает OAuth URL
- `src/routes/auth.ts` — `/auth/google/callback` принимает код, сохраняет токены, уведомляет пользователя в Telegram
- `src/calendar/sync.ts` — `syncDayPlan()` синкает план в Calendar (вызывается из morning-plan.ts)

**Что нужно сделать:**
1. В `onboarding.ts` — заменить заглушку на вызов `getAuthUrl(user.id)` и отправку URL пользователю
2. Добавить `import { getAuthUrl } from '../../calendar/auth.js'` в onboarding
3. После отправки URL — бот должен подождать немного (или попросить написать что-то после подключения) и продолжить
4. Проверить что `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` заполнены в `.env`
5. `GOOGLE_REDIRECT_URI` должен указывать на `/auth/google/callback` текущего сервера (локально: `http://localhost:3000/auth/google/callback`)

---

## Проблема 2 — `/settings` не работает

**Корень:** команда `/settings` не зарегистрирована в `src/bot/index.ts`. При вводе `/settings` Grammy передаёт это в catch-all `handleFreeText`, LLM классифицирует как `other` → "Не понял."

**Что нужно сделать:**

Добавить в `src/bot/index.ts`:

```typescript
bot.command('settings', async (ctx) => {
  await ctx.conversation.enter('settingsConversation')
})
```

И создать `src/bot/conversations/settings.ts` с базовым меню настроек:
- Изменить таймзону
- Изменить время утреннего плана
- Изменить время конца дня
- Подключить/отключить Google Calendar
- (опционально) Изменить периоды

После изменения — перерегистрировать cron-джобы: `unregisterUserCrons(user.id)` → `registerUserCrons(updatedUser)`.

---

## Проблема 3 — Все намерения возвращают "Не понял"

**Корень:** `src/llm/intent.ts` строки 75–79 — LLM ошибки **молча глотаются**, возвращается `FALLBACK` с `intent: 'other'`. Пользователь видит "Не понял" вместо реальной ошибки.

```typescript
// СЕЙЧАС — ошибка LLM скрывается:
} catch (err) {
  logger.warn('[llm/intent] llm error, using fallback', { ... })
  return { ...FALLBACK }
}
```

**Причина подтверждена логами:**

```
ERROR [llm/client] callLLM error {"model":"google/gemini-flash-1.5","error":"404 No endpoints found for google/gemini-flash-1.5."}
WARN  [llm/intent] llm error, using fallback {"error":"OpenRouter balance is insufficient"}
INFO  [bot/handlers] handleText {"userId":...,"intent":"other","confidence":"low"}
```

`google/gemini-flash-1.5` — неверный slug, даёт 404. `isInsufficientCredits()` в `client.ts` ловит строку "No endpoints found" и выбрасывает `LLMInsufficientCreditsError` — поэтому в логах пишет "OpenRouter balance is insufficient" хотя реальная причина — неверный slug.

Также из логов видно что **голос работает** (Groq транскрибирует успешно), но затем `detectIntent` падает → fallback → "Не понял".

**Правильный slug:** `google/gemini-flash-1.5` → `google/gemini-2.0-flash-001` (бесплатная) или `google/gemini-1.5-flash`.

**✅ Уже исправлено в этом чате:**
1. `FAST_MODEL` в `src/llm/client.ts` исправлен: `'google/gemini-flash-1.5'` → `'google/gemini-2.0-flash-001'`
2. `isInsufficientCredits()` исправлен: убрано `lower.includes('no endpoints found')` — это ошибка неверного slug, не баланса

После перезапуска бота `detectIntent` работает и текстовый/голосовой ввод распознаётся корректно. Проблема 3 закрыта.

---

## Файлы для чтения в новом чате

- `src/bot/conversations/onboarding.ts` — строка 144-146 (заглушка Calendar)
- `src/bot/index.ts` — место для регистрации `/settings`
- `src/llm/intent.ts` — молчаливый fallback
- `src/llm/client.ts` — `LLMInsufficientCreditsError`, константы моделей
- `src/bot/handlers.ts` — `handleText()` и `handleFreeText()`
- `src/calendar/auth.ts` — `getAuthUrl()`
- `.env.example` — список env vars

---

## Как начать новый чат

```
Читай .ai-factory/DESCRIPTION.md и .ai-factory/fix-core-issues-context.md.

Нужно исправить три критических бага:
1. Google Calendar не подключается в онбординге (заглушка вместо реального OAuth URL)
2. Команда /settings не зарегистрирована в боте
3. Все намерения возвращают "Не понял" из-за молчаливого проглатывания LLM-ошибок

Начни с диагностики проблемы 3 — она блокирует всё остальное.
```

Или просто: `/ai-factory.fix` с описанием любой из трёх проблем — fix сам прочитает контекст.
