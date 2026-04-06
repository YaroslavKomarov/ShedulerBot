import { bot } from './index.js'
import { getUserByTelegramId } from '../db/users.js'
import { getPeriodsForDay } from '../db/periods.js'
import { getTaskQueue } from '../db/tasks.js'
import { generateDayPlanMessage } from '../llm/plan.js'
import { getTodayInTimezone } from '../cron/morning-plan.js'
import { logger } from '../lib/logger.js'
import type { BotContext } from './index.js'
import type { PeriodPlan } from '../llm/plan.js'
import type { DbTask } from '../types/index.js'

/**
 * Builds and sends the plan for a given date offset (0 = today, 1 = tomorrow).
 * Can be called from bot command handlers or the free-text router.
 */
export async function sendPlanForDate(ctx: BotContext, dayOffset: 0 | 1): Promise<void> {
  if (!ctx.from) return

  const telegramId = ctx.from.id
  const user = await getUserByTelegramId(telegramId)

  if (!user) {
    await ctx.reply('Сначала пройди /start для настройки.')
    return
  }

  const { date: baseDate, dayOfWeek: baseDow } = getTodayInTimezone(user.timezone)

  // Compute target date + day-of-week for offset
  let targetDate: string
  let targetDow: number

  if (dayOffset === 0) {
    targetDate = baseDate
    targetDow = baseDow
  } else {
    const d = new Date(`${baseDate}T12:00:00`)
    d.setDate(d.getDate() + dayOffset)
    targetDate = d.toISOString().split('T')[0]
    targetDow = d.getDay()
  }

  logger.debug('[bot/plan-helper] sendPlanForDate', {
    userId: user.id,
    targetDate,
    targetDow,
    dayOffset,
  })

  const periods = await getPeriodsForDay(user.id, targetDow)

  if (periods.length === 0) {
    await ctx.reply(`В этот день (${targetDate}) нет активных периодов.`)
    return
  }

  const periodPlans: PeriodPlan[] = []

  for (const period of periods) {
    const tasks = await getTaskQueue(user.id, period.slug, targetDate)
    periodPlans.push({ period, tasks, slots: [] })
  }

  const message = await generateDayPlanMessage(user, targetDate, periodPlans)
  await ctx.reply(message, { parse_mode: 'Markdown' })
}

/**
 * Builds and sends today's task queue grouped by periods.
 */
export async function sendQueueForToday(ctx: BotContext): Promise<void> {
  if (!ctx.from) return

  const telegramId = ctx.from.id
  const user = await getUserByTelegramId(telegramId)

  if (!user) {
    await ctx.reply('Сначала пройди /start для настройки.')
    return
  }

  const { date, dayOfWeek } = getTodayInTimezone(user.timezone)
  const periods = await getPeriodsForDay(user.id, dayOfWeek)

  if (periods.length === 0) {
    await ctx.reply('Сегодня нет активных периодов.')
    return
  }

  const periodQueues: Array<{ period: { name: string; start_time: string; end_time: string }; tasks: DbTask[] }> = []
  let totalTasks = 0

  for (const period of periods) {
    const tasks = await getTaskQueue(user.id, period.slug, date)
    periodQueues.push({ period, tasks })
    totalTasks += tasks.length
  }

  logger.info('[bot/plan-helper] sendQueueForToday', {
    userId: user.id,
    periodCount: periods.length,
    totalTasks,
  })

  if (totalTasks === 0) {
    await ctx.reply('Очередь пуста. Добавь задачи! 📝')
    return
  }

  // Format date as DD.MM
  const [, mm, dd] = date.split('-')
  const lines: string[] = [`📅 *Очередь задач на сегодня (${dd}.${mm}):*`, '']

  for (const { period, tasks } of periodQueues) {
    lines.push(`*${period.name} (${period.start_time.slice(0, 5)}–${period.end_time.slice(0, 5)}):*`)
    if (tasks.length === 0) {
      lines.push('_Пуст_')
    } else {
      tasks.forEach((t, i) => {
        let line = `${i + 1}. ${t.title}`
        if (t.estimated_minutes) line += ` (~${t.estimated_minutes} мин)`
        if (t.is_urgent) line += ' 🔴'
        lines.push(line)
      })
    }
    lines.push('')
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

/**
 * Sends today's plan to a user by telegram_id (used by cron without ctx).
 */
export async function sendTodayPlanToUser(telegramId: number): Promise<void> {
  const user = await getUserByTelegramId(telegramId)
  if (!user) return

  const { date, dayOfWeek } = getTodayInTimezone(user.timezone)
  const periods = await getPeriodsForDay(user.id, dayOfWeek)

  const periodPlans: PeriodPlan[] = []
  for (const period of periods) {
    const tasks = await getTaskQueue(user.id, period.slug, date)
    periodPlans.push({ period, tasks, slots: [] })
  }

  const message = await generateDayPlanMessage(user, date, periodPlans)
  await bot.api.sendMessage(telegramId, message, { parse_mode: 'Markdown' })
}
