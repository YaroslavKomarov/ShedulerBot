import cron from 'node-cron'
import type { DbUser } from '../types/index.js'
import { getAllUsersForCron } from '../db/users.js'
import { getUserPeriods } from '../db/periods.js'
import { runMorningPlan } from './morning-plan.js'
import { runRetrospective } from './retrospective.js'
import {
  sendPeriodPreview,
  sendPeriodStart,
  sendPeriodPreEnd,
  sendPeriodEnd,
} from './period-notify.js'
import { logger } from '../lib/logger.js'

const activeCrons = new Map<string, cron.ScheduledTask[]>()

/**
 * Converts a "HH:MM" time string to a cron expression "MM HH * * *"
 * Optionally restricts to specific weekdays: "MM HH * * 1,2,3"
 */
function timeToCron(time: string, days?: number[]): string {
  const [hours, minutes] = time.split(':')
  const daysExpr = days && days.length > 0 ? days.join(',') : '*'
  return `${minutes} ${hours} * * ${daysExpr}`
}

/**
 * Subtracts minutes from a "HH:MM" string, handles midnight wrap.
 */
function subtractMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  let total = h * 60 + m - minutes
  if (total < 0) total += 24 * 60
  const newH = Math.floor(total / 60) % 24
  const newM = total % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

export async function registerUserCrons(user: DbUser): Promise<void> {
  logger.info('[cron/manager] registerUserCrons', {
    userId: user.id,
    morning_time: user.morning_time,
    end_of_day_time: user.end_of_day_time,
    timezone: user.timezone,
  })

  unregisterUserCrons(user.id)

  const jobs: cron.ScheduledTask[] = []

  // Morning plan job
  const morningExpr = timeToCron(user.morning_time)
  const morningJob = cron.schedule(
    morningExpr,
    () => {
      logger.debug('[cron/manager] morning plan triggered', { userId: user.id })
      runMorningPlan(user).catch((err) =>
        logger.error('[cron/manager] runMorningPlan error', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    },
    { timezone: user.timezone, scheduled: true },
  )
  jobs.push(morningJob)

  // End-of-day retrospective
  const eodExpr = timeToCron(user.end_of_day_time)
  const eodJob = cron.schedule(
    eodExpr,
    () => {
      logger.debug('[cron/manager] retrospective triggered', { userId: user.id })
      runRetrospective(user).catch((err) =>
        logger.error('[cron/manager] runRetrospective error', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    },
    { timezone: user.timezone, scheduled: true },
  )
  jobs.push(eodJob)

  // Register 4 notification jobs per period
  try {
    const periods = await getUserPeriods(user.id)

    for (const period of periods) {
      const days = period.days_of_week

      const previewTime = subtractMinutes(period.start_time, 10)
      const startTime = period.start_time
      const preEndTime = subtractMinutes(period.end_time, 10)
      const endTime = period.end_time

      const periodJobs = [
        {
          time: previewTime,
          label: 'preview',
          fn: () => sendPeriodPreview(user, period).catch((err) =>
            logger.error('[cron/manager] sendPeriodPreview error', {
              userId: user.id,
              periodSlug: period.slug,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        },
        {
          time: startTime,
          label: 'start',
          fn: () => sendPeriodStart(user, period).catch((err) =>
            logger.error('[cron/manager] sendPeriodStart error', {
              userId: user.id,
              periodSlug: period.slug,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        },
        {
          time: preEndTime,
          label: 'pre-end',
          fn: () => sendPeriodPreEnd(user, period).catch((err) =>
            logger.error('[cron/manager] sendPeriodPreEnd error', {
              userId: user.id,
              periodSlug: period.slug,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        },
        {
          time: endTime,
          label: 'end',
          fn: () => sendPeriodEnd(user, period).catch((err) =>
            logger.error('[cron/manager] sendPeriodEnd error', {
              userId: user.id,
              periodSlug: period.slug,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        },
      ]

      for (const { time, label, fn } of periodJobs) {
        const expr = timeToCron(time, days)
        const job = cron.schedule(expr, fn, { timezone: user.timezone, scheduled: true })
        jobs.push(job)
        logger.debug('[cron/manager] period job registered', {
          userId: user.id,
          periodSlug: period.slug,
          label,
          expr,
        })
      }

      logger.debug('[cron/manager] registerUserCrons: period jobs', {
        userId: user.id,
        periodSlug: period.slug,
        jobs: 4,
      })
    }
  } catch (err) {
    logger.error('[cron/manager] failed to load periods for user', {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  activeCrons.set(user.id, jobs)
  logger.info('[cron/manager] registerUserCrons done', {
    userId: user.id,
    totalJobs: jobs.length,
  })
}

export function unregisterUserCrons(userId: string): void {
  const existing = activeCrons.get(userId)
  if (!existing) {
    logger.debug('[cron/manager] unregisterUserCrons — no jobs found', { userId })
    return
  }

  for (const job of existing) {
    job.stop()
  }
  activeCrons.delete(userId)
  logger.debug('[cron/manager] unregisterUserCrons', { userId, stoppedCount: existing.length })
}

export async function registerAllUsers(): Promise<void> {
  logger.info('[cron/manager] registerAllUsers start')

  const users = await getAllUsersForCron()
  logger.info('[cron/manager] registerAllUsers', { userCount: users.length })

  for (const user of users) {
    try {
      await registerUserCrons(user)
    } catch (err) {
      logger.error('[cron/manager] registerUserCrons error', {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  logger.info('[cron/manager] registerAllUsers done', { count: users.length })
}
