import { callLLM, FAST_MODEL } from './client.js'
import { logger } from '../lib/logger.js'

export interface ParsedTask {
  title: string
  description: string | null
  is_urgent: boolean
  deadline_date: string | null    // ISO "YYYY-MM-DD" or null
  estimated_minutes: number | null
  period_slug: string | null      // matched from userContext.periods by name
  scheduled_date: string | null   // resolved ISO date, or null
  needs_clarification: boolean
  clarification_question: string | null
}

export interface ParseTaskContext {
  timezone: string
  today: string  // ISO date "YYYY-MM-DD"
  periods: { name: string; slug: string }[]
}

const FALLBACK_RESULT: ParsedTask = {
  title: '',
  description: null,
  is_urgent: false,
  deadline_date: null,
  estimated_minutes: null,
  period_slug: null,
  scheduled_date: null,
  needs_clarification: true,
  clarification_question: 'Не понял задачу, попробуй переформулировать.',
}

function buildSystemPrompt(ctx: ParseTaskContext): string {
  const periodsJson = JSON.stringify(ctx.periods)
  return `Ты — парсер задач. Из сообщения пользователя извлеки структурированную задачу.

Контекст:
- Сегодня: ${ctx.today} (timezone: ${ctx.timezone})
- Периоды активности пользователя: ${periodsJson}

Верни JSON внутри тегов <task>...</task>:

<task>
{
  "title": "краткое название задачи",
  "description": "подробное описание или null",
  "is_urgent": false,
  "deadline_date": "YYYY-MM-DD или null",
  "estimated_minutes": 30,
  "period_slug": "slug периода или null",
  "scheduled_date": "YYYY-MM-DD или null",
  "needs_clarification": false,
  "clarification_question": null
}
</task>

Правила:
- Относительные даты: "сегодня" → ${ctx.today}; "завтра" → следующий день; "в пятницу" → ближайшая пятница
- Если упоминается период по названию — найди его slug из списка выше
- is_urgent: true если явно указано "срочно", "asap", "горит"
- estimated_minutes: число минут или null если не указано
- needs_clarification: true если сообщение слишком расплывчато (одно слово, приветствие, бессмысленный текст)
- Если needs_clarification: true → title может быть пустой строкой, укажи clarification_question на русском
- Отвечай только тегом <task> без лишнего текста`
}

export function parseTaskXml(text: string): ParsedTask | null {
  const match = /<task>([\s\S]*?)<\/task>/.exec(text)
  if (!match) return null

  try {
    return JSON.parse(match[1].trim()) as ParsedTask
  } catch {
    return null
  }
}

export async function parseTaskMessage(
  text: string,
  userContext: ParseTaskContext,
): Promise<ParsedTask> {
  logger.debug('[llm/parse-task] parseTaskMessage', {
    textLength: text.length,
    periodCount: userContext.periods.length,
    today: userContext.today,
  })

  try {
    const response = await callLLM({
      model: FAST_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(userContext) },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
    })

    const parsed = parseTaskXml(response)

    if (!parsed) {
      logger.error('[llm/parse-task] parse error: no <task> tag in response', {
        responsePreview: response.slice(0, 200),
      })
      return { ...FALLBACK_RESULT }
    }

    logger.debug('[llm/parse-task] parsed', {
      title: parsed.title,
      is_urgent: parsed.is_urgent,
      has_deadline: parsed.deadline_date !== null,
      needs_clarification: parsed.needs_clarification,
    })

    return parsed
  } catch (err) {
    logger.warn('[llm/parse-task] llm error, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...FALLBACK_RESULT }
  }
}
