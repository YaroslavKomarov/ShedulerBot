import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../client.js', () => ({
  callLLM: vi.fn(),
  FAST_MODEL: 'mock-fast',
  STRONG_MODEL: 'mock-strong',
}))

import { generateDayPlanMessage } from '../plan.js'
import { callLLM } from '../client.js'
import type { DbUser, DbPeriod, DbTask } from '../../types/index.js'
import type { PeriodPlan } from '../plan.js'

const mockCallLLM = vi.mocked(callLLM)

const mockUser: DbUser = {
  id: 'user-1',
  telegram_id: 12345,
  timezone: 'Europe/Moscow',
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
  title: 'Написать отчёт',
  description: null,
  is_urgent: false,
  is_overflow: false,
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

describe('generateDayPlanMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns fallback without calling callLLM when periodPlans is empty', async () => {
    const result = await generateDayPlanMessage(mockUser, '2024-06-10', [])

    expect(mockCallLLM).not.toHaveBeenCalled()
    expect(result).toContain('2024-06-10')
  })

  it('calls callLLM with STRONG_MODEL when periods and tasks are provided', async () => {
    const llmResponse = '📅 *План на 2024-06-10*\n\n*Утро*\n• Написать отчёт'
    mockCallLLM.mockResolvedValueOnce(llmResponse)

    const periodPlans: PeriodPlan[] = [
      { period: mockPeriod, tasks: [mockTask], slots: [] },
    ]

    const result = await generateDayPlanMessage(mockUser, '2024-06-10', periodPlans)

    expect(mockCallLLM).toHaveBeenCalledOnce()
    expect(mockCallLLM).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mock-strong' }),
    )
    expect(result).toBe(llmResponse)
  })

  it('returns fallback string when callLLM throws (no crash)', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('LLM unavailable'))

    const periodPlans: PeriodPlan[] = [
      { period: mockPeriod, tasks: [mockTask], slots: [] },
    ]

    const result = await generateDayPlanMessage(mockUser, '2024-06-10', periodPlans)

    expect(result).toBeTruthy()
    // Should contain period name in fallback
    expect(result).toContain('Утро')
  })

  it('fallback text contains period name and task title', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('LLM down'))

    const periodPlans: PeriodPlan[] = [
      { period: mockPeriod, tasks: [mockTask], slots: [] },
    ]

    const result = await generateDayPlanMessage(mockUser, '2024-06-10', periodPlans)

    expect(result).toContain('Утро')
    expect(result).toContain('Написать отчёт')
  })

  it('includes urgent marker for urgent tasks in LLM prompt', async () => {
    const urgentTask = { ...mockTask, is_urgent: true }
    mockCallLLM.mockResolvedValueOnce('plan text')

    const periodPlans: PeriodPlan[] = [
      { period: mockPeriod, tasks: [urgentTask], slots: [] },
    ]

    await generateDayPlanMessage(mockUser, '2024-06-10', periodPlans)

    const callArgs = mockCallLLM.mock.calls[0][0]
    const userMessage = callArgs.messages.find((m) => m.role === 'user')
    expect(userMessage?.content).toContain('СРОЧНО')
  })
})
