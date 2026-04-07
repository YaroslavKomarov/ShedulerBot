import type { Conversation } from '@grammyjs/conversations'
import type { BotContext } from '../index.js'
import { transcribeVoiceById } from '../middleware/voice.js'

type AnyConversation = Conversation<BotContext, BotContext>

/**
 * Wait for the next text or voice message from the user.
 * Voice messages are transcribed before returning.
 * Returns { ctx, text } — ctx is the original update context.
 */
export async function waitForText(
  conversation: AnyConversation,
): Promise<{ ctx: BotContext; text: string }> {
  const ctx = await conversation.waitFor(['message:text', 'message:voice'])

  if (ctx.message?.voice) {
    // Extract primitives from ctx BEFORE the external() call.
    // Passing Grammy Context objects into conversation.external() closures is unsafe —
    // Grammy reconstructs ctx from stored update data during replay, and methods like
    // ctx.getFile() may behave unpredictably on a replayed context.
    const fileId = ctx.message.voice.file_id
    const userId = ctx.from?.id
    const text = await conversation.external(() => transcribeVoiceById(fileId, userId))
    return { ctx, text }
  }

  return { ctx, text: ctx.message?.text ?? '' }
}
