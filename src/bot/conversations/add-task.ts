import { InlineKeyboard } from 'grammy'
import type { Conversation } from '@grammyjs/conversations'
import type { BotContext } from '../index.js'
import { getUserByTelegramId } from '../../db/users.js'
import { getUserPeriods } from '../../db/periods.js'
import { createTask } from '../../db/tasks.js'
import { parseTaskMessage, type ParsedTask } from '../../llm/parse-task.js'
import { callLLM, STRONG_MODEL } from '../../llm/client.js'
import { logger } from '../../lib/logger.js'

type AddTaskConversation = Conversation<BotContext, BotContext>

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

function tomorrowIso(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().split('T')[0]
}

function formatConfirmation(task: ParsedTask): string {
  const lines = ['✅ Задача добавлена:', `📌 ${task.title}`]
  if (task.scheduled_date) {
    const isToday = task.scheduled_date === todayIso()
    const isTomorrow = task.scheduled_date === tomorrowIso()
    const dateLabel = isToday ? 'Сегодня' : isTomorrow ? 'Завтра' : task.scheduled_date
    lines.push(`🗓 ${dateLabel}`)
  } else {
    lines.push('🗓 Без даты')
  }
  if (task.estimated_minutes) {
    const h = Math.floor(task.estimated_minutes / 60)
    const m = task.estimated_minutes % 60
    const label = h > 0 ? `${h} ч ${m > 0 ? `${m} мин` : ''}`.trim() : `${m} мин`
    lines.push(`⏱ ${label}`)
  } else {
    lines.push('⏱ Время не указано')
  }
  return lines.join('\n')
}

async function generateDescription(title: string): Promise<string | null> {
  try {
    const response = await callLLM({
      model: STRONG_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Напиши одно короткое предложение-описание для задачи. Только предложение, без лишнего текста.',
        },
        { role: 'user', content: title },
      ],
      temperature: 0.5,
    })
    return response.trim()
  } catch {
    return null
  }
}

export async function addTaskConversation(
  conversation: AddTaskConversation,
  ctx: BotContext,
  initialText: string,
): Promise<void> {
  const telegramId = ctx.from?.id
  logger.info('[conversation/add-task] start', { userId: telegramId })

  // Load user and periods
  const user = await conversation.external(() => getUserByTelegramId(telegramId!))
  if (!user) {
    await ctx.reply('Сначала пройди настройку — напиши /start')
    return
  }

  const periods = await conversation.external(() => getUserPeriods(user.id))
  const userContext = {
    timezone: user.timezone,
    today: todayIso(),
    periods: periods.map((p) => ({ name: p.name, slug: p.slug })),
  }

  // Step 1: Parse initial message
  let draft = await conversation.external(() => parseTaskMessage(initialText, userContext))
  logger.debug('[conversation/add-task] parsed draft', {
    title: draft.title,
    is_urgent: draft.is_urgent,
    needs_clarification: draft.needs_clarification,
  })

  // Step 2: Clarification loop (max 3 attempts)
  for (let attempt = 0; attempt < 3 && draft.needs_clarification; attempt++) {
    logger.debug('[conversation/add-task] clarification round', { attempt: attempt + 1 })
    await ctx.reply(draft.clarification_question ?? 'Уточни задачу, пожалуйста.')
    const clarifyCtx = await conversation.waitFor('message:text')
    draft = await conversation.external(() =>
      parseTaskMessage(clarifyCtx.message.text, userContext),
    )
  }

  if (draft.needs_clarification) {
    await ctx.reply('Не удалось разобрать задачу. Попробуй написать её подробнее.')
    return
  }

  // Step 3: Description — generate if missing
  if (!draft.description) {
    const generated = await conversation.external(() => generateDescription(draft.title))
    if (generated) {
      const keyboard = new InlineKeyboard()
        .text('✅ Да', 'desc_yes')
        .text('➡️ Пропустить', 'desc_skip')

      await ctx.reply(`Добавить описание?\n_${generated}_`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      })

      const descCtx = await conversation.waitForCallbackQuery(/^desc_/)
      await descCtx.answerCallbackQuery()

      if (descCtx.callbackQuery.data === 'desc_yes') {
        draft = { ...draft, description: generated }
      }
    }
  }

  // Step 4: Estimated minutes — ask if missing
  if (!draft.estimated_minutes) {
    const keyboard = new InlineKeyboard()
      .text('15 мин', 'est_15')
      .text('30 мин', 'est_30')
      .text('1 час', 'est_60')
      .text('Пропустить', 'est_skip')

    await ctx.reply('Сколько примерно займёт?', { reply_markup: keyboard })

    const estCtx = await conversation.waitForCallbackQuery(/^est_/)
    await estCtx.answerCallbackQuery()

    const choice = estCtx.callbackQuery.data
    if (choice === 'est_15') draft = { ...draft, estimated_minutes: 15 }
    else if (choice === 'est_30') draft = { ...draft, estimated_minutes: 30 }
    else if (choice === 'est_60') draft = { ...draft, estimated_minutes: 60 }
  }

  // Step 5: Scheduled date — ask if missing
  if (!draft.scheduled_date) {
    const keyboard = new InlineKeyboard()
      .text('Сегодня', 'date_today')
      .text('Завтра', 'date_tomorrow')
      .text('Выбрать дату', 'date_pick')
      .text('Без даты', 'date_none')

    await ctx.reply('На когда запланировать?', { reply_markup: keyboard })

    const dateCtx = await conversation.waitForCallbackQuery(/^date_/)
    await dateCtx.answerCallbackQuery()

    const choice = dateCtx.callbackQuery.data
    if (choice === 'date_today') {
      draft = { ...draft, scheduled_date: todayIso() }
    } else if (choice === 'date_tomorrow') {
      draft = { ...draft, scheduled_date: tomorrowIso() }
    } else if (choice === 'date_pick') {
      await dateCtx.reply('Введи дату в формате ДД.ММ.ГГГГ или ГГГГ-ММ-ДД:')
      const pickCtx = await conversation.waitFor('message:text')
      const raw = pickCtx.message.text.trim()
      // Try to parse "DD.MM.YYYY" or "YYYY-MM-DD"
      const ddmmyyyy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw)
      if (ddmmyyyy) {
        draft = { ...draft, scheduled_date: `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}` }
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        draft = { ...draft, scheduled_date: raw }
      } else {
        await ctx.reply('Не распознал дату, оставляю без даты.')
      }
    }
    // date_none → scheduled_date stays null
  }

  // Step 6: Save task
  const saved = await conversation.external(() =>
    createTask({
      user_id: user.id,
      title: draft.title,
      description: draft.description,
      is_urgent: draft.is_urgent,
      deadline_date: draft.deadline_date,
      estimated_minutes: draft.estimated_minutes,
      period_slug: draft.period_slug,
      scheduled_date: draft.scheduled_date,
      source: 'user',
    }),
  )

  logger.info('[conversation/add-task] task saved', {
    taskId: saved.id,
    title: saved.title,
    scheduled_date: saved.scheduled_date,
  })

  await ctx.reply(formatConfirmation(draft))
}
