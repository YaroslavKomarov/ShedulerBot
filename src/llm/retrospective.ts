import { callLLM, STRONG_MODEL } from './client.js'
import { logger } from '../lib/logger.js'
import type { DbUser, DbTask } from '../types/index.js'

function buildSystemPrompt(): string {
  return `Ты — ассистент дневного планирования. Сгенерируй краткое тёплое итоговое сообщение за день.
Начни с эмодзи и оценки дня, затем укажи факты (выполненные и пропущенные задачи), потом добавь мотивирующий финал.
Ответ дай в теге <retro>...</retro>. Внутри тега — Markdown-текст сообщения, без лишних комментариев.`
}

function buildUserPrompt(
  date: string,
  doneTasks: DbTask[],
  missedTasks: DbTask[],
  backlogNoDate: DbTask[],
): string {
  const lines: string[] = [`Итоги дня: ${date}`, '']

  if (doneTasks.length > 0) {
    lines.push(`Выполненные задачи (${doneTasks.length}):`)
    for (const t of doneTasks) lines.push(`  • ${t.title}`)
    lines.push('')
  } else {
    lines.push('Выполненных задач нет.')
    lines.push('')
  }

  if (missedTasks.length > 0) {
    lines.push(`Не выполненные задачи (${missedTasks.length}):`)
    for (const t of missedTasks) lines.push(`  • ${t.title}`)
    lines.push('')
  }

  if (backlogNoDate.length > 0) {
    lines.push(`Задачи в бэклоге без даты и без срочности (${backlogNoDate.length}):`)
    for (const t of backlogNoDate) lines.push(`  • ${t.title}`)
    lines.push('')
  }

  return lines.join('\n')
}

function buildFallback(date: string, doneTasks: DbTask[], missedTasks: DbTask[], backlogNoDate: DbTask[]): string {
  return [
    `📊 Итоги дня ${date}:`,
    `✅ Выполнено: ${doneTasks.length} задач`,
    `⏭️ Не выполнено: ${missedTasks.length} задач`,
    `📋 В бэклоге без даты: ${backlogNoDate.length} задач`,
  ].join('\n')
}

export async function generateRetrospectiveMessage(
  user: DbUser,
  date: string,
  doneTasks: DbTask[],
  missedTasks: DbTask[],
  backlogNoDate: DbTask[],
): Promise<string> {
  logger.debug('[llm/retrospective] generateRetrospectiveMessage', {
    userId: user.id,
    date,
    done: doneTasks.length,
    missed: missedTasks.length,
    backlogNoDate: backlogNoDate.length,
  })

  try {
    const response = await callLLM({
      model: STRONG_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(date, doneTasks, missedTasks, backlogNoDate) },
      ],
      temperature: 0.7,
    })

    const match = response.match(/<retro>([\s\S]*?)<\/retro>/)
    if (!match) {
      logger.warn('[llm/retrospective] parse failed, using fallback', {
        responsePreview: response.slice(0, 200),
      })
      return buildFallback(date, doneTasks, missedTasks, backlogNoDate)
    }

    const message = match[1].trim()
    logger.debug('[llm/retrospective] message generated', { userId: user.id, charLen: message.length })
    return message
  } catch (err) {
    logger.warn('[llm/retrospective] llm error, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    })
    return buildFallback(date, doneTasks, missedTasks, backlogNoDate)
  }
}
