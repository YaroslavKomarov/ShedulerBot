import { Bot, Context, session, SessionFlavor, InlineKeyboard } from 'grammy'
import { LLMInsufficientCreditsError } from '../llm/client.js'
import { conversations, createConversation, type ConversationFlavor } from '@grammyjs/conversations'
import { logger } from '../lib/logger.js'
import { getUserByTelegramId } from '../db/users.js'
import { clearChatHistory } from '../db/chat-history.js'
import { onboardingConversation } from './conversations/onboarding.js'
import { settingsConversation } from './conversations/settings.js'
import { retroDateInputConversation } from './conversations/retro-date-input.js'
import { handleFreeText, handleText } from './handlers.js'
import { transcribeVoice } from './middleware/voice.js'
import { sendPlanForDate, sendQueueForToday } from './plan-helper.js'
import { getUserByTelegramId as getUserById } from '../db/users.js'
import { getTaskQueue, updateTask } from '../db/tasks.js'
import { getTodayInTimezone } from '../cron/morning-plan.js'
import { sendNextRescheduleTask } from '../cron/retrospective.js'

// Session data (conversation state is managed by the conversations plugin)
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface SessionData {}

export type BotContext = Context & SessionFlavor<SessionData> & ConversationFlavor<Context & SessionFlavor<SessionData>>

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
  throw new Error('Missing required env var: TELEGRAM_BOT_TOKEN must be set')
}

export const bot = new Bot<BotContext>(token)

// Session middleware — in-memory for now; can be replaced with Supabase adapter later
bot.use(session({ initial: (): SessionData => ({}) }))

// Conversations middleware — must be installed after session
bot.use(conversations())

// Register conversations
bot.use(createConversation(onboardingConversation))
bot.use(createConversation(settingsConversation))
bot.use(createConversation(retroDateInputConversation))

// /start command — route new users to onboarding, existing users to plan stub
bot.command('start', async (ctx) => {
  const telegramId = ctx.from?.id
  if (!telegramId) return

  const user = await getUserByTelegramId(telegramId)
  const isNew = user === null

  logger.info('[bot] /start received', { userId: telegramId, isNew })

  if (isNew) {
    await ctx.conversation.enter('onboardingConversation')
  } else {
    await clearChatHistory(user.id)
    await ctx.reply('С возвращением! Вот твой план на сегодня... (скоро)')
  }
})

// /settings — open settings menu
bot.command('settings', async (ctx) => {
  logger.info('[bot] /settings command', { userId: ctx.from?.id })
  await ctx.conversation.enter('settingsConversation')
})

// /guide — show system logic cheat sheet
bot.command('guide', async (ctx) => {
  logger.info('[bot] /guide command', { userId: ctx.from?.id })
  await ctx.reply(
    `📖 *Как работает планировщик*

*Периоды активности*
Ты настраиваешь периоды в онбординге: например, «Утро» \\(09:00–12:00\\) или «Работа» \\(14:00–18:00\\)\\. Каждый период привязан к определённым дням недели\\.

У каждого периода есть *очередь задач*\\. Два периода могут делить одну очередь — для этого им назначается одинаковый queue\\_slug\\. Например, «Работа утром» и «Работа вечером» могут тянуть задачи из одного пула\\.

*Типы задач*
🔴 *Срочная* — без даты и дедлайна, всегда первая в очереди\\. В каждой очереди может быть только одна\\.
📅 *Плановая* — привязана к конкретной дате\\. Появляется только в этот день\\. Дедлайн не назначается\\.
⏳ *С дедлайном* — нет конкретной даты, но есть крайний срок\\. Появляется каждый день до истечения дедлайна\\.
🔄 *Плавающая* — нет ни даты, ни дедлайна\\. Появляется каждый день, пока не выполнена\\.

*Сортировка в очереди*
1\\. 🔴 Срочная — абсолютный верх
2\\. 📅 Плановые на сегодня — сразу под срочной, между собой по дате создания
3\\. ⏳ С дедлайном — чем ближе срок, тем выше
4\\. 🔄 Плавающие — по дате создания

*Вместимость периода*
При добавлении плановой задачи бот проверяет, влезает ли она по времени\\. Если нет — предупредит и спросит подтверждение\\. Сверхурочные задачи помечаются ⚠️\\.

*Гарантированное отображение*
Срочная задача, плановые на сегодня и задачи с дедлайном сегодня всегда присутствуют в уведомлениях — даже если период уже заполнен\\.

*Уведомления*
— За 10 минут до старта — превью: первые 5 задач
— В момент старта — задачи по вместимости \\+ гарантированные \\+ счётчик overflow
— За 10 минут до конца — напоминание отметить выполненное
— В момент конца — что осталось невыполненным
— Утренний план — сводка по всем периодам
— Ретроспектива — в конце дня

*Ретроспектива*
Попадают задачи, запланированные на сегодня и не выполненные, а также задачи с истёкшим дедлайном\\. По каждой можно: перенести на завтра, назначить новую дату или дедлайн, отправить в бэклог, отметить выполненной или отменить\\.

*Бэклог*
Плавающие задачи без дедлайна\\. Чтобы посмотреть — напиши боту, например: «покажи бэклог периода Работа»\\.`,
    { parse_mode: 'MarkdownV2' },
  )
})

// /plan — show today's plan
bot.command('plan', async (ctx) => {
  logger.info('[bot] /plan command', { userId: ctx.from?.id })
  await sendPlanForDate(ctx, 0)
})

