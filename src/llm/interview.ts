import { callLLM, STRONG_MODEL } from './client.js'
import { logger } from '../lib/logger.js'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PeriodDraft {
  name: string
  slug: string
  start_time: string
  end_time: string
  days_of_week: number[]
}

export interface InterviewResult {
  timezone: string
  morning_time: string
  end_of_day_time: string
  periods: PeriodDraft[]
}

const SYSTEM_PROMPT = `Ты — умный помощник по настройке расписания. Твоя задача — провести короткое интервью и собрать информацию о распорядке пользователя.

Общайся на русском языке, будь дружелюбным и конкретным. Задавай по одному вопросу за раз.

Тебе нужно узнать:
1. Часовой пояс пользователя (попроси назвать город или UTC-офсет, например "UTC+3" или "Москва")
2. Время утреннего уведомления (когда пользователь хочет получать план на день)
3. Время конца активного дня (когда подводить итоги)
4. Периоды активности — блоки времени в течение дня:
   - Название периода (например: "Утро", "Работа", "Вечер")
   - Время начала и конца (например: 09:00–12:00)
   - Дни недели (например: понедельник–пятница, или каждый день)

Когда все данные собраны, верни их в формате JSON внутри тегов <data>...</data>:

<data>
{
  "timezone": "Europe/Moscow",
  "morning_time": "08:00",
  "end_of_day_time": "21:00",
  "periods": [
    {
      "name": "Утро",
      "slug": "morning",
      "start_time": "08:00",
      "end_time": "10:00",
      "days_of_week": [1, 2, 3, 4, 5]
    }
  ]
}
</data>

Правила для JSON:
- timezone: стандартное IANA-название (например, "Europe/Moscow", "America/New_York", "UTC")
- morning_time и end_of_day_time: формат "HH:MM"
- start_time / end_time: формат "HH:MM"
- slug: латиница, snake_case, сгенерируй из name (например: "Утро" → "morning", "Глубокая работа" → "deep_work")
- days_of_week: ISO-числа (1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб, 7=Вс)

Не возвращай <data> пока не собрал все необходимые данные.`

export async function continueInterview(history: ChatMessage[]): Promise<string> {
  logger.debug('[llm/interview] continueInterview', { historyLength: history.length })

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ]

  const response = await callLLM({ model: STRONG_MODEL, messages, temperature: 0.5 })

  logger.debug('[llm/interview] continueInterview done', { historyLength: history.length, responseLength: response.length })
  return response
}

const DATA_TAG_REGEX = /<data>([\s\S]*?)<\/data>/

export function parseInterviewResult(text: string): InterviewResult | null {
  const match = DATA_TAG_REGEX.exec(text)

  if (!match) {
    logger.debug('[llm/interview] parseInterviewResult no data block found')
    return null
  }

  const jsonStr = match[1].trim()

  try {
    const parsed = JSON.parse(jsonStr) as InterviewResult
    logger.info('[llm/interview] parseInterviewResult found data block', {
      timezone: parsed.timezone,
      periodsCount: parsed.periods?.length,
    })
    return parsed
  } catch (err) {
    logger.error('[llm/interview] parseInterviewResult parse error', {
      error: err instanceof Error ? err.message : String(err),
      jsonStr,
    })
    return null
  }
}
