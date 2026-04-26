import type { Conversation } from '@grammyjs/conversations'
import type { BotContext } from '../index.js'
import { waitForText } from './helpers.js'
import { updateTask } from '../../db/tasks.js'
import { sendNextRescheduleTask } from '../../cron/retrospective.js'
import { logger } from '../../lib/logger.js'

type RetroDateConversation = Conversation<BotContext, BotContext>

type RetroDateInputParams = {
  action: 'set_date' | 'set_deadline'
  taskId: string
  userId: string
  telegramId: number
  today: string
}

function parseRetroDate(input: string, today: string): string | null {
  const s = input.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const dmY = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (dmY) return `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`
  const dm = s.match(/^(\d{1,2})\.(\d{1,2})$/)
  if (dm) return `${today.slice(0, 4)}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`
  return null
}

export async function retroDateInputConversation(
  conversation: RetroDateConversation,
  ctx: BotContext,
  params: RetroDateInputParams,
): Promise<void> {
  const { action, taskId, userId, telegramId, today } = params

  logger.info('[bot/retroDateInput] start', { action, taskId, telegramId })

  const prompt =
    action === 'set_date'
      ? '📅 На какую дату перенести задачу?\nВведи дату (например, 28.04 или 2026-04-28):'
      : '🎯 Какой дедлайн поставить?\nВведи дату (например, 28.04 или 2026-04-28):'

  await ctx.reply(prompt)

  const { text: firstInput } = await waitForText(conversation)
  logger.debug('[bot/retroDateInput] date input received', { raw: firstInput, attempt: 1 })

  let parsed = parseRetroDate(firstInput, today)

  if (parsed === null) {
    logger.info('[bot/retroDateInput] parse failed, retrying', { attempt: 1 })
    await ctx.reply('Не удалось распознать дату. Попробуй ещё раз (28.04 или 2026-04-28):')

    const { text: secondInput } = await waitForText(conversation)
    logger.debug('[bot/retroDateInput] date input received', { raw: secondInput, attempt: 2 })

    parsed = parseRetroDate(secondInput, today)
  }

  if (parsed === null) {
    logger.info('[bot/retroDateInput] parse exhausted, task unchanged', { taskId })
    await ctx.reply('Не удалось распознать дату, задача осталась без изменений.')
    await sendNextRescheduleTask(telegramId, userId)
    return
  }

  const update =
    action === 'set_date'
      ? { scheduled_date: parsed, deadline_date: null }
      : { deadline_date: parsed, scheduled_date: null }

  await conversation.external(() => updateTask(taskId, update))
  logger.info('[bot/retroDateInput] updated task', { taskId, action, date: parsed })

  await sendNextRescheduleTask(telegramId, userId)
}
