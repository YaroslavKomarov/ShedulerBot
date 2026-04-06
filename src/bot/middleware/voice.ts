import { llmClient, WHISPER_MODEL } from '../../llm/client.js'
import { logger } from '../../lib/logger.js'
import type { BotContext } from '../index.js'

export async function transcribeVoice(ctx: BotContext): Promise<string> {
  const userId = ctx.from?.id
  const fileId = ctx.message?.voice?.file_id

  logger.debug('[voice] transcribeVoice start', { userId, fileId })

  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN')
  }

  // 1. Get file path from Telegram
  const fileInfo = await ctx.getFile()
  const filePath = fileInfo.file_path

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
    const transcription = await llmClient.audio.transcriptions.create({
      model: WHISPER_MODEL,
      file,
    })

    const charCount = transcription.text.length
    logger.info('[voice] transcription done', { userId, charCount })

    return transcription.text
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('[voice] transcription failed', { userId, error: message })
    throw err
  }
}
