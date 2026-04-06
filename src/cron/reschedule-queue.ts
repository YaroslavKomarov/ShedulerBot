import { logger } from '../lib/logger.js'
import type { DbTask } from '../types/index.js'

const queues = new Map<string, DbTask[]>()

export function enqueueReschedule(userId: string, tasks: DbTask[]): void {
  logger.debug('[cron/reschedule-queue] enqueue', { userId, count: tasks.length })
  queues.set(userId, [...tasks])
}

export function dequeueNextTask(userId: string): DbTask | null {
  const queue = queues.get(userId)
  if (!queue || queue.length === 0) return null

  const task = queue.shift()!
  if (queue.length === 0) {
    queues.delete(userId)
  }

  logger.debug('[cron/reschedule-queue] dequeue', {
    userId,
    taskId: task.id,
    remaining: queues.get(userId)?.length ?? 0,
  })
  return task
}

export function clearQueue(userId: string): void {
  logger.debug('[cron/reschedule-queue] clear', { userId })
  queues.delete(userId)
}

export function hasQueue(userId: string): boolean {
  const queue = queues.get(userId)
  return queue !== undefined && queue.length > 0
}
