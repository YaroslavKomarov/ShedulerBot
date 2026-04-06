import { bot } from '../bot/index.js'
import { getPeriodsForDay } from '../db/periods.js'
import { getTaskQueue, getBacklog } from '../db/tasks.js'
import { generateDayPlanMessage } from '../llm/plan.js'
import { syncDayPlan } from '../calendar/sync.js'
import { logger } from '../lib/logger.js'
import type { DbUser, DbTask, DbPeriod } from '../types/index.js'
import type { PeriodPlan, TaskSlot } from '../llm/plan.js'

const DEFAULT_TASK_MINUTES = 30

/**
 * Returns current date string and day-of-week number (0=Sun…6=Sat) in the given timezone.
 */
export function getTodayInTimezone(timezone: string): { date: string; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const date = formatter.format(new Date())  // "YYYY-MM-DD" (en-CA locale)

  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  })
  const dayName = dayFormatter.format(new Date())
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const dayOfWeek = dayMap[dayName] ?? new Date().getDay()

  return { date, dayOfWeek }
}

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
function buildSlots(period: DbPeriod, tasks: DbTask[]): { slots: TaskSlot[]; overflow: number } {
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

    for (const period of periods) {
      const queueTasks = await getTaskQueue(user.id, period.slug, date)
      const { slots, overflow: queueOverflow } = buildSlots(period, queueTasks)

      // Fill remaining time from backlog
      const usedSlugSet = new Set(slots.map((s) => s.task.id))
      const remainingMinutes =
        periodDurationMinutes(period) -
        slots.reduce((sum, s) => {
          const dur = s.task.estimated_minutes ?? DEFAULT_TASK_MINUTES
          return sum + dur
        }, 0)

      let backlogAdded = 0
      if (remainingMinutes > 0) {
        const backlog = await getBacklog(user.id, period.slug)
        let remaining = remainingMinutes

        for (const task of backlog) {
          if (usedSlugSet.has(task.id)) continue
          const duration = task.estimated_minutes ?? DEFAULT_TASK_MINUTES
          if (duration > remaining) break

          const startTime = addMinutesToTime(
            period.start_time,
            periodDurationMinutes(period) - remaining,
          )
          const endTime = addMinutesToTime(period.start_time, periodDurationMinutes(period) - remaining + duration)
          slots.push({ task, startTime, endTime })
          remaining -= duration
          backlogAdded++
        }
      }

      const allTasks = slots.map((s) => s.task)

      logger.debug('[cron/morning-plan] period plan built', {
        userId: user.id,
        periodSlug: period.slug,
        taskCount: allTasks.length,
        backlogAdded,
        overflow: queueOverflow,
      })

      periodPlans.push({ period, tasks: allTasks, slots })
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
