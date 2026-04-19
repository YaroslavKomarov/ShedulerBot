import { supabase } from './client.js'
import type { DbPeriod, DbPeriodInsert } from '../types/index.js'
import { logger } from '../lib/logger.js'

export async function updatePeriod(id: string, data: Partial<DbPeriodInsert>): Promise<DbPeriod> {
  logger.debug('[db/periods] updatePeriod', { id, data })

  const { data: updated, error } = await supabase
    .from('sch_periods')
    .update(data)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    logger.error('[db/periods] updatePeriod error', { id, error: error.message })
    throw new Error(`Failed to update period ${id}: ${error.message}`)
  }

  logger.info('[db/periods] updatePeriod done', { id })
  return updated
}

export async function deletePeriod(id: string): Promise<void> {
  logger.debug('[db/periods] deletePeriod', { id })

  const { error } = await supabase
    .from('sch_periods')
    .delete()
    .eq('id', id)

  if (error) {
    logger.error('[db/periods] deletePeriod error', { id, error: error.message })
    throw new Error(`Failed to delete period ${id}: ${error.message}`)
  }

  logger.info('[db/periods] deletePeriod done', { id })
}

export async function deleteUserPeriods(userId: string): Promise<void> {
  logger.debug('[db/periods] deleteUserPeriods', { userId })

  const { error } = await supabase
    .from('sch_periods')
    .delete()
    .eq('user_id', userId)

  if (error) {
    logger.error('[db/periods] deleteUserPeriods error', { userId, error: error.message })
    throw new Error(`Failed to delete periods for user ${userId}: ${error.message}`)
  }

  logger.info('[db/periods] deleteUserPeriods done', { userId })
}

export async function createPeriods(periods: DbPeriodInsert[]): Promise<DbPeriod[]> {
  logger.debug('[db/periods] createPeriods', { userId: periods[0]?.user_id, count: periods.length })

  const { data, error } = await supabase
    .from('sch_periods')
    .insert(periods)
    .select()

  if (error) {
    logger.error('[db/periods] createPeriods error', { userId: periods[0]?.user_id, error: error.message })
    throw new Error(`Failed to create periods: ${error.message}`)
  }

  logger.info('[db/periods] createPeriods done', { userId: periods[0]?.user_id, created: data.length })
  return data
}

export async function getUserPeriods(userId: string): Promise<DbPeriod[]> {
  logger.debug('[db/periods] getUserPeriods', { userId })

  const { data, error } = await supabase
    .from('sch_periods')
    .select('*')
    .eq('user_id', userId)
    .order('order_index', { ascending: true })

  if (error) {
    logger.error('[db/periods] getUserPeriods error', { userId, error: error.message })
    throw new Error(`Failed to get periods for user ${userId}: ${error.message}`)
  }

  logger.debug('[db/periods] getUserPeriods result', { userId, count: data.length })
  return data
}

export async function getPeriodsForDay(userId: string, dayOfWeek: number): Promise<DbPeriod[]> {
  logger.debug('[db/periods] getPeriodsForDay', { userId, dayOfWeek })

  const { data, error } = await supabase
    .from('sch_periods')
    .select('*')
    .eq('user_id', userId)
    .contains('days_of_week', [dayOfWeek])
    .order('start_time', { ascending: true })

  if (error) {
    logger.error('[db/periods] getPeriodsForDay error', { userId, dayOfWeek, error: error.message })
    throw new Error(`Failed to get periods for user ${userId} day ${dayOfWeek}: ${error.message}`)
  }

  logger.debug('[db/periods] getPeriodsForDay result', { userId, dayOfWeek, count: data.length })
  return data
}
