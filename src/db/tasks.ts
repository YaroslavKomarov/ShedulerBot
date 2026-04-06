import { supabase } from './client.js'
import type { DbTask, DbTaskInsert, DbTaskUpdate } from '../types/index.js'
import { logger } from '../lib/logger.js'

export async function createTask(data: DbTaskInsert): Promise<DbTask> {
  logger.debug('[db/tasks] createTask', { userId: data.user_id, title: data.title })

  const { data: created, error } = await supabase
    .from('sch_tasks')
    .insert(data)
    .select()
    .single()

  if (error) {
    logger.error('[db/tasks] createTask error', { userId: data.user_id, error: error.message })
    throw new Error(`Failed to create task: ${error.message}`)
  }

  logger.info('[db/tasks] createTask done', { id: created.id, title: created.title })
  return created
}

export async function updateTask(id: string, data: DbTaskUpdate): Promise<DbTask> {
  logger.debug('[db/tasks] updateTask', { id, fields: Object.keys(data) })

  const { data: updated, error } = await supabase
    .from('sch_tasks')
    .update(data)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    logger.error('[db/tasks] updateTask error', { id, error: error.message })
    throw new Error(`Failed to update task id=${id}: ${error.message}`)
  }

  logger.info('[db/tasks] updateTask done', { id })
  return updated
}

export async function getTaskQueue(
  userId: string,
  periodSlug: string | null,
  date: string,
): Promise<DbTask[]> {
  logger.debug('[db/tasks] getTaskQueue', { userId, periodSlug, date })

  let query = supabase
    .from('sch_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .or(`scheduled_date.eq.${date},scheduled_date.is.null`)

  if (periodSlug !== null) {
    query = query.eq('period_slug', periodSlug)
  }

  const { data, error } = await query
    .order('is_urgent', { ascending: false })
    .order('deadline_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) {
    logger.error('[db/tasks] getTaskQueue error', { userId, periodSlug, date, error: error.message })
    throw new Error(`Failed to get task queue for user ${userId}: ${error.message}`)
  }

  logger.debug('[db/tasks] getTaskQueue result', { userId, count: data.length })
  return data
}

export async function getBacklog(userId: string, periodSlug?: string): Promise<DbTask[]> {
  logger.debug('[db/tasks] getBacklog', { userId, periodSlug })

  let query = supabase
    .from('sch_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .is('scheduled_date', null)

  if (periodSlug !== undefined) {
    query = query.eq('period_slug', periodSlug)
  }

  const { data, error } = await query
    .order('is_urgent', { ascending: false })
    .order('deadline_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })

  if (error) {
    logger.error('[db/tasks] getBacklog error', { userId, periodSlug, error: error.message })
    throw new Error(`Failed to get backlog for user ${userId}: ${error.message}`)
  }

  logger.debug('[db/tasks] getBacklog result', { userId, count: data.length })
  return data
}

export async function getTasksByDate(userId: string, date: string): Promise<DbTask[]> {
  logger.debug('[db/tasks] getTasksByDate', { userId, date })

  const { data, error } = await supabase
    .from('sch_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('scheduled_date', date)
    .order('is_urgent', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) {
    logger.error('[db/tasks] getTasksByDate error', { userId, date, error: error.message })
    throw new Error(`Failed to get tasks by date for user ${userId}: ${error.message}`)
  }

  logger.debug('[db/tasks] getTasksByDate result', { userId, date, count: data.length })
  return data
}

export async function findTaskByExternalId(
  userId: string,
  externalId: string,
): Promise<DbTask | null> {
  logger.debug('[db/tasks] findTaskByExternalId', { userId, externalId })

  const { data, error } = await supabase
    .from('sch_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('external_id', externalId)
    .maybeSingle()

  if (error) {
    logger.error('[db/tasks] findTaskByExternalId error', { userId, externalId, error: error.message })
    throw new Error(`Failed to find task by external_id: ${error.message}`)
  }

  logger.debug('[db/tasks] findTaskByExternalId result', { userId, externalId, found: data !== null })
  return data
}

export async function findTasksByTitle(userId: string, query: string): Promise<DbTask[]> {
  logger.debug('[db/tasks] findTasksByTitle', { userId, query })

  const { data, error } = await supabase
    .from('sch_tasks')
    .select('*')
    .eq('user_id', userId)
    .ilike('title', `%${query}%`)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('[db/tasks] findTasksByTitle error', { userId, query, error: error.message })
    throw new Error(`Failed to find tasks by title for user ${userId}: ${error.message}`)
  }

  logger.debug('[db/tasks] findTasksByTitle result', { userId, count: data.length })
  return data
}
