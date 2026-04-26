import { bot } from '../bot/index.js'
import { getPeriodsForDay } from '../db/periods.js'
import { getTaskQueue, getBacklog, getUnassignedTodayTasks } from '../db/tasks.js'
import { generateDayPlanMessage } from '../llm/plan.js'
import { syncDayPlan } from '../calendar/sync.js'
import { logger } from '../lib/logger.js'
import { getTodayInTimezone } from '../lib/date.js'
export { getTodayInTimezone } from '../lib/date.js'
import type { DbUser, DbTask, DbPeriod } from '../types/index.js'
import type { PeriodPlan, TaskSlot } from '../llm/plan.js'

const DEFAULT_TASK_MINUTES = 30

/**
 * Adds minutes to a "HH:MM" time string, returns new "HH:MM".
 */
function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = h * 60 + m + minutes
  const newH = Math.floor(total / 60) % 24
  const newM = total % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

/**
 * Returns the number of minutes a period lasts (end_time - start_time).
 */
function periodDurationMinutes(period: DbPeriod): number {
  const [sh, sm] = period.start_time.split(':').map(Number)
  const [eh, em] = period.end_time.split(':').map(Number)
  return (eh * 60 + em) - (sh * 60 + sm)
}

/**
 * Distributes tasks into time slots within a period.
 * Returns { slots, overflow } where overflow = tasks that didn't fit.
 */
export function buildSlots(period: DbPeriod, tasks: DbTask[]): { slots: TaskSlot[]; overflow: number } {
  const totalMinutes = periodDurationMinutes(period)
  const slots: TaskSlot[] = []
  let usedMinutes = 0

  for (const task of tasks) {
    const duration = task.estimated_minutes ?? DEFAULT_TASK_MINUTES
    if (usedMinutes + duration > totalMinutes) break

    const startTime = addMinutesToTime(period.start_time, usedMinutes)
    const endTime = addMinutesToTime(period.start_time, usedMinutes + duration)
    slots.push({ task, startTime, endTime })
    usedMinutes += duration
  }

  const overflow = tasks.length - slots.length
  return { slots, overflow }
}

/**
 * Returns tasks from candidates that were not placed and belong to guaranteed categories:
 * urgent, scheduled for today, or deadline today.
 */
export function injectGuaranteedTasks(
  placed: DbTask[],
  candidates: DbTask[],
  date: string,
): DbTask[] {
  const placedIds = new Set(placed.map((t) => t.id))
  return candidates.filter(
    (t) =>
      !placedIds.has(t.id) &&
      (t.is_urgent || t.scheduled_date === date || t.deadline_date === date),
  )
}

