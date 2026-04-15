import { bot } from '../bot/index.js'
import { getTaskQueue, getUnassignedTodayTasks } from '../db/tasks.js'
import { getTodayInTimezone } from './morning-plan.js'
import { logger } from '../lib/logger.js'
import type { DbUser, DbPeriod } from '../types/index.js'

function formatTaskList(tasks: Awaited<ReturnType<typeof getTaskQueue>>): string {
  if (tasks.length === 0) return '_Задачи не запланированы_'

  return tasks
    .map((t) => {
      const prefix = t.is_urgent ? '🔴' : '•'
      const durationStr = t.estimated_minutes ? ` ~${t.estimated_minutes} мин` : ''
      return `${prefix} ${t.title}${durationStr}`
    })
    .join('\n')
}

export async function sendPeriodPreview(user: DbUser, period: DbPeriod): Promise<void> {
  logger.info('[cron/period-notify] sendPeriodPreview', {
    userId: user.id,
    periodSlug: period.slug,
  })

  try {
    const { date } = getTodayInTimezone(user.timezone)
    const tasks = await getTaskQueue(user.id, period.slug, date)
    const unassigned = await getUnassignedTodayTasks(user.id, date)
    const seenIds = new Set(tasks.map((t) => t.id))
    const allTasks = [...tasks, ...unassigned.filter((t) => !seenIds.has(t.id))]
    const preview = allTasks.slice(0, 5)

    const text =
      `⏰ Через 10 минут начинается *${period.name}* (${period.start_time}–${period.end_time})\n\n` +
      `Задачи:\n${formatTaskList(preview)}` +
      (allTasks.length > 5 ? `\n_...и ещё ${allTasks.length - 5}_` : '')

    await bot.api.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error('[cron/period-notify] sendPeriodPreview error', {
      userId: user.id,
      periodSlug: period.slug,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function sendPeriodStart(user: DbUser, period: DbPeriod): Promise<void> {
  logger.info('[cron/period-notify] sendPeriodStart', {
    userId: user.id,
    periodSlug: period.slug,
  })

  try {
    const { date } = getTodayInTimezone(user.timezone)
    const tasks = await getTaskQueue(user.id, period.slug, date)

    // Also include tasks scheduled for today with no period assignment
    const unassigned = await getUnassignedTodayTasks(user.id, date)
    const seenIds = new Set(tasks.map((t) => t.id))
    const extraTasks = unassigned.filter((t) => !seenIds.has(t.id))

    const allTasks = [...tasks, ...extraTasks]

    if (extraTasks.length > 0) {
      logger.info('[cron/period-notify] sendPeriodStart: included unassigned today tasks', {
        userId: user.id,
        periodSlug: period.slug,
        count: extraTasks.length,
      })
    }

    const text =
      `🚀 Начался период *${period.name}*!\n\n` +
      `*План:*\n${formatTaskList(allTasks)}`

    await bot.api.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error('[cron/period-notify] sendPeriodStart error', {
      userId: user.id,
      periodSlug: period.slug,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function sendPeriodPreEnd(user: DbUser, period: DbPeriod): Promise<void> {
  logger.info('[cron/period-notify] sendPeriodPreEnd', {
    userId: user.id,
    periodSlug: period.slug,
  })

  try {
    const text =
      `⏳ Период *${period.name}* заканчивается через 10 минут.\n` +
      `Успей отметить выполненное!`

    await bot.api.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error('[cron/period-notify] sendPeriodPreEnd error', {
      userId: user.id,
      periodSlug: period.slug,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function sendPeriodEnd(user: DbUser, period: DbPeriod): Promise<void> {
  logger.info('[cron/period-notify] sendPeriodEnd', {
    userId: user.id,
    periodSlug: period.slug,
  })

  try {
    const { date } = getTodayInTimezone(user.timezone)
    const pendingTasks = await getTaskQueue(user.id, period.slug, date)

    const taskListText =
      pendingTasks.length > 0
        ? `\n\n*Незавершённые задачи:*\n${formatTaskList(pendingTasks)}`
        : '\n\n✅ Все задачи выполнены!'

    const text = `✅ Период *${period.name}* завершён! Что удалось сделать?${taskListText}`

    await bot.api.sendMessage(user.telegram_id, text, { parse_mode: 'Markdown' })
  } catch (err) {
    logger.error('[cron/period-notify] sendPeriodEnd error', {
      userId: user.id,
      periodSlug: period.slug,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
