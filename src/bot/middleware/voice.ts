import OpenAI from 'openai'
import { logger } from '../../lib/logger.js'
import type { BotContext } from '../index.js'

type WhisperProvider = 'groq' | 'openai'

function getWhisperClient(): { client: OpenAI; model: string } {
  const provider = (process.env.WHISPER_PROVIDER ?? 'groq') as WhisperProvider

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('Missing required env var: OPENAI_API_KEY must be set for WHISPER_PROVIDER=openai')
    return { client: new OpenAI({ apiKey }), model: 'whisper-1' }
  }

  // Default: groq — free, 2000 min/day, whisper-large-v3 (best quality)
  // OpenRouter does NOT support /audio/transcriptions — use Groq instead.
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('Missing required env var: GROQ_API_KEY must be set for WHISPER_PROVIDER=groq')
  return {
    client: new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey }),
    model: 'whisper-large-v3',
  }
}

/**
 * Core transcription function — takes only primitives, safe to use inside conversation.external().
 * Downloads the OGG file directly from Telegram API without needing Grammy context.
 */
export async function transcribeVoiceById(fileId: string, userId?: number): Promise<string> {
  const provider = process.env.WHISPER_PROVIDER ?? 'groq'
  const language = process.env.WHISPER_LANGUAGE ?? 'ru'

  logger.debug('[voice] transcribeVoiceById start', { userId, fileId, provider, language })

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN')

  // 1. Get file path from Telegram
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`)
  if (!fileInfoRes.ok) {
    const err = new Error(`getFile failed: HTTP ${fileInfoRes.status}`)
    logger.error('[voice] getFile failed', { userId, error: err.message })
    throw err
  }

  const fileInfoJson = (await fileInfoRes.json()) as { ok: boolean; result?: { file_path?: string } }
  const filePath = fileInfoJson.result?.file_path

  if (!filePath) {
    const err = new Error('Telegram did not return file_path')
    logger.error('[voice] transcription failed', { userId, error: err.message })
    throw err
  }

  // 2. Download OGG buffer
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`
  const response = await fetch(url)

  if (!response.ok) {
    const err = new Error(`Failed to download voice file: HTTP ${response.status}`)
    logger.error('[voice] transcription failed', { userId, error: err.message })
    throw err
  }

  const arrayBuffer = await response.arrayBuffer()
  const sizeBytes = arrayBuffer.byteLength
  logger.debug('[voice] file downloaded', { userId, fileId, sizeBytes })

  // 3. Create File object and transcribe
  const file = new File([arrayBuffer], 'voice.ogg', { type: 'audio/ogg' })

  try {
    const { client, model } = getWhisperClient()
    const transcription = await client.audio.transcriptions.create({
      model,
      file,
      language,
    })

    const charCount = transcription.text.length
    logger.info('[voice] transcription done', { userId, charCount, provider })

    return transcription.text
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[voice] transcription failed', { userId, error: message })
    throw err
  }
}

/**
 * Convenience wrapper for use OUTSIDE conversations (global bot handler).
 * Uses Grammy ctx to get file_id — do NOT use this inside conversation.external().
 */
export async function transcribeVoice(ctx: BotContext): Promise<string> {
  const fileId = ctx.message?.voice?.file_id
  if (!fileId) throw new Error('No voice file_id in context')
  return transcribeVoiceById(fileId, ctx.from?.id)
}
