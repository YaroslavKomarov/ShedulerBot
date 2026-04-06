# Grammy Patterns

Patterns and conventions for building Telegram bots with the Grammy framework (TypeScript).

## Core Concepts

### Bot Initialization

```typescript
import { Bot, Context, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";

// Extend context with session and conversations
type SessionData = { step?: string };
type MyContext = Context & ConversationFlavor & SessionFlavor<SessionData>;

const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN!);

bot.use(session({ initial: (): SessionData => ({}) }));
bot.use(conversations());
```

### Conversations (FSM dialogs)

Conversations are the primary pattern for multi-step dialogs (onboarding, task addition).

```typescript
import { Conversation, ConversationFlavor } from "@grammyjs/conversations";

type MyConversation = Conversation<MyContext>;

async function onboardingConversation(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("В каком часовом поясе ты живёшь?");
  const timezoneMsg = await conversation.wait();
  const timezone = timezoneMsg.message?.text ?? "";

  await ctx.reply("Расскажи как выглядит твой обычный день...");
  const scheduleMsg = await conversation.wait();

  // Call LLM to parse schedule
  const parsed = await conversation.external(() =>
    parseDaySchedule(scheduleMsg.message?.text ?? "")
  );

  // Confirm with user
  await ctx.reply(`Вот что получилось:\n${formatSchedule(parsed)}\n\nВсё верно?`);
  const confirm = await conversation.wait();

  if (confirm.message?.text?.toLowerCase().includes("да")) {
    await conversation.external(() => saveUserProfile(ctx.from!.id, parsed));
    await ctx.reply("Готово! Завтра в 9:00 получишь первый план на день.");
  }
}

// Register conversation
bot.use(createConversation(onboardingConversation, "onboarding"));

// Enter conversation from command
bot.command("start", async (ctx) => {
  const user = await getUserByTelegramId(ctx.from!.id);
  if (!user) {
    await ctx.conversation.enter("onboarding");
  } else {
    await ctx.reply("Добро пожаловать обратно!");
  }
});
```

### conversation.external() — side effects inside conversations

All async side effects (DB calls, LLM calls) inside a conversation MUST use `conversation.external()`. This ensures replay safety.

```typescript
// CORRECT
const result = await conversation.external(async () => {
  return await db.query("SELECT ...");
});

// WRONG — will break on replay
const result = await db.query("SELECT ...");
```

### Free-text handler (catch-all)

```typescript
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from!.id;

  // Detect intent via LLM
  const intent = await detectIntent(userId, text);

  switch (intent.type) {
    case "add_task":
      await ctx.conversation.enter("addTask");
      break;
    case "mark_done":
      await handleMarkDone(ctx, intent.data);
      break;
    case "show_plan":
      await handleShowPlan(ctx);
      break;
    default:
      await ctx.reply("Не понял. Попробуй иначе.");
  }
});
```

### Sending formatted messages

Grammy uses HTML or Markdown parse mode:

```typescript
// HTML (recommended — predictable escaping)
await ctx.reply(
  `<b>📋 План на сегодня</b>\n\n` +
  `<b>💼 Работа</b>  11:00 – 19:00\n` +
  `  ⚡ Тесты к авторизации  (~2ч)\n` +
  `  • Код-ревью Антона  (~30м)`,
  { parse_mode: "HTML" }
);

// Escape user content before embedding in HTML
import { escapeHtml } from "./utils";
await ctx.reply(`Задача: <b>${escapeHtml(task.title)}</b>`, { parse_mode: "HTML" });
```

### Error handling

```typescript
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`Error for update ${ctx.update.update_id}:`, err.error);
  // Don't crash — log and continue
});
```

### Webhook vs Polling

For Railway/Fly.io (long-running): use **webhooks** in production, **polling** in development.

```typescript
if (process.env.NODE_ENV === "production") {
  // Express + webhook
  const app = express();
  app.use(express.json());
  app.use(`/webhook/${process.env.TELEGRAM_BOT_TOKEN}`, webhookCallback(bot, "express"));
  app.listen(PORT);
} else {
  // Long polling for dev
  bot.start();
}
```

## Patterns for This Project

### Conversation abort safety

Always handle `/cancel` or unexpected commands inside conversations:

```typescript
async function addTaskConversation(conversation: MyConversation, ctx: MyContext) {
  await ctx.reply("Что нужно сделать?");

  const msg = await conversation.waitFor("message:text", {
    otherwise: (ctx) => ctx.reply("Пожалуйста, отправь текст."),
  });

  if (msg.message.text === "/cancel") {
    await ctx.reply("Отменено.");
    return;
  }
  // ...
}
```

### Passing data between conversation steps

Use `conversation.external()` to store and retrieve state rather than local variables when side effects are involved:

```typescript
const taskDraft = await conversation.external(async () => {
  const draft = await llm.parseTask(userMessage);
  await db.saveDraft(userId, draft); // persist in case of restart
  return draft;
});
```

### Keyboard shortcuts

For yes/no confirmations, use inline keyboards:

```typescript
import { InlineKeyboard } from "grammy";

const keyboard = new InlineKeyboard()
  .text("✅ Да, верно", "confirm_yes")
  .text("✏️ Поправить", "confirm_edit");

await ctx.reply("Всё верно?", { reply_markup: keyboard });

// In conversation, wait for callback
const callbackCtx = await conversation.waitForCallbackQuery(["confirm_yes", "confirm_edit"]);
await callbackCtx.answerCallbackQuery();
```

## Dependencies

```json
{
  "grammy": "^1.x",
  "@grammyjs/conversations": "^2.x",
  "@grammyjs/types": "^3.x"
}
```

## Key Rules

1. All DB/LLM calls inside conversations → `conversation.external()`
2. Always handle `bot.catch()` — never let unhandled errors crash the process
3. Escape user-provided strings before embedding in HTML parse_mode messages
4. Use webhooks in production; polling only for local dev
5. Register all conversations before `bot.start()` or webhook setup
