import type OpenAI from 'openai'
import { llmClient, STRONG_MODEL, LLMInsufficientCreditsError } from './client.js'
import { getUserPeriods, getPeriodsForDay, updatePeriod, deletePeriod, createPeriods } from '../db/periods.js'
import { getTasksByDate, getBacklog, getTaskQueue, createTask, findTasksByTitle, updateTask, getScheduledMinutes, getUrgentTask } from '../db/tasks.js'
import { registerUserCrons, unregisterUserCrons } from '../cron/manager.js'
import { logger } from '../lib/logger.js'
import { getTodayInTimezone } from '../lib/date.js'
import type { DbUser } from '../types/index.js'
import type { ChatMessage } from '../db/chat-history.js'

// Tool definitions for the LLM
const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_periods',
      description: 'Получить все периоды активности пользователя (имя, слаг, queue_slug, время начала/конца, дни недели). queue_slug — ключ общей очереди задач; у периодов с одинаковым queue_slug одна очередь.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_periods_for_day',
      description: 'Получить периоды активности для конкретного дня недели (0=вс, 1=пн, 2=вт, 3=ср, 4=чт, 5=пт, 6=сб)',
      parameters: {
        type: 'object',
        properties: {
          day_of_week: {
            type: 'number',
            description: 'День недели: 0=вс, 1=пн, 2=вт, 3=ср, 4=чт, 5=пт, 6=сб',
          },
        },
        required: ['day_of_week'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks_by_date',
      description: 'Получить все задачи запланированные на конкретную дату',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_backlog',
      description: 'Получить задачи без запланированной даты (бэклог). Можно фильтровать по слагу периода.',
      parameters: {
        type: 'object',
        properties: {
          period_slug: {
            type: 'string',
            description: 'Слаг периода для фильтрации (опционально)',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_queue',
      description: 'Получить очередь задач для периода на дату с учётом приоритетов (срочные → с дедлайном → остальные)',
      parameters: {
        type: 'object',
        properties: {
          period_slug: {
            type: 'string',
            description: 'Слаг периода (null — все периоды)',
          },
          date: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
        },
        required: ['date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_task',
      description: 'Создать новую задачу. Каждая задача обязана принадлежать периоду активности. Если period_slug не известен — сначала вызови get_periods и уточни у пользователя, в каком периоде выполнять задачу.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Название задачи' },
          period_slug: { type: 'string', description: 'Слаг периода активности (обязательно)' },
          scheduled_date: { type: 'string', description: 'Дата выполнения YYYY-MM-DD. Взаимоисключает deadline_date — не передавай оба поля одновременно.' },
          is_urgent: { type: 'boolean', description: 'Срочная задача (плавающая, всегда первая в очереди). Взаимоисключает scheduled_date и deadline_date — не передавай их вместе. В очереди допускается ровно одна срочная задача.' },
          deadline_date: { type: 'string', description: 'Дедлайн YYYY-MM-DD. Взаимоисключает scheduled_date — не передавай оба поля одновременно.' },
          estimated_minutes: { type: 'number', description: 'Оценка времени в минутах (опционально)' },
          force_overflow: { type: 'boolean', description: 'Передай true если пользователь подтвердил создание задачи сверх вместимости периода. Задача будет помечена is_overflow=true.' },
        },
        required: ['title', 'period_slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Обновить задачу. Сначала ищет задачу по названию через title_query, затем применяет обновления.',
      parameters: {
        type: 'object',
        properties: {
          title_query: { type: 'string', description: 'Часть названия задачи для поиска' },
          updates: {
            type: 'object',
            description: 'Поля для обновления',
            properties: {
              title: { type: 'string' },
              period_slug: { type: 'string' },
              scheduled_date: { type: 'string' },
              is_urgent: { type: 'boolean' },
              deadline_date: { type: 'string' },
              estimated_minutes: { type: 'number' },
              status: { type: 'string', enum: ['pending', 'done', 'cancelled'] },
            },
          },
        },
        required: ['title_query', 'updates'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Отменить задачу. Ищет по названию и устанавливает status=cancelled.',
      parameters: {
        type: 'object',
        properties: {
          title_query: { type: 'string', description: 'Часть названия задачи для поиска' },
        },
        required: ['title_query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_done',
      description: 'Отметить задачу выполненной. Ищет по названию и устанавливает status=done.',
      parameters: {
        type: 'object',
        properties: {
          title_query: { type: 'string', description: 'Часть названия задачи для поиска' },
        },
        required: ['title_query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_period',
      description: 'Изменить существующий период активности (время начала/конца, дни недели, название, queue_slug). Вызывай ТОЛЬКО после явного подтверждения пользователем.',
      parameters: {
        type: 'object',
        properties: {
          period_slug: { type: 'string', description: 'Слаг периода (из get_periods, поле slug)' },
          name: { type: 'string', description: 'Новое название (опционально)' },
          start_time: { type: 'string', description: 'Новое время начала HH:MM (опционально)' },
          end_time: { type: 'string', description: 'Новое время конца HH:MM (опционально)' },
          days_of_week: {
            type: 'array',
            items: { type: 'number' },
            description: 'Дни недели: 1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб, 7=Вс (опционально)',
          },
          queue_slug: {
            type: 'string',
            description: 'Ключ общей очереди задач (опционально). Установи одинаковый queue_slug у двух периодов, чтобы они делили одну очередь задач.',
          },
        },
        required: ['period_slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_period',
      description: 'Удалить период активности. Вызывай ТОЛЬКО после явного подтверждения пользователем.',
      parameters: {
        type: 'object',
        properties: {
          period_slug: { type: 'string', description: 'Слаг периода (из get_periods, поле slug)' },
        },
        required: ['period_slug'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_period',
      description: 'Создать новый период активности. Вызывай ТОЛЬКО после явного подтверждения пользователем.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Название периода' },
          slug: { type: 'string', description: 'Уникальный идентификатор (латиница, kebab-case, напр. "evening")' },
          queue_slug: {
            type: 'string',
            description: 'Ключ общей очереди задач (опционально, по умолчанию = slug). Установи такой же queue_slug как у другого периода, чтобы делить с ним очередь задач.',
          },
          start_time: { type: 'string', description: 'Время начала HH:MM' },
          end_time: { type: 'string', description: 'Время конца HH:MM' },
          days_of_week: {
            type: 'array',
            items: { type: 'number' },
            description: 'Дни недели: 1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб, 7=Вс',
          },
        },
        required: ['name', 'slug', 'start_time', 'end_time', 'days_of_week'],
      },
    },
  },
]

function hasTimeOverlap(
  s1: string, e1: string, d1: number[],
  s2: string, e2: string, d2: number[],
): boolean {
  const sharedDays = d1.some((d) => d2.includes(d))
  if (!sharedDays) return false
  return s1 < e2 && s2 < e1
}

async function executeTool(
  user: DbUser,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const userId = user.id
  logger.debug('[llm/agent] executeTool', { userId, name, args })

  switch (name) {
    case 'get_periods':
      return getUserPeriods(userId)

    case 'get_periods_for_day': {
      const day = args['day_of_week']
      if (typeof day !== 'number') throw new Error('day_of_week must be a number')
      return getPeriodsForDay(userId, day)
    }

    case 'get_tasks_by_date': {
      const date = args['date']
      if (typeof date !== 'string') throw new Error('date must be a string')
      return getTasksByDate(userId, date)
    }

    case 'get_backlog': {
      const slug = args['period_slug']
      return getBacklog(userId, typeof slug === 'string' ? slug : undefined)
    }

    case 'get_task_queue': {
      const date = args['date']
      if (typeof date !== 'string') throw new Error('date must be a string')
      const slug = args['period_slug']
      return getTaskQueue(userId, typeof slug === 'string' ? slug : null, date)
    }

    case 'add_task': {
      const title = args['title']
      if (typeof title !== 'string' || !title) throw new Error('title must be a non-empty string')

      const periodSlug = typeof args['period_slug'] === 'string' ? args['period_slug'] : null
      if (!periodSlug) return { error: 'period_slug обязателен. Сначала вызови get_periods и уточни у пользователя, в каком периоде выполнять задачу.' }

      // Validate period_slug exists — prevents LLM from inventing slugs
      const allPeriods = await getUserPeriods(userId)
      const matchedPeriod = allPeriods.find((p) => p.slug === periodSlug)
      if (!matchedPeriod) {
        const available = allPeriods.map((p) => `${p.name} (slug: ${p.slug})`).join(', ')
        logger.warn('[llm/agent] tool:add_task: unknown period_slug', { userId, periodSlug, available })
        return { error: `Период со слагом "${periodSlug}" не найден. Доступные периоды: ${available}. Используй точный slug из этого списка.` }
      }

      const scheduledDate = typeof args['scheduled_date'] === 'string' ? args['scheduled_date'] : null
      const isUrgent = typeof args['is_urgent'] === 'boolean' ? args['is_urgent'] : false
      const deadlineDate = typeof args['deadline_date'] === 'string' ? args['deadline_date'] : null
      const estimatedMinutes = typeof args['estimated_minutes'] === 'number' ? args['estimated_minutes'] : null

      logger.debug('[llm/agent] tool:add_task dates', { title, scheduled_date: scheduledDate, deadline_date: deadlineDate })

      if (scheduledDate && deadlineDate) {
        logger.warn('[llm/agent] tool:add_task: both scheduled_date and deadline_date provided', { title, scheduled_date: scheduledDate, deadline_date: deadlineDate })
        return { error: 'scheduled_date и deadline_date взаимоисключающие. Уточни у пользователя, что именно он имеет в виду: конкретная дата выполнения или крайний срок.' }
      }

      if (isUrgent && (scheduledDate || deadlineDate)) {
        logger.warn('[llm/agent] tool:add_task: is_urgent conflicts with date fields', { title, scheduled_date: scheduledDate, deadline_date: deadlineDate })
        return { error: 'Срочная задача (is_urgent=true) не может иметь scheduled_date или deadline_date — это плавающая задача без конкретной даты. Убери дату или не ставь флаг срочности.' }
      }

      const queueSlug = matchedPeriod.queue_slug

      if (isUrgent) {
        const existingUrgent = await getUrgentTask(userId, queueSlug)
        if (existingUrgent) {
          logger.warn('[llm/agent] tool:add_task: urgent task already exists in queue', { userId, queueSlug, existingTitle: existingUrgent.title })
          return {
            urgent_conflict: true,
            existing_title: existingUrgent.title,
            message: `В очереди «${matchedPeriod.name}» уже есть срочная задача: «${existingUrgent.title}». В одной очереди может быть только одна срочная задача. Предложи пользователю альтернативу: назначить дедлайн, назначить конкретную дату или отменить создание.`,
          }
        }
      }
      const forceOverflow = typeof args['force_overflow'] === 'boolean' ? args['force_overflow'] : false
      let isOverflow = false

      if (scheduledDate) {
        const [sh, sm] = matchedPeriod.start_time.split(':').map(Number)
        const [eh, em] = matchedPeriod.end_time.split(':').map(Number)
        const periodCapacity = (eh * 60 + em) - (sh * 60 + sm)
        const usedMinutes = await getScheduledMinutes(userId, queueSlug, scheduledDate)
        const newTaskMinutes = estimatedMinutes ?? 30

        logger.debug('[llm/agent] tool:add_task: capacity check', {
          userId, queueSlug, scheduledDate, periodCapacity, usedMinutes, newTaskMinutes,
        })

        if (usedMinutes + newTaskMinutes > periodCapacity && !forceOverflow) {
          const available = Math.max(0, periodCapacity - usedMinutes)
          logger.warn('[llm/agent] tool:add_task: overflow detected', {
            userId, queueSlug, scheduledDate, periodCapacity, usedMinutes, newTaskMinutes, available,
          })
          return {
            overflow_warning: true,
            available_minutes: available,
            required_minutes: newTaskMinutes,
            period_name: matchedPeriod.name,
            message: `Период «${matchedPeriod.name}» заполнен (доступно ${available} мин, нужно ${newTaskMinutes} мин). Спроси пользователя, добавить задачу сверхурочно.`,
          }
        }

        isOverflow = forceOverflow && (usedMinutes + newTaskMinutes > periodCapacity)
        if (isOverflow) {
          logger.info('[llm/agent] tool:add_task: overflow confirmed, creating with is_overflow=true', {
            userId, queueSlug, scheduledDate,
          })
        }
      }

      logger.info('[llm/agent] tool:add_task', { title, period_slug: periodSlug, queue_slug: queueSlug, scheduled_date: scheduledDate, deadline_date: deadlineDate, is_overflow: isOverflow })

      const task = await createTask({
        user_id: userId,
        title,
        period_slug: queueSlug,
        scheduled_date: scheduledDate,
        is_urgent: isUrgent,
        is_overflow: isOverflow,
        deadline_date: deadlineDate,
        estimated_minutes: estimatedMinutes,
        source: 'user',
      })

      logger.info('[llm/agent] task created', { taskId: task.id, title: task.title })
      return { id: task.id, title: task.title, status: task.status }
    }

    case 'update_task': {
      const titleQuery = args['title_query']
      if (typeof titleQuery !== 'string' || !titleQuery) throw new Error('title_query must be a non-empty string')

      const updates = args['updates']
      if (typeof updates !== 'object' || updates === null) throw new Error('updates must be an object')

      const matches = await findTasksByTitle(userId, titleQuery)
      if (matches.length === 0) return { error: `Задача не найдена: ${titleQuery}` }

      const task = matches[0]
      const updatesObj = updates as Record<string, unknown>
      const patch: Record<string, unknown> = {}
      if (updatesObj['title'] !== undefined) patch['title'] = updatesObj['title']
      if (updatesObj['period_slug'] !== undefined) patch['period_slug'] = updatesObj['period_slug']
      if (updatesObj['scheduled_date'] !== undefined) patch['scheduled_date'] = updatesObj['scheduled_date']
      if (updatesObj['is_urgent'] !== undefined) patch['is_urgent'] = updatesObj['is_urgent']
      if (updatesObj['deadline_date'] !== undefined) patch['deadline_date'] = updatesObj['deadline_date']
      if (updatesObj['estimated_minutes'] !== undefined) patch['estimated_minutes'] = updatesObj['estimated_minutes']
      if (updatesObj['status'] !== undefined) patch['status'] = updatesObj['status']

      logger.debug('[llm/agent] tool:update_task patch before date resolution', { taskId: task.id, patch })

      // Mutual exclusivity: reject if both date fields arrive in the same patch
      if (patch['scheduled_date'] && patch['deadline_date']) {
        logger.warn('[llm/agent] tool:update_task: both dates in patch simultaneously', { taskId: task.id, patch })
        return { error: 'scheduled_date и deadline_date взаимоисключающие. Уточни у пользователя, что именно он имеет в виду: конкретная дата выполнения или крайний срок.' }
      }
      // Auto-clear the complementary date field to keep them exclusive
      if (patch['scheduled_date']) {
        patch['deadline_date'] = null
        logger.info('[llm/agent] tool:update_task: auto-cleared deadline_date', { taskId: task.id, scheduled_date: patch['scheduled_date'] })
      }
      if (patch['deadline_date']) {
        patch['scheduled_date'] = null
        logger.info('[llm/agent] tool:update_task: auto-cleared scheduled_date', { taskId: task.id, deadline_date: patch['deadline_date'] })
      }

      // is_urgent is exclusive with date fields: auto-clear both when setting urgent
      if (patch['is_urgent'] === true) {
        patch['scheduled_date'] = null
        patch['deadline_date'] = null
        logger.info('[llm/agent] tool:update_task: is_urgent=true, auto-cleared date fields', { taskId: task.id })

        const queueSlug = task.period_slug
        if (queueSlug) {
          const existingUrgent = await getUrgentTask(userId, queueSlug, task.id)
          if (existingUrgent) {
            logger.warn('[llm/agent] tool:update_task: urgent task already exists in queue', { userId, queueSlug, existingTitle: existingUrgent.title })
            return {
              urgent_conflict: true,
              existing_title: existingUrgent.title,
              message: `В этой очереди уже есть срочная задача: «${existingUrgent.title}». В одной очереди может быть только одна срочная задача. Предложи пользователю снять срочность с существующей задачи или выбрать другое приоритизирование (дедлайн, конкретная дата).`,
            }
          }
        }
      }

      const updated = await updateTask(task.id, patch)
      logger.info('[llm/agent] task updated', { taskId: updated.id, title: updated.title, patch })
      return { id: updated.id, title: updated.title, status: updated.status }
    }

    case 'cancel_task': {
      const titleQuery = args['title_query']
      if (typeof titleQuery !== 'string' || !titleQuery) throw new Error('title_query must be a non-empty string')

      const matches = await findTasksByTitle(userId, titleQuery)
      if (matches.length === 0) return { error: `Задача не найдена: ${titleQuery}` }

      const task = matches[0]
      const updated = await updateTask(task.id, { status: 'cancelled' })
      logger.info('[llm/agent] task cancelled', { taskId: updated.id, title: updated.title })
      return { id: updated.id, title: updated.title, status: updated.status }
    }

    case 'mark_done': {
      const titleQuery = args['title_query']
      if (typeof titleQuery !== 'string' || !titleQuery) throw new Error('title_query must be a non-empty string')

      const matches = await findTasksByTitle(userId, titleQuery)
      if (matches.length === 0) return { error: `Задача не найдена: ${titleQuery}` }

      const task = matches[0]
      const updated = await updateTask(task.id, { status: 'done' })
      logger.info('[llm/agent] task marked done', { taskId: updated.id, title: updated.title })
      return { id: updated.id, title: updated.title, status: updated.status }
    }

    case 'update_period': {
      const periodSlug = args['period_slug']
      if (typeof periodSlug !== 'string' || !periodSlug) throw new Error('period_slug must be a non-empty string')

      const patch: Record<string, unknown> = {}
      if (typeof args['name'] === 'string') patch['name'] = args['name']
      if (typeof args['start_time'] === 'string') patch['start_time'] = args['start_time']
      if (typeof args['end_time'] === 'string') patch['end_time'] = args['end_time']
      if (Array.isArray(args['days_of_week'])) patch['days_of_week'] = args['days_of_week']
      if (typeof args['queue_slug'] === 'string') patch['queue_slug'] = args['queue_slug']

      if (Object.keys(patch).length === 0) return { error: 'Не указаны поля для обновления' }

      const allPeriods = await getUserPeriods(userId)
      const target = allPeriods.find((p) => p.slug === periodSlug)
      if (!target) {
        const available = allPeriods.map((p) => p.slug).join(', ')
        return { error: `Период со слагом "${periodSlug}" не найден. Доступные: ${available}` }
      }

      const newStart = (patch['start_time'] as string | undefined) ?? target.start_time
      const newEnd = (patch['end_time'] as string | undefined) ?? target.end_time
      const newDays = (patch['days_of_week'] as number[] | undefined) ?? target.days_of_week

      const conflict = allPeriods.find(
        (p) => p.slug !== periodSlug && hasTimeOverlap(newStart, newEnd, newDays, p.start_time, p.end_time, p.days_of_week),
      )
      if (conflict) {
        return { error: `Конфликт с периодом "${conflict.name}" (${conflict.start_time}–${conflict.end_time})` }
      }

      const updated = await updatePeriod(target.id, patch)
      unregisterUserCrons(userId)
      await registerUserCrons(user)
      logger.info('[llm/agent] period updated + crons re-registered', { slug: periodSlug, queue_slug: updated.queue_slug })
      return { name: updated.name, slug: updated.slug, queue_slug: updated.queue_slug, start_time: updated.start_time, end_time: updated.end_time, days_of_week: updated.days_of_week }
    }

    case 'delete_period': {
      const periodSlug = args['period_slug']
      if (typeof periodSlug !== 'string' || !periodSlug) throw new Error('period_slug must be a non-empty string')

      const allPeriods = await getUserPeriods(userId)
      const target = allPeriods.find((p) => p.slug === periodSlug)
      if (!target) {
        const available = allPeriods.map((p) => p.slug).join(', ')
        return { error: `Период со слагом "${periodSlug}" не найден. Доступные: ${available}` }
      }

      await deletePeriod(target.id)
      unregisterUserCrons(userId)
      await registerUserCrons(user)
      logger.info('[llm/agent] period deleted + crons re-registered', { slug: periodSlug })
      return { deleted: true, name: target.name }
    }

    case 'create_period': {
      const name = args['name']
      const slug = args['slug']
      const startTime = args['start_time']
      const endTime = args['end_time']
      const daysOfWeek = args['days_of_week']

      if (typeof name !== 'string' || !name) throw new Error('name required')
      if (typeof slug !== 'string' || !slug) throw new Error('slug required')
      if (typeof startTime !== 'string' || !startTime) throw new Error('start_time required')
      if (typeof endTime !== 'string' || !endTime) throw new Error('end_time required')
      if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) throw new Error('days_of_week required')

      const allPeriods = await getUserPeriods(userId)

      if (allPeriods.some((p) => p.slug === slug)) {
        return { error: `Слаг "${slug}" уже занят` }
      }

      const conflict = allPeriods.find((p) =>
        hasTimeOverlap(startTime, endTime, daysOfWeek as number[], p.start_time, p.end_time, p.days_of_week),
      )
      if (conflict) {
        return { error: `Конфликт с периодом "${conflict.name}" (${conflict.start_time}–${conflict.end_time})` }
      }

      const maxOrder = allPeriods.reduce((m, p) => Math.max(m, p.order_index ?? 0), 0)

      const queueSlug = typeof args['queue_slug'] === 'string' && args['queue_slug'] ? args['queue_slug'] : slug

      const [created] = await createPeriods([{
        user_id: userId,
        name,
        slug,
        queue_slug: queueSlug,
        start_time: startTime,
        end_time: endTime,
        days_of_week: daysOfWeek as number[],
        order_index: maxOrder + 1,
      }])

      unregisterUserCrons(userId)
      await registerUserCrons(user)
      logger.info('[llm/agent] period created + crons re-registered', { periodId: created.id, slug, queue_slug: queueSlug })
      return { id: created.id, name: created.name, slug: created.slug, queue_slug: created.queue_slug, start_time: created.start_time, end_time: created.end_time, days_of_week: created.days_of_week }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export async function handleAgentMessage(
  user: DbUser,
  userMessage: string,
  history: ChatMessage[] = [],
): Promise<string> {
  const userId = user.id
  const { date: today } = getTodayInTimezone(user.timezone)

  logger.debug('[llm/agent] start', { userId, message: userMessage.slice(0, 60), historyLen: history.length })

  const systemPrompt = `Ты — умный ассистент-планировщик. Ты обрабатываешь ВСЕ запросы пользователя: вопросы, создание задач, редактирование, отмену и завершение, а также изменение периодов активности.
Используй доступные инструменты для получения и изменения данных в базе.
Текущая дата: ${today}. Часовой пояс пользователя: ${user.timezone}.

При создании задачи (add_task):
1. ОБЯЗАТЕЛЬНО требуется period_slug — каждая задача должна принадлежать периоду активности.
2. Если пользователь не указал период — сначала вызови get_periods, покажи список периодов и спроси в каком периоде выполнять задачу. Только после ответа вызывай add_task.
3. Используй ТОЧНЫЙ slug из get_periods, не придумывай slug самостоятельно.
4. scheduled_date и deadline_date взаимоисключающие: никогда не передавай оба поля одновременно. Если пользователь указал оба — уточни у него, что именно он имеет в виду.
5. Если add_task вернул overflow_warning: true — сообщи пользователю что период «{period_name}» заполнен (доступно available_minutes мин, нужно required_minutes мин) и спроси: добавить задачу сверхурочно? Если пользователь согласился — повтори вызов add_task с force_overflow: true. Если отказался — не создавай задачу.
6. is_urgent — взаимоисключающий флаг: срочная задача не имеет scheduled_date и не имеет deadline_date (она плавающая, всегда первая в очереди). Никогда не передавай is_urgent=true вместе с датами. Если add_task или update_task вернул urgent_conflict: true — сообщи пользователю что в этой очереди уже есть срочная задача (existing_title) и предложи альтернативы: назначить дедлайн, назначить конкретную дату выполнения или отменить создание.

При изменении периодов (update_period, delete_period, create_period):
1. Сначала вызови get_periods чтобы получить актуальные данные.
2. Покажи пользователю что именно изменится (было → станет) и спроси подтверждение.
3. Только после явного "да" / "применить" / "подтверждаю" вызывай мутирующий инструмент.
4. Если инструмент вернул ошибку (конфликт или не найдено) — сообщи об этом пользователю.

Про queue_slug (общая очередь задач):
- У каждого периода есть queue_slug — ключ общей очереди. По умолчанию queue_slug = slug.
- Если у двух периодов одинаковый queue_slug, они делят одну очередь задач (задачи добавленные в один период видны в другом).
- Чтобы объединить очереди двух периодов: вызови update_period для каждого и установи им одинаковый queue_slug (например, "work").
- Чтобы разделить: верни каждому периоду свой уникальный queue_slug.

Отвечай кратко и по делу. Используй русский язык.`

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ]

  const MAX_ITERATIONS = 5

  try {
    // [FIX] Agentic loop: supports multi-round tool calling (e.g. get_periods → add_task).
    // Previously only one round was allowed, so LLM couldn't call get_periods then add_task
    // sequentially — tasks appeared to be created but were never saved to DB.
    let iteration = 0

    while (iteration < MAX_ITERATIONS) {
      iteration++

      const response = await llmClient.chat.completions.create({
        model: STRONG_MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
      })

      const message = response.choices[0]?.message
      if (!message) throw new Error('LLM returned empty response')

      messages.push(message)

      // No tool calls — LLM produced the final answer
      if (!message.tool_calls || message.tool_calls.length === 0) {
        const content = message.content ?? 'Не смог найти информацию.'
        logger.info('[FIX] agent loop completed', {
          userId,
          iterations: iteration,
          tokens: response.usage?.total_tokens,
        })
        return content
      }

      logger.debug('[FIX] agent loop iteration', {
        userId,
        iteration,
        tools: message.tool_calls.map((t) => t.function.name),
      })

      // Execute all tool calls in this iteration
      for (const toolCall of message.tool_calls) {
        const fnName = toolCall.function.name
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
        } catch {
          logger.warn('[llm/agent] failed to parse tool args', { fnName, raw: toolCall.function.arguments })
        }

        let result: unknown
        try {
          result = await executeTool(user, fnName, args)
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) }
          logger.warn('[llm/agent] tool execution failed', { userId, tool: fnName, args, error: err instanceof Error ? err.message : String(err) })
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        })
      }
    }

    // Exceeded iteration limit — should not happen in normal usage
    logger.warn('[FIX] agent loop exceeded max iterations', { userId, MAX_ITERATIONS })
    return 'Не удалось завершить операцию: превышен лимит шагов. Попробуй ещё раз.'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[llm/agent] error', { userId, error: message })

    if (err instanceof LLMInsufficientCreditsError) throw err

    // Check for insufficient credits in error message
    const lower = message.toLowerCase()
    if (lower.includes('insufficient') || lower.includes('402') || lower.includes('credits')) {
      throw new LLMInsufficientCreditsError()
    }

    return 'Не удалось получить информацию. Попробуй позже.'
  }
}
