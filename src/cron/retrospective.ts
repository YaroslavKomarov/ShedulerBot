import { bot } from '../bot/index.js'
import { InlineKeyboard } from 'grammy'
import { getTasksByDate, getBacklog, getOverdueDeadlineTasks } from '../db/tasks.js'
import { generateRetrospectiveMessage } from '../llm/retrospective.js'
import { enqueueReschedule, dequeueNextTask } from './reschedule-queue.js'
import { getTodayInTimezone } from './morning-plan.js'
import { logger } from '../lib/logger.js'
import type { DbUser } from '../types/index.js'

export async function sendNextRescheduleTask(telegramId: number, userId: string): Promise<void> {
  const task = dequeueNextTask(userId)

  if (!task) {
    logger.debug('[cron/retrospective] sendNextRescheduleTask: queue empty', { userId })
    await bot.api.sendMessage(telegramId, '✅ Все задачи разобраны!')
    return
  }

  logger.debug('[cron/retrospective] sendNextRescheduleTask: sending task', { userId, taskId: task.id })

  const header = task.deadline_date && !task.scheduled_date
    ? `⏰ Дедлайн просрочен: *${task.title}*`
    : `📌 Задача не выполнена: *${task.title}*`

  const keyboard = new InlineKeyboard()
    .text('⏭ На завтра', `retro:tomorrow:${task.id}`).row()
    .text('📅 Назначить дату', `retro:set_date:${task.id}`).row()
    .text('🎯 Назначить дедлайн', `retro:set_deadline:${task.id}`).row()
    .text('📋 В бэклог', `retro:backlog:${task.id}`).row()
    .text('✅ Всё равно выполнено', `retro:done:${task.id}`).row()
    .text('❌ Отменить', `retro:cancel:${task.id}`).row()

  await bot.api.sendMessage(
    telegramId,
    `${header}\nЧто сделать?`,
    { parse_mode: 'Markdown', reply_markup: keyboard },
  )
}

export async function runRetrospective(user: DbUser): Promise<void> {
  const { date } = getTodayInTimezone(user.timezone)

  logger.info('[cron/retrospective] runRetrospective start', { userId: user.id, date })

  try {
    const allTasks = await getTasksByDate(user.id, date)
    const doneTasks = allTasks.filter((t) => t.status === 'done')
    const missedTasks = allTasks.filter((t) => t.status === 'pending')

    const overdueDeadlineTasks = await getOverdueDeadlineTasks(user.id, date)

    const backlog = await getBacklog(user.id)
    const backlogNoDate = backlog.filter((t) => !t.deadline_date && !t.is_urgent)

    logger.info('[cron/retrospective] tasks summary', {
      userId: user.id,
      done: doneTasks.length,
      missed: missedTasks.length,
      overdueDeadline: overdueDeadlineTasks.length,
      backlogNoDate: backlogNoDate.length,
    })

    const tasksToReschedule = [...missedTasks, ...overdueDeadlineTasks]

    const message = await generateRetrospectiveMessage(user, date, doneTasks, tasksToReschedule, backlogNoDate)

    await bot.api.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' })
    logger.info('[cron/retrospective] retro message sent', { userId: user.id })

    if (tasksToReschedule.length > 0) {
      logger.info('[cron/retrospective] starting reschedule flow', {
        userId: user.id,
        missedCount: missedTasks.length,
        overdueDeadlineCount: overdueDeadlineTasks.length,
      })
      enqueueReschedule(user.id, tasksToReschedule)
      await sendNextRescheduleTask(user.telegram_id, user.id)
    } else if (backlogNoDate.length > 0) {
      await bot.api.sendMessage(
        user.telegram_id,
        `📋 В бэклоге есть ${backlogNoDate.length} задач без даты. Напиши /backlog, чтобы разобраться с ними.`,
      )
    }
  } catch (err) {
    logger.error('[cron/retrospective] error', {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
