import { callLLM, STRONG_MODEL } from './client.js'
import { logger } from '../lib/logger.js'
import type { DbUser, DbTask, DbPeriod } from '../types/index.js'

export interface TaskSlot {
  task: DbTask
  startTime: string  // "HH:MM"
  endTime: string    // "HH:MM"
}

export interface PeriodPlan {
  period: DbPeriod
  tasks: DbTask[]
  slots: TaskSlot[]
}

function buildSystemPrompt(): string {
  return `Ты — помощник по планированию дня. Тебе дан структурированный план пользователя на день.
Твоя задача — отформатировать его в красивое текстовое сообщение для Telegram (Markdown).

Правила форматирования:
- Используй эмодзи для периодов и задач
- Показывай время периодов и тайм-слоты задач если они есть
- Срочные задачи помечай 🔴
- Задачи с дедлайном показывай с датой дедлайна
- Задачи без estimated_minutes допустимо показывать без времени
- Если в периоде нет задач — напиши "Задачи не запланированы"
- Завершай сообщение коротким мотивирующим пожеланием
- Используй Markdown: *жирный*, _курсив_, \`код\``
}

function buildUserPrompt(user: DbUser, date: string, periodPlans: PeriodPlan[]): string {
  const lines: string[] = [
    `Дата: ${date}`,
    `Таймзона: ${user.timezone}`,
    '',
    'Периоды и задачи:',
  ]

  for (const { period, slots, tasks } of periodPlans) {
    lines.push(`\nПериод: ${period.name} (${period.start_time}–${period.end_time})`)

    if (tasks.length === 0) {
      lines.push('  (задачи не запланированы)')
      continue
    }

    for (const task of tasks) {
      const slot = slots.find((s) => s.task.id === task.id)
      const timeStr = slot ? `[${slot.startTime}–${slot.endTime}]` : ''
      const urgentStr = task.is_urgent ? '🔴 СРОЧНО ' : ''
      const deadlineStr = task.deadline_date ? ` (дедлайн: ${task.deadline_date})` : ''
      const durationStr = task.estimated_minutes ? ` ~${task.estimated_minutes} мин` : ''
      lines.push(`  ${timeStr} ${urgentStr}${task.title}${durationStr}${deadlineStr}`)
    }
  }

  return lines.join('\n')
}

function buildFallbackMessage(date: string, periodPlans: PeriodPlan[]): string {
  const lines: string[] = [`📅 *План на ${date}*\n`]

  for (const { period, tasks } of periodPlans) {
    lines.push(`*${period.name}* (${period.start_time}–${period.end_time})`)

    if (tasks.length === 0) {
      lines.push('_Задачи не запланированы_')
    } else {
      for (const task of tasks) {
        const urgentStr = task.is_urgent ? '🔴 ' : '• '
        const durationStr = task.estimated_minutes ? ` (~${task.estimated_minutes} мин)` : ''
        lines.push(`${urgentStr}${task.title}${durationStr}`)
      }
    }
    lines.push('')
  }

  lines.push('Хорошего продуктивного дня! 💪')
  return lines.join('\n')
}

export async function generateDayPlanMessage(
  user: DbUser,
  date: string,
  periodPlans: PeriodPlan[],
): Promise<string> {
  const totalTasks = periodPlans.reduce((sum, pp) => sum + pp.tasks.length, 0)

  logger.debug('[llm/plan] generateDayPlanMessage', {
    userId: user.id,
    date,
    periodCount: periodPlans.length,
    totalTasks,
  })

  if (periodPlans.length === 0) {
    logger.debug('[llm/plan] no periods, returning fallback', { userId: user.id, date })
    return buildFallbackMessage(date, periodPlans)
  }

  try {
    const response = await callLLM({
      model: STRONG_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(user, date, periodPlans) },
      ],
      temperature: 0.4,
    })

    logger.debug('[llm/plan] done', { userId: user.id, date })
    return response
  } catch (err) {
    logger.warn('[llm/plan] error, using fallback', {
      userId: user.id,
      date,
      error: err instanceof Error ? err.message : String(err),
    })
    return buildFallbackMessage(date, periodPlans)
  }
}
