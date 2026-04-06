import { callLLM, FAST_MODEL } from './client.js'
import { logger } from '../lib/logger.js'

export interface ParsedProgress {
  title: string
  note: string | null
}

const FALLBACK_RESULT: ParsedProgress = {
  title: '',
  note: null,
}

const SYSTEM_PROMPT = `Ты — парсер прогресса задач. Из сообщения пользователя извлеки название задачи и заметку о прогрессе.

Верни JSON внутри тегов <progress>...</progress>:

<progress>
{ "title": "название задачи", "note": "заметка о прогрессе или null" }
</progress>

Правила:
- title: название задачи, которую упоминает пользователь (строка, обязательно)
- note: текст заметки о прогрессе или null если не указана
- Отвечай только тегом <progress> без лишнего текста`

function parseProgressXml(text: string): ParsedProgress | null {
  const match = /<progress>([\s\S]*?)<\/progress>/.exec(text)
  if (!match) return null

  try {
    return JSON.parse(match[1].trim()) as ParsedProgress
  } catch {
    return null
  }
}

export async function parseProgressUpdate(text: string): Promise<ParsedProgress> {
  logger.debug('[llm/parse-progress] parseProgressUpdate', { textLength: text.length })

  try {
    const response = await callLLM({
      model: FAST_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    })

    const parsed = parseProgressXml(response)

    if (!parsed) {
      logger.warn('[llm/parse-progress] parse failed, using fallback', {
        responsePreview: response.slice(0, 200),
      })
      return { ...FALLBACK_RESULT }
    }

    logger.debug('[llm/parse-progress] parsed', { title: parsed.title, hasNote: parsed.note !== null })
    return parsed
  } catch (err) {
    logger.warn('[llm/parse-progress] llm error, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...FALLBACK_RESULT }
  }
}