// /tomorrow — show tomorrow's plan
bot.command('tomorrow', async (ctx) => {
  logger.info('[bot] /tomorrow command', { userId: ctx.from?.id })
  await sendPlanForDate(ctx, 1)
})

// /queue — show today's task queue grouped by periods
bot.command('queue', async (ctx) => {
  logger.info('[bot] /queue command', { userId: ctx.from?.id })
  await sendQueueForToday(ctx)
})

// /done — inline keyboard for quick task completion
bot.command('done', async (ctx) => {
  if (!ctx.from) return
  const telegramId = ctx.from.id

  const user = await getUserById(telegramId)
  if (!user) {
    await ctx.reply('Сначала пройди /start для настройки.')
    return
  }

  const { date } = getTodayInTimezone(user.timezone)
  const tasks = await getTaskQueue(user.id, null, date)

  logger.info('[bot] /done command', { userId: telegramId, taskCount: tasks.length })

  if (tasks.length === 0) {
    await ctx.reply('Нет задач на сегодня 🎉')
    return
  }

  const keyboard = new InlineKeyboard()
  for (const task of tasks) {
    const label = task.title.length > 40 ? task.title.slice(0, 40) + '…' : task.title
    keyboard.text(label, `done:${task.id}`).row()
  }

  await ctx.reply('Выбери выполненную задачу:', { reply_markup: keyboard })
})

// Callback query: done:<taskId>
bot.callbackQuery(/^done:(.+)$/, async (ctx) => {
  const taskId = ctx.match[1]
  const telegramId = ctx.from.id

  logger.info('[bot] done callback', { userId: telegramId, taskId })

  try {
    const updated = await updateTask(taskId, { status: 'done' })
    await ctx.answerCallbackQuery({ text: '✅ Отмечено!' })
    await ctx.editMessageText(`✅ Выполнено: ${updated.title}`)
  } catch (_err) {
    logger.warn('[bot] done callback: task not found', { userId: telegramId, taskId })
    await ctx.answerCallbackQuery({ text: 'Задача не найдена 🤷' })
  }
})

// Callback query: retro:<action>:<taskId>
bot.callbackQuery(/^retro:(tomorrow|backlog|done|cancel|set_date|set_deadline):(.+)$/, async (ctx) => {
  const action = ctx.match[1] as 'tomorrow' | 'backlog' | 'done' | 'cancel' | 'set_date' | 'set_deadline'
  const taskId = ctx.match[2]
  const telegramId = ctx.from.id

  logger.info('[bot] retro callback', { userId: telegramId, action, taskId })

  const user = await getUserById(telegramId)
  if (!user) {
    logger.warn('[bot] retro callback: user not found', { telegramId })
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден 🤷' })
    return
  }

  try {
    if (action === 'tomorrow') {
      const { date } = getTodayInTimezone(user.timezone)
      // Calculate tomorrow by parsing the date and adding 1 day
      const d = new Date(date + 'T00:00:00Z')
      d.setUTCDate(d.getUTCDate() + 1)
      const tomorrow = d.toISOString().slice(0, 10)
      await updateTask(taskId, { scheduled_date: tomorrow })
      await ctx.answerCallbackQuery({ text: '⏭ Перенесено на завтра' })
    } else if (action === 'backlog') {
      await updateTask(taskId, { scheduled_date: null, deadline_date: null })
      await ctx.answerCallbackQuery({ text: '📋 Перемещено в бэклог' })
    } else if (action === 'done') {
      await updateTask(taskId, { status: 'done' })
      await ctx.answerCallbackQuery({ text: '✅ Отмечено выполненным' })
    } else if (action === 'cancel') {
      await updateTask(taskId, { status: 'cancelled' })
      await ctx.answerCallbackQuery({ text: '❌ Задача отменена' })
    } else if (action === 'set_date' || action === 'set_deadline') {
      const { date: today } = getTodayInTimezone(user.timezone)
      logger.info('[bot] retro set_date/set_deadline: entering conversation', { taskId, userId: user.id })
      await ctx.answerCallbackQuery()
      await ctx.editMessageReplyMarkup()
      await ctx.conversation.enter('retroDateInputConversation', {
        action,
        taskId,
        userId: user.id,
        telegramId: user.telegram_id,
        today,
      })
      return
    }

    await ctx.editMessageReplyMarkup()
    await sendNextRescheduleTask(telegramId, user.id)
  } catch (err) {
    logger.error('[bot] retro callback: update failed', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
    await ctx.answerCallbackQuery({ text: 'Ошибка при обновлении задачи 🤷' })
  }
})

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

// Catch-all text handler — must be after all createConversation registrations
bot.on('message:text', handleFreeText)

// Global error handler — log without crashing
bot.catch((err) => {
  const cause = err.error
  const isCreditsError =
    cause instanceof LLMInsufficientCreditsError ||
    (cause instanceof Error && cause.name === 'LLMInsufficientCreditsError') ||
    (cause instanceof Error && cause.message === 'OpenRouter balance is insufficient')

  if (isCreditsError) {
    logger.warn('[bot] OpenRouter balance insufficient', { userId: err.ctx.from?.id })
    void err.ctx.reply(
      '⚠️ Недостаточно средств на OpenRouter.\n' +
      'Пополни баланс на openrouter.ai и попробуй снова.'
    )
    return
  }

  logger.error('[bot] Unhandled error', {
    error: err.message,
    update: err.ctx?.update,
  })
})

logger.info('[bot] Bot initialized')
