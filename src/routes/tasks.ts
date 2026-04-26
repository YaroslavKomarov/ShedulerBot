import { Router } from 'express'
import { z } from 'zod'
import { bot } from '../bot/index.js'
import { getUserByTelegramId } from '../db/users.js'
import { createTask, findTaskByExternalId } from '../db/tasks.js'
import { getUserPeriods } from '../db/periods.js'
import { logger } from '../lib/logger.js'

export const tasksRouter = Router()

const CreateTaskSchema = z
  .object({
    telegram_id: z.number(),
    title: z.string().min(1),
    description: z.string().optional(),
    period_slug: z.string().optional().nullable(),
    deadline_date: z.string().optional().nullable(),
    scheduled_date: z.string().optional().nullable(),
    estimated_minutes: z.number().int().positive().optional().nullable(),
    is_urgent: z.boolean().default(false),
    external_id: z.string().optional().nullable(),
  })
  .refine((data) => !(data.scheduled_date && data.deadline_date), {
    message: 'scheduled_date и deadline_date взаимоисключающие',
    path: ['scheduled_date'],
  })

tasksRouter.post('/tasks', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  const expectedKey = process.env.API_SECRET_KEY

  logger.info('[routes/tasks] POST /api/tasks', {
    telegram_id: req.body?.telegram_id,
    title: req.body?.title,
    hasExternalId: !!req.body?.external_id,
  })

  if (!apiKey || apiKey !== expectedKey) {
    logger.warn('[routes/tasks] unauthorized', { ip: req.ip })
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const parsed = CreateTaskSchema.safeParse(req.body)
  if (!parsed.success) {
    if (req.body?.scheduled_date && req.body?.deadline_date) {
      logger.warn('[routes/tasks] Rejected: both scheduled_date and deadline_date provided', {
        telegram_id: req.body?.telegram_id,
        external_id: req.body?.external_id,
      })
    } else {
      logger.debug('[routes/tasks] validation failed', { errors: parsed.error.format() })
    }
    res.status(400).json({ error: 'Bad Request', details: parsed.error.format() })
    return
  }

  const { telegram_id, external_id, ...taskFields } = parsed.data

  try {
    // Idempotency check
    if (external_id) {
      // Need user first for idempotency lookup — get user early
      const userForIdempotency = await getUserByTelegramId(telegram_id)
      if (userForIdempotency) {
        const existing = await findTaskByExternalId(userForIdempotency.id, external_id)
        if (existing) {
          logger.info('[routes/tasks] idempotent hit', { externalId: external_id, taskId: existing.id })
          res.status(200).json({ id: existing.id, created: false })
          return
        }
      }
    }

    const user = await getUserByTelegramId(telegram_id)
    if (!user) {
      logger.warn('[routes/tasks] user not found', { telegram_id })
      res.status(404).json({ error: 'User not found' })
      return
    }

    // Resolve period_slug → queue_slug so external tasks land in the correct queue.
    // Callers send the period's slug; we store the queue_slug so getTaskQueue finds it.
    let resolvedPeriodSlug = taskFields.period_slug ?? null
    if (resolvedPeriodSlug) {
      const periods = await getUserPeriods(user.id)
      const period = periods.find((p) => p.slug === resolvedPeriodSlug)
      if (period) {
        resolvedPeriodSlug = period.queue_slug
        logger.debug('[routes/tasks] resolved period_slug to queue_slug', {
          input: taskFields.period_slug,
          queue_slug: resolvedPeriodSlug,
        })
      } else {
        logger.warn('[routes/tasks] period_slug not found, storing as-is', {
          period_slug: resolvedPeriodSlug,
          userId: user.id,
        })
      }
    }

    const task = await createTask({
      user_id: user.id,
      source: 'external',
      external_id: external_id ?? null,
      ...taskFields,
      period_slug: resolvedPeriodSlug,
    })

    logger.info('[routes/tasks] task created', { taskId: task.id, userId: user.id })

    // Telegram notification — log error but don't fail
    const parts: string[] = [`📥 Новая задача добавлена:\n*${task.title}*`]
    if (task.description) parts.push(task.description)
    if (task.is_urgent) parts.push('🔥 Срочно')
    if (task.deadline_date) parts.push(`📅 Дедлайн: ${task.deadline_date}`)

    try {
      await bot.api.sendMessage(user.telegram_id, parts.join('\n'), { parse_mode: 'Markdown' })
    } catch (notifyErr) {
      logger.warn('[routes/tasks] telegram notify failed', {
        userId: user.id,
        error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
      })
    }

    res.status(201).json({ id: task.id, created: true })
  } catch (err) {
    logger.error('[routes/tasks] error', {
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: 'Internal Server Error' })
  }
})
