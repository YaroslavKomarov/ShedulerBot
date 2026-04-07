import { supabase } from './client.js'
import { logger } from '../lib/logger.js'

const db = supabase

const HISTORY_LIMIT = 10

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function getChatHistory(userId: string, limit = HISTORY_LIMIT): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('sch_chat_history')
    .select('role, content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    logger.warn('[db/chat-history] getChatHistory error', { userId, error: error.message })
    return []
  }

  // Reverse to get chronological order (oldest first)
  return (data as ChatMessage[]).reverse()
}

export async function saveChatMessage(
  userId: string,
  role: 'user' | 'assistant',
  content: string,
): Promise<void> {
  const { error } = await db
    .from('sch_chat_history')
    .insert({ user_id: userId, role, content })

  if (error) {
    logger.warn('[db/chat-history] saveChatMessage error', { userId, role, error: error.message })
    return
  }

  // Trim to last HISTORY_LIMIT messages
  const { data: old } = await db
    .from('sch_chat_history')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(HISTORY_LIMIT, 10000)

  if (old && old.length > 0) {
    const ids = (old as { id: string }[]).map((r) => r.id)
    await db.from('sch_chat_history').delete().in('id', ids)
  }
}

export async function clearChatHistory(userId: string): Promise<void> {
  const { error } = await db
    .from('sch_chat_history')
    .delete()
    .eq('user_id', userId)

  if (error) {
    logger.warn('[db/chat-history] clearChatHistory error', { userId, error: error.message })
  }
}
