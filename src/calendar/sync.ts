import { getCalendarClient } from './client.js'
import { getUserById } from '../db/users.js'
import { logger } from '../lib/logger.js'
import type { PeriodPlan } from '../llm/plan.js'

const SCHEDULERBOT_KEY = 'schedulerbot_period'

function buildEventDescription(tasks: PeriodPlan['tasks']): string {
  if (tasks.length === 0) return 'Задачи не запланированы'

  return tasks
    .map((t) => {
      const urgentPrefix = t.is_urgent ? '🔴 ' : '• '
      const durationStr = t.estimated_minutes ? ` (~${t.estimated_minutes} мин)` : ''
      const deadlineStr = t.deadline_date ? ` [дедлайн: ${t.deadline_date}]` : ''
      return `${urgentPrefix}${t.title}${durationStr}${deadlineStr}`
    })
    .join('\n')
}

export async function syncDayPlan(
  userId: string,
  date: string,
  periodPlans: PeriodPlan[],
): Promise<void> {
  logger.info('[calendar/sync] syncDayPlan start', {
    userId,
    date,
    periodCount: periodPlans.length,
  })

  const calendarClient = await getCalendarClient(userId)
  if (!calendarClient) {
    logger.debug('[calendar/sync] no calendar client (no tokens), skipping', { userId })
    return
  }

  const user = await getUserById(userId)
  const timezone = user?.timezone ?? 'UTC'

  for (const { period, tasks } of periodPlans) {
    try {
      const startDateTime = `${date}T${period.start_time}:00`
      const endDateTime = `${date}T${period.end_time}:00`

      // Search for existing event by extendedProperties
      const listResponse = await calendarClient.events.list({
        calendarId: 'primary',
        timeMin: `${startDateTime}${timezone === 'UTC' ? 'Z' : ''}`,
        timeMax: `${date}T23:59:59Z`,
        privateExtendedProperty: [`${SCHEDULERBOT_KEY}=${period.slug}`],
        singleEvents: true,
        maxResults: 1,
      })

      const existing = listResponse.data.items?.[0]
      const eventBody = {
        summary: `📋 ${period.name}`,
        description: buildEventDescription(tasks),
        start: { dateTime: startDateTime, timeZone: timezone },
        end: { dateTime: endDateTime, timeZone: timezone },
        extendedProperties: {
          private: {
            [SCHEDULERBOT_KEY]: period.slug,
          },
        },
      }

      if (existing?.id) {
        await calendarClient.events.patch({
          calendarId: 'primary',
          eventId: existing.id,
          requestBody: eventBody,
        })
        logger.debug('[calendar/sync] period synced', {
          userId,
          periodSlug: period.slug,
          eventId: existing.id,
          action: 'updated',
        })
      } else {
        const inserted = await calendarClient.events.insert({
          calendarId: 'primary',
          requestBody: eventBody,
        })
        logger.debug('[calendar/sync] period synced', {
          userId,
          periodSlug: period.slug,
          eventId: inserted.data.id,
          action: 'created',
        })
      }
    } catch (err) {
      logger.error('[calendar/sync] period sync error', {
        userId,
        periodSlug: period.slug,
        error: err instanceof Error ? err.message : String(err),
      })
      // Continue with other periods
    }
  }

  logger.info('[calendar/sync] syncDayPlan done', { userId, date })
}
