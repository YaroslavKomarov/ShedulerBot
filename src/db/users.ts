import { supabase } from './client.js'
import type { DbUser, DbUserInsert, DbUserUpdate } from '../types/index.js'
import { logger } from '../lib/logger.js'

export async function getUserByTelegramId(telegramId: number): Promise<DbUser | null> {
  logger.debug('[db/users] getUserByTelegramId', { telegramId })

  const { data, error } = await supabase
    .from('sch_users')
    .select('*')
    .eq('telegram_id', telegramId)
    .maybeSingle()

  if (error) {
    logger.error('[db/users] getUserByTelegramId error', { telegramId, error: error.message })
    throw new Error(`Failed to get user by telegram_id=${telegramId}: ${error.message}`)
  }

  logger.debug('[db/users] getUserByTelegramId result', { telegramId, found: data !== null })
  return data
}

export async function getUserById(id: string): Promise<DbUser | null> {
  logger.debug('[db/users] getUserById', { id })

  const { data, error } = await supabase
    .from('sch_users')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    logger.error('[db/users] getUserById error', { id, error: error.message })
    throw new Error(`Failed to get user by id=${id}: ${error.message}`)
  }

  logger.debug('[db/users] getUserById result', { id, found: data !== null })
  return data
}

export async function createUser(data: DbUserInsert): Promise<DbUser> {
  logger.debug('[db/users] createUser', { telegram_id: data.telegram_id })

  const { data: created, error } = await supabase
    .from('sch_users')
    .insert(data)
    .select()
    .single()

  if (error) {
    logger.error('[db/users] createUser error', { telegram_id: data.telegram_id, error: error.message })
    throw new Error(`Failed to create user telegram_id=${data.telegram_id}: ${error.message}`)
  }

  logger.info('[db/users] user created', { id: created.id, telegram_id: created.telegram_id })
  return created
}

export async function updateUser(id: string, data: DbUserUpdate): Promise<DbUser> {
  logger.debug('[db/users] updateUser', { id, fields: Object.keys(data) })

  const { data: updated, error } = await supabase
    .from('sch_users')
    .update(data)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    logger.error('[db/users] updateUser error', { id, error: error.message })
    throw new Error(`Failed to update user id=${id}: ${error.message}`)
  }

  logger.info('[db/users] user updated', { id })
  return updated
}

export async function getUserBySoloLevelingToken(token: string): Promise<DbUser | null> {
  logger.debug('[db/users] getUserBySoloLevelingToken', { tokenPrefix: token.slice(0, 8) })

  const { data, error } = await supabase
    .from('sch_users')
    .select('*')
    .eq('solo_leveling_token', token)
    .maybeSingle()

  if (error) {
    logger.error('[db/users] getUserBySoloLevelingToken error', { error: error.message })
    throw new Error(`Failed to get user by solo_leveling_token: ${error.message}`)
  }

  logger.debug('[db/users] getUserBySoloLevelingToken result', { found: data !== null })
  return data
}

export async function getAllUsersForCron(): Promise<DbUser[]> {
  logger.debug('[db/users] getAllUsersForCron')

  const { data, error } = await supabase
    .from('sch_users')
    .select('*')

  if (error) {
    logger.error('[db/users] getAllUsersForCron error', { error: error.message })
    throw new Error(`Failed to fetch all users: ${error.message}`)
  }

  logger.debug('[db/users] getAllUsersForCron result', { count: data.length })
  return data
}
