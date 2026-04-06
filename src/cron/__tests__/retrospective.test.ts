import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../db/tasks.js', () => ({
  getTasksByDate: vi.fn(),
  getBacklog: vi.fn(),
}))

vi.mock('../../llm/retrospective.js', () => ({
  generateRetrospectiveMessage: vi.fn(),
}))

vi.mock('../reschedule-queue.js', () => ({
  enqueueReschedule: vi.fn(),
  dequeueNextTask: vi.fn(),
  clearQueue: vi.fn(),
  hasQueue: vi.fn(),
}))

// Mock bot before importing retrospective so circular deps don't cause issues
vi.mock('../../bot/index.js', () => ({
  bot: {
    api: {
      sendMessage: vi.fn(),
    },
  },
}))

vi.mock('../morning-plan.js', () => ({
  getTodayInTimezone: vi.fn(() => ({ date: '2024-06-10', dayOfWeek: 1 })),
}))

import { runRetrospective, sendNextRescheduleTask } from '../retrospective.js'
import { getTasksByDate, getBacklog } from '../../db/tasks.js'
import { generateRetrospectiveMessage } from '../../llm/retrospective.js'
import { enqueueReschedule, dequeueNextTask } from '../reschedule-queue.js'
import { bot } from '../../bot/index.js'
import type { DbUser, DbTask } from '../../types/index.js'
import { logger } from '../../lib/logger.js'

const mockGetTasksByDate = vi.mocked(getTasksByDate)
const mockGetBacklog = vi.mocked(getBacklog)
const mockGenerateRetrospectiveMessage = vi.mocked(generateRetrospectiveMessage)
const mockEnqueueReschedule = vi.mocked(enqueueReschedule)
const mockDequeueNextTask = vi.mocked(dequeueNextTask)
const mockSendMessage = vi.mocked(bot.api.sendMessage)

const mockUser: DbUser = {
  id: 'user-1',
  telegram_id: 12345,
  timezone: 'Europe/Moscow',
  morning_time: '09:00',
  end_of_day_time: '21:00',
  google_access_token: null,
  google_refresh_token: null,
  google_token_expiry: null,
  created_at: '2024-01-01T00:00:00.000Z',
}

const makeTask = (overrides: Partial<DbTask> = {}): DbTask => ({
  id: 'task-1',
  user_id: 'user-1',
  title: 'Тестовая задача',
  description: null,
  is_urgent: false,
  deadline_date: null,
  estimated_minutes: null,
  status: 'pending',
  scheduled_date: '2024-06-10',
  period_slug: 'utro',
  source: 'user',
  external_id: null,
  progress_note: null,
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

describe('runRetrospective', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendMessage.mockResolvedValue({} as never)
    mockGenerateRetrospectiveMessage.mockResolvedValue('📊 Итоги дня 2024-06-10')
  })

  it('sends retro message and does not enqueue when no tasks and no backlog', async () => {
    mockGetTasksByDate.mockResolvedValueOnce([])
    mockGetBacklog.mockResolvedValueOnce([])

    await runRetrospective(mockUser)

    expect(mockGenerateRetrospectiveMessage).toHaveBeenCalledWith(mockUser, '2024-06-10', [], [], [])
    expect(mockSendMessage).toHaveBeenCalledOnce()
    expect(mockEnqueueReschedule).not.toHaveBeenCalled()
  })

  it('calls generateRetrospectiveMessage with correct args and enqueues missed tasks', async () => {
    const doneTask = makeTask({ id: 't1', status: 'done' })
    const missedTask = makeTask({ id: 't2', status: 'pending' })

    mockGetTasksByDate.mockResolvedValueOnce([doneTask, missedTask])
    mockGetBacklog.mockResolvedValueOnce([])
    mockDequeueNextTask.mockReturnValueOnce(null)

    await runRetrospective(mockUser)

    expect(mockGenerateRetrospectiveMessage).toHaveBeenCalledWith(
      mockUser,
      '2024-06-10',
      [doneTask],
      [missedTask],
      [],
    )
    expect(mockEnqueueReschedule).toHaveBeenCalledWith(mockUser.id, [missedTask])
    // sendNextRescheduleTask triggers sendMessage for "✅ Все задачи разобраны!" when queue is empty
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('sends backlog reminder when no missed tasks but backlogNoDate has items', async () => {
    mockGetTasksByDate.mockResolvedValueOnce([])
    const backlogTask = makeTask({ id: 'b1', scheduled_date: null, is_urgent: false, deadline_date: null })
    mockGetBacklog.mockResolvedValueOnce([backlogTask])

    await runRetrospective(mockUser)

    expect(mockEnqueueReschedule).not.toHaveBeenCalled()
    // Two sendMessage calls: retro message + backlog reminder
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
    const secondCall = mockSendMessage.mock.calls[1][1] as string
    expect(secondCall).toContain('бэклог')
    expect(secondCall).toContain('/backlog')
  })

  it('logs error and does not throw when getTasksByDate fails (cron-safe)', async () => {
    mockGetTasksByDate.mockRejectedValueOnce(new Error('DB down'))

    await expect(runRetrospective(mockUser)).resolves.toBeUndefined()
    expect(vi.mocked(logger.error)).toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })
})

describe('sendNextRescheduleTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendMessage.mockResolvedValue({} as never)
  })

  it('sends "all done" message when queue is empty', async () => {
    mockDequeueNextTask.mockReturnValueOnce(null)

    await sendNextRescheduleTask(12345, 'user-1')

    expect(mockSendMessage).toHaveBeenCalledOnce()
    const text = mockSendMessage.mock.calls[0][1] as string
    expect(text).toContain('✅ Все задачи разобраны!')
  })

  it('sends inline keyboard with retro action buttons when queue has a task', async () => {
    const task = makeTask({ id: 'task-42', title: 'Написать отчёт' })
    mockDequeueNextTask.mockReturnValueOnce(task)

    await sendNextRescheduleTask(12345, 'user-1')

    expect(mockSendMessage).toHaveBeenCalledOnce()
    const [, text, options] = mockSendMessage.mock.calls[0] as [number, string, Record<string, unknown>]
    expect(text).toContain('Написать отчёт')

    // Check inline keyboard buttons contain correct callback data
    const keyboard = options?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
    const callbackData = keyboard.inline_keyboard.flat().map((btn) => btn.callback_data)
    expect(callbackData).toContain('retro:tomorrow:task-42')
    expect(callbackData).toContain('retro:backlog:task-42')
    expect(callbackData).toContain('retro:done:task-42')
    expect(callbackData).toContain('retro:cancel:task-42')
  })
})
