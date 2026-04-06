import { callLLM, FAST_MODEL } from './client.js'
import { logger } from '../lib/logger.js'

export type Intent =
  | 'add_task'
  | 'modify_task'
  | 'show_plan'
  | 'show_backlog'
  | 'mark_done'
  | 'update_progress'
  | 'other'

export interface DetectedIntent {
  intent: Intent
  confidence: 'high' | 'low'
}

const FALLBACK: DetectedIntent = { intent: 'other', confidence: 'low' }

const SYSTEM_PROMPT = `Ты — классификатор намерений для бота-планировщика. Определи намерение пользователя.

Возможные намерения:
- add_task: пользователь хочет добавить новую задачу
- modify_task: пользователь хочет изменить, перенести или отменить существующую задачу
- show_plan: пользователь хочет увидеть план на сегодня или другой день
- show_backlog: пользователь хочет увидеть список задач без даты
- mark_done: пользователь сообщает что выполнил задачу(и)
- update_progress: пользователь хочет обновить прогресс или заметки по задаче
- other: всё остальное

Верни JSON внутри тегов <intent>...</intent>:

<intent>
{ "intent": "add_task", "confidence": "high" }
</intent>

confidence: "high" если намерение очевидно, "low" если неоднозначно.
Отвечай только тегом <intent> без лишнего текста.`

export function parseIntentXml(text: string): DetectedIntent | null {
  const match = /<intent>([\s\S]*?)<\/intent>/.exec(text)
  if (!match) return null

  try {
    return JSON.parse(match[1].trim()) as DetectedIntent
  } catch {
    return null
  }
}

export async function detectIntent(text: string): Promise<DetectedIntent> {
  logger.debug('[llm/intent] detectIntent', { textSnippet: text.slice(0, 60) })

  try {
    const response = await callLLM({
      model: FAST_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    })

    const parsed = parseIntentXml(response)

    if (!parsed) {
      logger.warn('[llm/intent] parse failed, using fallback', {
        responsePreview: response.slice(0, 100),
      })
      return { ...FALLBACK }
    }

    logger.debug('[llm/intent] detected', { intent: parsed.intent, confidence: parsed.confidence })
    return parsed
  } catch (err) {
    logger.warn('[llm/intent] llm error, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...FALLBACK }
  }
}
