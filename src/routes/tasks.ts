import { Router } from 'express'
import { z } from 'zod'
import { bot } from '../bot/index.js'
import { getUserByTelegramId, getUserBySoloLevelingToken } from '../db/users.js'
import { createTask, findTaskByExternalId, updateTask } from '../db/tasks.js'
import { getUserPeriods } from '../db/periods.js'
import { logger } from '../lib/logger.js'

export const tasksRouter = Router()

const CreateTaskSchema = z
  .object({
    telegram_id: z.number().optional(),
    schedulerbot_token: z.string().optional(),
    title: z.string().min(1),
    description: z.string().optional().nullable(),
    period_slug: z.string().optional().nullable(),
    deadline_date: z.string().optional().nullable(),
    scheduled_date: z.string().optional().nullable(),
    estimated_minutes: z.number().int().positive().optional().nullable(),
    is_urgent: z.boolean().default(false),
    external_id: z.string().optional().nullable(),
  })
  .refine((data) => data.telegram_id !== undefined || data.schedulerbot_token !== undefined, {
    message: 'telegram_id or schedulerbot_token is required',
    path: ['telegram_id'],
  })
  .refine((data) => !(data.scheduled_date && data.deadline_date), {
    message: 'scheduled_date и deadline_date взаимоисключающие',
    path: ['scheduled_date'],
  })

const BatchTaskItemSchema = z
  .object({
    external_id: z.string().optional().nullable(),
    title: z.string().min(1),
    description: z.string().optional().nullable(),
    period_slug: z.string().optional().nullable(),
    deadline_date: z.string().optional().nullable(),
    scheduled_date: z.string().optional().nullable(),
    estimated_minutes: z.number().int().positive().optional().nullable(),
    is_urgent: z.boolean().default(false),
  })
  .refine((data) => !(data.scheduled_date && data.deadline_date), {
    message: 'scheduled_date и deadline_date взаимоисключающие',
    path: ['scheduled_date'],
  })

const BatchCreateSchema = z.object({
  schedulerbot_token: z.string().min(1),
  tasks: z.array(BatchTaskItemSchema).min(1),
})

function pluralTasks(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 19) return 'задач'
  const r = n % 10
  if (r === 1) return 'задачу'
  if (r >= 2 && r <= 4) return 'задачи'
  return 'задач'
}

