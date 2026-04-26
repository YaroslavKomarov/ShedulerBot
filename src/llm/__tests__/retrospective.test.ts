import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../client.js', () => ({
  callLLM: vi.fn(),
  FAST_MODEL: 'mock-fast',
  STRONG_MODEL: 'mock-strong',
}))

import { generateRetrospectiveMessage } from '../retrospective.js'
import { callLLM } from '../client.js'
import type { DbUser, DbTask } from '../../types/index.js'

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

const makeTask = (overrides: Partial<DbTask> = {}): DbTask => ({
  id: 'task-1',
  user_id: 'user-1',
  title: 'Тестовая задача',
  description: null,
  is_urgent: false,
  is_overflow: false,
  deadline_date: null,
  estimated_minutes: null,
  status: 'done',
  scheduled_date: '2024-06-10',
  period_slug: 'utro',
  source: 'user',
  external_id: null,
  progress_note: null,
  created_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

describe('generateRetrospectiveMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns content of <retro> tag when LLM responds with it', async () => {
    const expectedText = '🌟 Отличный день!\nВыполнено 2 задачи. Так держать!'
    mockCallLLM.mockResolvedValueOnce(`Some preamble\n<retro>${expectedText}</retro>\nSome epilogue`)

    const result = await generateRetrospectiveMessage(
      mockUser,
      '2024-06-10',
      [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2' })],
      [],
      [],
    )

    expect(mockCallLLM).toHaveBeenCalledOnce()
    expect(mockCallLLM).toHaveBeenCalledWith(expect.objectContaining({ model: 'mock-strong' }))
    expect(result).toBe(expectedText)
  })

  it('returns fallback string containing counts when LLM response has no <retro> tag', async () => {
    mockCallLLM.mockResolvedValueOnce('Вот итоги без тега ретро.')

    const done = [makeTask({ id: 't1' }), makeTask({ id: 't2' })]
    const missed = [makeTask({ id: 't3', status: 'pending' })]
    const backlog = [makeTask({ id: 't4', scheduled_date: null })]

    const result = await generateRetrospectiveMessage(mockUser, '2024-06-10', done, missed, backlog)

    expect(result).toContain('2')   // done count
    expect(result).toContain('1')   // missed count
    expect(result).toContain('1')   // backlog count
    expect(result).toContain('2024-06-10')
  })

  it('returns fallback and does not throw when callLLM throws', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('LLM unavailable'))

    const done = [makeTask()]
    const missed = [makeTask({ id: 't2', status: 'pending' })]

    const result = await generateRetrospectiveMessage(mockUser, '2024-06-10', done, missed, [])

    expect(result).toBeTruthy()
    expect(result).toContain('2024-06-10')
    // Should contain numbers from fallback
    expect(result).toContain('1')
  })
})
