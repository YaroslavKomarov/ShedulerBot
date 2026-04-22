import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../db/periods.js', () => ({
  getPeriodsForDay: vi.fn(),
}))

vi.mock('../../db/tasks.js', () => ({
  getTaskQueue: vi.fn(),
  getBacklog: vi.fn(),
  getUnassignedTodayTasks: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../llm/plan.js', () => ({
  generateDayPlanMessage: vi.fn(),
}))

vi.mock('../../calendar/sync.js', () => ({
  syncDayPlan: vi.fn(),
}))

vi.mock('../../bot/index.js', () => ({
  bot: {
    api: {
      sendMessage: mockSendMessage,
    },
  },
}))

import { runMorningPlan, getTodayInTimezone } from '../morning-plan.js'
import { getPeriodsForDay } from '../../db/periods.js'
import { getTaskQueue, getBacklog } from '../../db/tasks.js'
import { generateDayPlanMessage } from '../../llm/plan.js'
import { syncDayPlan } from '../../calendar/sync.js'
import type { DbUser, DbPeriod, DbTask } from '../../types/index.js'

const mockGetPeriodsForDay = vi.mocked(getPeriodsForDay)
const mockGetTaskQueue = vi.mocked(getTaskQueue)
const mockGetBacklog = vi.mocked(getBacklog)
const mockGenerateDayPlanMessage = vi.mocked(generateDayPlanMessage)
const mockSyncDayPlan = vi.mocked(syncDayPlan)

const mockUser: DbUser = {
  id: 'user-1',
  telegram_id: 12345,
  timezone: 'UTC',
  morning_time: '09:00',
  end_of_day_time: '21:00',
  google_access_token: null,
  google_refresh_token: null,
  google_token_expiry: null,
          solo_leveling_token: null,
  created_at: '2024-01-01T00:00:00.000Z',
}

const mockPeriod: DbPeriod = {
  id: 'period-1',
  user_id: 'user-1',
  name: 'Утро',
  slug: 'utro',
  queue_slug: 'utro',
  start_time: '09:00',
  end_time: '11:00',
  days_of_week: [1, 2, 3, 4, 5],
  order_index: 0,
  created_at: '2024-01-01T00:00:00.000Z',
}

const mockTask: DbTask = {
  id: 'task-1',
  user_id: 'user-1',
  title: 'Test task',
  description: null,
  is_urgent: false,
  deadline_date: null,
  estimated_minutes: 30,
  status: 'pending',
  scheduled_date: '2024-06-10',
  period_slug: 'utro',
  source: 'user',
  external_id: null,
  progress_note: null,
  created_at: '2024-01-01T00:00:00.000Z',
}

describe('getTodayInTimezone', () => {
  it('returns a valid YYYY-MM-DD date string', () => {
    const { date } = getTodayInTimezone('UTC')
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns a dayOfWeek between 1 and 7 (ISO: 1=Mon, 7=Sun)', () => {
    const { dayOfWeek } = getTodayInTimezone('UTC')
    expect(dayOfWeek).toBeGreaterThanOrEqual(1)
    expect(dayOfWeek).toBeLessThanOrEqual(7)
  })
})

describe('runMorningPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBacklog.mockResolvedValue([])
  })

  it('sends "no periods" message and returns early when no active periods', async () => {
    mockGetPeriodsForDay.mockResolvedValue([])

    await runMorningPlan(mockUser)

    expect(mockSendMessage).toHaveBeenCalledOnce()
    expect(mockSendMessage.mock.calls[0][1]).toContain('нет активных периодов')
    expect(mockGenerateDayPlanMessage).not.toHaveBeenCalled()
  })

  it('calls generateDayPlanMessage and sendMessage when periods exist', async () => {
    mockGetPeriodsForDay.mockResolvedValue([mockPeriod])
    mockGetTaskQueue.mockResolvedValue([mockTask])
    mockGenerateDayPlanMessage.mockResolvedValue('Твой план на день...')

    await runMorningPlan(mockUser)

    expect(mockGenerateDayPlanMessage).toHaveBeenCalledOnce()
    expect(mockSendMessage).toHaveBeenCalledOnce()
    expect(mockSendMessage.mock.calls[0][1]).toBe('Твой план на день...')
  })

  it('calls syncDayPlan when google_access_token is set', async () => {
    const userWithCalendar: DbUser = {
      ...mockUser,
      google_access_token: 'token-123',
      google_refresh_token: 'refresh-123',
    }

    mockGetPeriodsForDay.mockResolvedValue([mockPeriod])
    mockGetTaskQueue.mockResolvedValue([mockTask])
    mockGenerateDayPlanMessage.mockResolvedValue('План...')
    mockSyncDayPlan.mockResolvedValue(undefined)

    await runMorningPlan(userWithCalendar)

    expect(mockSyncDayPlan).toHaveBeenCalledOnce()
  })

  it('does NOT call syncDayPlan when google_access_token is null', async () => {
    mockGetPeriodsForDay.mockResolvedValue([mockPeriod])
    mockGetTaskQueue.mockResolvedValue([mockTask])
    mockGenerateDayPlanMessage.mockResolvedValue('План...')

    await runMorningPlan(mockUser)  // mockUser has google_access_token: null

    expect(mockSyncDayPlan).not.toHaveBeenCalled()
  })

  it('sends fallback message when generateDayPlanMessage throws', async () => {
    mockGetPeriodsForDay.mockResolvedValue([mockPeriod])
    mockGetTaskQueue.mockResolvedValue([mockTask])
    mockGenerateDayPlanMessage.mockRejectedValue(new Error('LLM down'))

    await runMorningPlan(mockUser)

    // Should still send a message even if LLM failed
    expect(mockSendMessage).toHaveBeenCalledOnce()
  })

  it('does not throw when getPeriodsForDay rejects', async () => {
    mockGetPeriodsForDay.mockRejectedValue(new Error('DB connection failed'))

    await expect(runMorningPlan(mockUser)).resolves.not.toThrow()
  })

  it('correctly builds time slots: 30-min task in 09:00-11:00 period fills 09:00-09:30', async () => {
    mockGetPeriodsForDay.mockResolvedValue([mockPeriod])
    mockGetTaskQueue.mockResolvedValue([{ ...mockTask, estimated_minutes: 30 }])
    mockGenerateDayPlanMessage.mockImplementation(async (_user, _date, periodPlans) => {
      const slots = periodPlans[0]?.slots
      expect(slots).toBeDefined()
      expect(slots![0]?.startTime).toBe('09:00')
      expect(slots![0]?.endTime).toBe('09:30')
      return 'Plan text'
    })

    await runMorningPlan(mockUser)
  })
})
