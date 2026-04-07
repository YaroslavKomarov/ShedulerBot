import OpenAI from 'openai'
import { logger } from '../lib/logger.js'

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  throw new Error('Missing required env var: OPENROUTER_API_KEY must be set')
}

export const llmClient = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey,
})

// Fast model: NLU tasks, intent detection, task parsing
export const FAST_MODEL = process.env.FAST_MODEL ?? 'google/gemini-2.0-flash-001'

// Strong model: plan generation, onboarding interview, retrospective
export const STRONG_MODEL = process.env.STRONG_MODEL ?? 'anthropic/claude-3.5-sonnet'

// Whisper: audio transcription
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'openai/whisper-large-v3'

export class LLMInsufficientCreditsError extends Error {
  constructor() {
    super('OpenRouter balance is insufficient')
    this.name = 'LLMInsufficientCreditsError'
  }
}

export interface CallLLMOptions {
  model: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  temperature?: number
}

function isInsufficientCredits(message: string): boolean {
  const lower = message.toLowerCase()
  // Note: "no endpoints found" is a wrong model slug error, NOT a balance error — do not include it
  return (
    lower.includes('insufficient') ||
    lower.includes('402') ||
    lower.includes('payment') ||
    lower.includes('credits')
  )
}

export async function callLLM({ model, messages, temperature = 0.7 }: CallLLMOptions): Promise<string> {
  logger.debug('[llm/client] callLLM', { model, messageCount: messages.length, temperature })

  try {
    const response = await llmClient.chat.completions.create({
      model,
      messages,
      temperature,
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('LLM returned empty response')
    }

    logger.debug('[llm/client] callLLM done', {
      model,
      tokens: response.usage?.total_tokens,
    })

    return content
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[llm/client] callLLM error', { model, error: message })

    if (isInsufficientCredits(message)) {
      throw new LLMInsufficientCreditsError()
    }

    throw new Error(`LLM call failed (model=${model}): ${message}`)
  }
}
