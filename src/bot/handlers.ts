import type { BotContext } from './index.js'
import type { DbUser } from '../types/index.js'
import { getUserByTelegramId } from '../db/users.js'
import { getUserPeriods } from '../db/periods.js'
import { detectIntent } from '../llm/intent.js'
import { parseTaskMessage } from '../llm/parse-task.js'
import { parseProgressUpdate } from '../llm/parse-progress.js'
import { findTasksByTitle, updateTask, getBacklog } from '../db/tasks.js'
import { sendPlanForDate } from './plan-helper.js'
import { logger } from '../lib/logger.js'

function todayIso(): string {
  return new Date().toISOString().split('T')[0]
}

async function handleModifyTask(ctx: BotContext, user: DbUser): Promise<void> {
  const text = ctx.message?.text ?? ''

  const periods = await getUserPeriods(user.id)
  const userContext = {
    timezone: user.timezone,
    today: todayIso(),
    periods: periods.map((p) => ({ name: p.name, slug: p.slug })),
  }

  const parsed = await parseTaskMessage(text, userContext)

  if (!parsed.title) {
    await ctx.reply('Не понял, какую задачу изменить. Укажи название задачи.')
    return
  }

  logger.debug('[bot/handlers] modify_task: searching', { userId: user.id, query: parsed.title })

  const matches = await findTasksByTitle(user.id, parsed.title)

  if (matches.length === 0) {
    logger.warn('[bot/handlers] modify_task: not found', { userId: user.id, query: parsed.title })
    await ctx.reply(`Не нашёл такую задачу 🤷`)
    return
  }

  // Use first match (future improvement: handle multiple)
  const task = matches[0]

  const update: Record<string, unknown> = {}
  if (parsed.is_urgent !== undefined) update.is_urgent = parsed.is_urgent
  if (parsed.deadline_date !== undefined) update.deadline_date = parsed.deadline_date
  if (parsed.scheduled_date !== undefined) update.scheduled_date = parsed.scheduled_date

  // Detect cancellation intent from original text
  const lowerText = text.toLowerCase()
  const isCancellation =
    lowerText.includes('отмени') ||
    lowerText.includes('удали') ||
    lowerText.includes('убери') ||
    lowerText.includes('cancel')

  if (isCancellation) {
    update.status = 'cancelled'
  }

  const updated = await updateTask(task.id, update)
  logger.info('[bot/handlers] modify_task: updated task', { taskId: updated.id })

  if (update.status === 'cancelled') {
    await ctx.reply(`Задача отменена: ${updated.title}`)
  } else {
    await ctx.reply(`Задача обновлена: ${updated.title}`)
  }
}

async function handleMarkDone(ctx: BotContext, user: DbUser): Promise<void> {
  const text = ctx.message?.text ?? ''
  logger.debug('[bot/handlers] mark_done: parsing title', { userId: user.id })

  const periods = await getUserPeriods(user.id)
  const userContext = {
    timezone: user.timezone,
    today: todayIso(),
    periods: periods.map((p) => ({ name: p.name, slug: p.slug })),
  }

  const parsed = await parseTaskMessage(text, userContext)

  if (!parsed.title) {
    await ctx.reply('Не понял, какую задачу отметить выполненной. Укажи название.')
    return
  }

  const matches = await findTasksByTitle(user.id, parsed.title)

  if (matches.length === 0) {
    logger.warn('[bot/handlers] mark_done: not found', { userId: user.id, query: parsed.title })
    await ctx.reply('Задача не найдена 🤷')
    return
  }

  const task = matches[0]

  if (matches.length > 1) {
    logger.debug('[bot/handlers] mark_done: multiple matches, using first', {
      userId: user.id,
      count: matches.length,
    })
  }

  const updated = await updateTask(task.id, { status: 'done' })
  logger.info('[bot/handlers] mark_done: done', { userId: user.id, taskId: updated.id, title: updated.title })

  if (matches.length > 1) {
    await ctx.reply(`✅ Отмечено: ${updated.title} (нашёл несколько совпадений, взял первое)`)
  } else {
    await ctx.reply(`✅ Отмечено: ${updated.title}`)
  }
}

