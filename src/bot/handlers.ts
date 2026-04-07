import type { BotContext } from './index.js'
import { getUserByTelegramId } from '../db/users.js'
import { handleAgentMessage } from '../llm/agent-query.js'
import { getChatHistory, saveChatMessage } from '../db/chat-history.js'
import { logger } from '../lib/logger.js'

export async function handleText(ctx: BotContext, text: string): Promise<void> {
  if (!ctx.from) return

  const user = await getUserByTelegramId(ctx.from.id)
  if (!user) return

  const history = await getChatHistory(user.id)
  logger.debug('[bot/handlers] handleText', { userId: user.id, textLength: text.length, historyLen: history.length })

  const reply = await handleAgentMessage(user, text, history)

  await ctx.reply(reply)
  logger.debug('[bot/handlers] reply sent', { userId: user.id, replyLength: reply.length })

  await saveChatMessage(user.id, 'user', text)
  await saveChatMessage(user.id, 'assistant', reply)
}

export async function handleFreeText(ctx: BotContext): Promise<void> {
  if (!ctx.from || !ctx.message?.text) return
  await handleText(ctx, ctx.message.text)
}