export async function runMorningPlan(user: DbUser): Promise<void> {
  const { date, dayOfWeek } = getTodayInTimezone(user.timezone)

  logger.info('[cron/morning-plan] runMorningPlan start', {
    userId: user.id,
    today: date,
    dayOfWeek,
  })

  try {
    const periods = await getPeriodsForDay(user.id, dayOfWeek)

    if (periods.length === 0) {
      logger.info('[cron/morning-plan] no periods today', { userId: user.id })
      await bot.api.sendMessage(
        user.telegram_id,
        '🌅 Сегодня нет активных периодов. Хорошего дня!',
      )
      return
    }

    const periodPlans: PeriodPlan[] = []

    // Group periods by queue_slug — periods sharing a queue_slug share one task pool.
    // Periods arrive sorted by start_time from the DB query, so group order is preserved.
    const groups = new Map<string, DbPeriod[]>()
    for (const period of periods) {
      const key = period.queue_slug
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(period)
    }

    // Track placed task IDs globally to avoid duplicating tasks across periods.
    const usedTaskIds = new Set<string>()

    for (const [queueSlug, groupPeriods] of groups) {
      const queueTasks = await getTaskQueue(user.id, queueSlug, date)
      const backlog = await getBacklog(user.id, queueSlug)

      logger.info('[cron/morning-plan] processing queue group', {
        userId: user.id,
        queueSlug,
        periodsInGroup: groupPeriods.length,
        totalQueueTasks: queueTasks.length,
      })

      // Distribute queue tasks sequentially across periods in the group.
      let remainingQueue = queueTasks.filter((t) => !usedTaskIds.has(t.id))

      for (const period of groupPeriods) {
        const { slots, overflow } = buildSlots(period, remainingQueue)

        // Advance the pool past tasks placed in this period.
        for (const slot of slots) usedTaskIds.add(slot.task.id)
        remainingQueue = remainingQueue.slice(slots.length)

        // Fill remaining capacity with backlog tasks not yet placed.
        const usedMinutes = slots.reduce((sum, s) => sum + (s.task.estimated_minutes ?? DEFAULT_TASK_MINUTES), 0)
        let remaining = periodDurationMinutes(period) - usedMinutes
        let backlogAdded = 0

        for (const task of backlog) {
          if (remaining <= 0) break
          if (usedTaskIds.has(task.id)) continue
          const duration = task.estimated_minutes ?? DEFAULT_TASK_MINUTES
          if (duration > remaining) break

          const startTime = addMinutesToTime(period.start_time, periodDurationMinutes(period) - remaining)
          const endTime = addMinutesToTime(period.start_time, periodDurationMinutes(period) - remaining + duration)
          slots.push({ task, startTime, endTime })
          usedTaskIds.add(task.id)
          remaining -= duration
          backlogAdded++
        }

        const placedTasks = slots.map((s) => s.task)
        const guaranteed = injectGuaranteedTasks(placedTasks, remainingQueue, date)

        if (guaranteed.length > 0) {
          logger.info('[cron/morning-plan] injecting guaranteed tasks outside slot budget', {
            userId: user.id,
            periodSlug: period.slug,
            count: guaranteed.length,
            tasks: guaranteed.map((t) => ({
              id: t.id,
              title: t.title,
              reason: t.is_urgent
                ? 'urgent'
                : t.scheduled_date === date
                  ? 'scheduled_today'
                  : 'deadline_today',
            })),
          })
          for (const t of guaranteed) usedTaskIds.add(t.id)
        }

        const allTasks = [...placedTasks, ...guaranteed]

        logger.debug('[cron/morning-plan] period plan built', {
          userId: user.id,
          periodSlug: period.slug,
          queueSlug,
          taskCount: allTasks.length,
          guaranteedCount: guaranteed.length,
          backlogAdded,
          overflow,
        })

        periodPlans.push({ period, tasks: allTasks, slots })
      }
    }

    // Include tasks scheduled for today but not assigned to any period.
    // These are created by the agent when the LLM omits period_slug.
    // We attach them to the first period so they appear in the morning plan.
    const unassigned = await getUnassignedTodayTasks(user.id, date)
    if (unassigned.length > 0 && periodPlans.length > 0) {
      const firstPlan = periodPlans[0]
      const seenIds = new Set(firstPlan.tasks.map((t) => t.id))
      const newTasks = unassigned.filter((t) => !seenIds.has(t.id))
      firstPlan.tasks = [...firstPlan.tasks, ...newTasks]
      logger.info('[cron/morning-plan] attached unassigned today tasks to first period', {
        userId: user.id,
        count: newTasks.length,
        periodSlug: firstPlan.period.slug,
        taskTitles: newTasks.map((t) => t.title),
      })
    }

    let message: string
    try {
      message = await generateDayPlanMessage(user, date, periodPlans)
    } catch (err) {
      logger.warn('[cron/morning-plan] generateDayPlanMessage error, using fallback', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      })
      // generateDayPlanMessage already has internal fallback, this is an extra safety net
      message = `📅 Твой план на ${date} готов. Не удалось получить красивую версию от AI.`
    }

    await bot.api.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' })
    logger.info('[cron/morning-plan] plan sent', { userId: user.id })

    if (user.google_access_token) {
      logger.info('[cron/morning-plan] calendar synced', { userId: user.id })
      await syncDayPlan(user.id, date, periodPlans)
    } else {
      logger.debug('[cron/morning-plan] calendar sync skipped (no tokens)', { userId: user.id })
    }
  } catch (err) {
    logger.error('[cron/morning-plan] error', {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    })
    // Do not rethrow — cron errors must not crash the service
  }
}