tasksRouter.post('/tasks', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  const expectedKey = process.env.API_SECRET_KEY

  logger.info('[routes/tasks] POST /api/tasks', {
    telegram_id: req.body?.telegram_id,
    hasToken: !!req.body?.schedulerbot_token,
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

  const { telegram_id, schedulerbot_token, external_id, ...taskFields } = parsed.data

  try {
    const user = telegram_id
      ? await getUserByTelegramId(telegram_id)
      : await getUserBySoloLevelingToken(schedulerbot_token!)

    // Idempotency check
    if (external_id && user) {
      const existing = await findTaskByExternalId(user.id, external_id)
      if (existing) {
        logger.info('[routes/tasks] idempotent hit', { externalId: external_id, taskId: existing.id })
        res.status(200).json({ id: existing.id, created: false })
        return
      }
    }

    if (!user) {
      logger.warn('[routes/tasks] user not found', { telegram_id, hasToken: !!schedulerbot_token })
      res.status(404).json({ error: 'User not found' })
      return
    }

    // Resolve period_slug → queue_slug
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

    // Send per-task Telegram notification only for telegram_id auth (manual integrations).
    // Token-auth callers (SoloLeveling) use /batch which sends one summary notification.
    if (telegram_id) {
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
    }

    res.status(201).json({ id: task.id, created: true })
  } catch (err) {
    logger.error('[routes/tasks] error', {
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

tasksRouter.post('/tasks/batch', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  const expectedKey = process.env.API_SECRET_KEY

  logger.info('[routes/tasks] POST /api/tasks/batch', {
    hasToken: !!req.body?.schedulerbot_token,
    taskCount: Array.isArray(req.body?.tasks) ? req.body.tasks.length : undefined,
  })

  if (!apiKey || apiKey !== expectedKey) {
    logger.warn('[routes/tasks] batch unauthorized', { ip: req.ip })
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const parsed = BatchCreateSchema.safeParse(req.body)
  if (!parsed.success) {
    logger.debug('[routes/tasks] batch validation failed', { errors: parsed.error.format() })
    res.status(400).json({ error: 'Bad Request', details: parsed.error.format() })
    return
  }

  const { schedulerbot_token, tasks } = parsed.data

  try {
    const user = await getUserBySoloLevelingToken(schedulerbot_token)
    if (!user) {
      logger.warn('[routes/tasks] batch user not found')
      res.status(404).json({ error: 'User not found' })
      return
    }

    const periods = await getUserPeriods(user.id)

    let createdCount = 0
    let skippedCount = 0
    let failedCount = 0
    const results: Array<{
      external_id: string | null | undefined
      id: string | null
      created: boolean
      error?: string
    }> = []

    for (const taskData of tasks) {
      try {
        // Idempotency check
        if (taskData.external_id) {
          const existing = await findTaskByExternalId(user.id, taskData.external_id)
          if (existing) {
            logger.debug('[routes/tasks] batch idempotent hit', {
              externalId: taskData.external_id,
              taskId: existing.id,
            })
            skippedCount++
            results.push({ external_id: taskData.external_id, id: existing.id, created: false })
            continue
          }
        }

        // Resolve period_slug → queue_slug
        const { external_id, ...fields } = taskData
        let resolvedPeriodSlug = fields.period_slug ?? null
        if (resolvedPeriodSlug) {
          const period = periods.find((p) => p.slug === resolvedPeriodSlug)
          if (period) {
            resolvedPeriodSlug = period.queue_slug
          } else {
            logger.warn('[routes/tasks] batch: period_slug not found', {
              period_slug: resolvedPeriodSlug,
              userId: user.id,
            })
          }
        }

        const task = await createTask({
          user_id: user.id,
          source: 'external',
          external_id: external_id ?? null,
          ...fields,
          period_slug: resolvedPeriodSlug,
        })

        createdCount++
        results.push({ external_id: taskData.external_id, id: task.id, created: true })
      } catch (taskErr) {
        logger.error('[routes/tasks] batch task error', {
          external_id: taskData.external_id,
          title: taskData.title,
          error: taskErr instanceof Error ? taskErr.message : String(taskErr),
        })
        failedCount++
        results.push({
          external_id: taskData.external_id,
          id: null,
          created: false,
          error: taskErr instanceof Error ? taskErr.message : 'Unknown error',
        })
      }
    }

    logger.info('[routes/tasks] batch complete', {
      userId: user.id,
      created: createdCount,
      skipped: skippedCount,
      failed: failedCount,
    })

    // Single summary Telegram notification
    if (createdCount > 0) {
      try {
        const createdInputSlugs = tasks
          .filter((_, i) => results[i]?.created)
          .map((t) => t.period_slug)
          .filter((s): s is string => !!s)

        const uniqueSlugs = [...new Set(createdInputSlugs)]
        let periodPart = ''
        if (uniqueSlugs.length === 1) {
          const period = periods.find((p) => p.slug === uniqueSlugs[0])
          if (period) periodPart = ` в период «${period.name}»`
        }

        const message = `📥 SoloLeveling добавил ${createdCount} ${pluralTasks(createdCount)}${periodPart}`
        await bot.api.sendMessage(user.telegram_id, message)
      } catch (notifyErr) {
        logger.warn('[routes/tasks] batch telegram notify failed', {
          userId: user.id,
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
        })
      }
    }

    res.status(200).json({
      created: createdCount,
      skipped: skippedCount,
      failed: failedCount,
      results,
    })
  } catch (err) {
    logger.error('[routes/tasks] batch error', {
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: 'Internal Server Error' })
  }
})

const CompleteTaskSchema = z.object({ schedulerbot_token: z.string().min(1) })

tasksRouter.post('/tasks/:externalId/complete', async (req, res) => {
  const { externalId } = req.params
  const apiKey = req.headers['x-api-key']
  const expectedKey = process.env.API_SECRET_KEY

  logger.info('[routes/tasks] POST /api/tasks/:externalId/complete', {
    externalId,
    hasToken: !!req.body?.schedulerbot_token,
  })

  if (!apiKey || apiKey !== expectedKey) {
    logger.warn('[routes/tasks] complete unauthorized', { ip: req.ip })
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const parsed = CompleteTaskSchema.safeParse(req.body)
  if (!parsed.success) {
    logger.debug('[routes/tasks] complete validation failed', { errors: parsed.error.format() })
    res.status(400).json({ error: 'Bad Request', details: parsed.error.format() })
    return
  }

  const { schedulerbot_token } = parsed.data

  try {
    const user = await getUserBySoloLevelingToken(schedulerbot_token)
    if (!user) {
      logger.warn('[routes/tasks] complete user not found', {
        externalId,
        hasToken: !!schedulerbot_token,
      })
      res.status(404).json({ error: 'User not found' })
      return
    }

    const task = await findTaskByExternalId(user.id, externalId)
    if (!task) {
      logger.warn('[routes/tasks] complete task not found', { externalId, userId: user.id })
      res.status(404).json({ error: 'Task not found' })
      return
    }

    if (task.status !== 'pending') {
      logger.info('[routes/tasks] complete idempotent hit', {
        externalId,
        taskId: task.id,
        status: task.status,
      })
      res.status(200).json({ success: true })
      return
    }

    await updateTask(task.id, { status: 'done' })
    logger.info('[routes/tasks] complete success', {
      externalId,
      taskId: task.id,
      userId: user.id,
    })
    res.status(200).json({ success: true })
  } catch (err) {
    logger.error('[routes/tasks] complete error', {
      externalId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).json({ error: 'Internal Server Error' })
  }
})