async function handleUpdateProgress(ctx: BotContext, user: DbUser): Promise<void> {
  const text = ctx.message?.text ?? ''
  logger.debug('[bot/handlers] update_progress: parsing', { userId: user.id })

  const { title, note } = await parseProgressUpdate(text)

  if (!title) {
    await ctx.reply('Не понял, по какой задаче обновить прогресс.')
    return
  }

  const matches = await findTasksByTitle(user.id, title)

  if (matches.length === 0) {
    logger.warn('[bot/handlers] update_progress: not found', { userId: user.id, query: title })
    await ctx.reply('Задача не найдена 🤷')
    return
  }

  const task = matches[0]
  const updated = await updateTask(task.id, { progress_note: note ?? '' })
  logger.info('[bot/handlers] update_progress: saved', {
    userId: user.id,
    taskId: updated.id,
    hasNote: note !== null,
  })

  await ctx.reply(`📝 Прогресс обновлён: ${updated.title}`)
}

async function handleShowBacklog(ctx: BotContext, user: DbUser): Promise<void> {
  const tasks = await getBacklog(user.id)
  logger.info('[bot/handlers] show_backlog', { userId: user.id, count: tasks.length })

  if (tasks.length === 0) {
    await ctx.reply('Бэклог пуст — отличная работа! 🎉')
    return
  }

  // Group by period_slug: tasks with slug first, then without
  const withPeriod = tasks.filter((t) => t.period_slug)
  const withoutPeriod = tasks.filter((t) => !t.period_slug)

  // Group withPeriod by slug
  const bySlug = new Map<string, typeof tasks>()
  for (const task of withPeriod) {
    const slug = task.period_slug!
    const group = bySlug.get(slug) ?? []
    group.push(task)
    bySlug.set(slug, group)
  }

  const lines: string[] = [`📋 *Бэклог (${tasks.length} задач):*`, '']

  for (const [slug, group] of bySlug) {
    lines.push(`*${slug}:*`)
    for (const t of group) {
      let line = `• ${t.title}`
      if (t.is_urgent) line += ' 🔴 срочно'
      if (t.deadline_date) {
        const d = new Date(t.deadline_date)
        const day = String(d.getDate()).padStart(2, '0')
        const month = String(d.getMonth() + 1).padStart(2, '0')
        line += ` 📅 до ${day}.${month}`
      }
      lines.push(line)
    }
    lines.push('')
  }

  if (withoutPeriod.length > 0) {
    for (const t of withoutPeriod) {
      let line = `• ${t.title}`
      if (t.is_urgent) line += ' 🔴 срочно'
      if (t.deadline_date) {
        const d = new Date(t.deadline_date)
        const day = String(d.getDate()).padStart(2, '0')
        const month = String(d.getMonth() + 1).padStart(2, '0')
        line += ` 📅 до ${day}.${month}`
      }
      lines.push(line)
    }
    lines.push('')
  }

  lines.push('Чтобы запланировать задачу, напиши: "перенеси [название] на [дата]"')

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
}

export async function handleText(ctx: BotContext, text: string): Promise<void> {
  if (!ctx.from) return

  const telegramId = ctx.from.id

  const user = await getUserByTelegramId(telegramId)
  if (!user) {
    // New user — let /start handle onboarding
    return
  }

  const detected = await detectIntent(text)
  logger.info('[bot/handlers] handleText', {
    userId: telegramId,
    intent: detected.intent,
    confidence: detected.confidence,
  })

  switch (detected.intent) {
    case 'add_task':
      await ctx.conversation.enter('addTaskConversation', text)
      break

    case 'modify_task':
      await handleModifyTask(ctx, user)
      break

    case 'show_plan':
      logger.debug('[bot/handlers] show_plan', { userId: telegramId })
      await sendPlanForDate(ctx, 0)
      break

    case 'show_backlog':
      await handleShowBacklog(ctx, user)
      break

    case 'mark_done':
      await handleMarkDone(ctx, user)
      break

    case 'update_progress':
      await handleUpdateProgress(ctx, user)
      break

    default:
      await ctx.reply('Не понял. Чтобы добавить задачу — просто напиши её.')
      break
  }
}

export async function handleFreeText(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.message?.text) return
  await handleText(ctx, ctx.message.text)
}
