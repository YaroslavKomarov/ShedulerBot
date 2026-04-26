import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock the supabase client
const mockSingle = vi.fn()

const mockChain = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  ilike: vi.fn(),
  or: vi.fn(),
  order: vi.fn(),
  single: mockSingle,
}

// Make each method return the chain itself
for (const key of Object.keys(mockChain)) {
  if (key !== 'single') {
    vi.mocked(mockChain[key as keyof typeof mockChain]).mockReturnValue(mockChain)
  }
}

vi.mock('../client.js', () => ({
  supabase: {
    from: vi.fn(() => mockChain),
  },
}))

import { createTask, updateTask, getTaskQueue, getBacklog, getTasksByDate, findTasksByTitle } from '../tasks.js'
import { supabase } from '../client.js'
import { logger } from '../../lib/logger.js'

const mockFrom = vi.mocked(supabase.from)
const mockLogger = vi.mocked(logger)

const MOCK_TASK = {
  id: 'task-1',
  user_id: 'user-1',
  title: 'Test task',
  description: null,
  is_urgent: false,
  deadline_date: null,
  estimated_minutes: null,
  period_slug: null,
  scheduled_date: null,
  status: 'pending' as const,
  source: 'user' as const,
  external_id: null,
  progress_note: null,
  created_at: '2026-04-06T10:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset chain — each method returns itself, single returns undefined by default
  for (const key of Object.keys(mockChain)) {
    if (key !== 'single') {
      vi.mocked(mockChain[key as keyof typeof mockChain]).mockReturnValue(mockChain)
    }
  }
  mockFrom.mockReturnValue(mockChain as ReturnType<typeof supabase.from>)
})

describe('createTask', () => {
  it('returns created task on success', async () => {
    mockSingle.mockResolvedValueOnce({ data: MOCK_TASK, error: null })

    const result = await createTask({
      user_id: 'user-1',
      title: 'Test task',
    })

    expect(result).toEqual(MOCK_TASK)
    expect(mockFrom).toHaveBeenCalledWith('sch_tasks')
  })

  it('throws and logs error on failure', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })

    await expect(createTask({ user_id: 'user-1', title: 'Test' })).rejects.toThrow('Failed to create task')
    expect(mockLogger.error).toHaveBeenCalled()
  })
})

describe('updateTask', () => {
  it('returns updated task on success', async () => {
    mockSingle.mockResolvedValueOnce({ data: { ...MOCK_TASK, title: 'Updated' }, error: null })

    const result = await updateTask('task-1', { title: 'Updated' })

    expect(result.title).toBe('Updated')
    expect(mockFrom).toHaveBeenCalledWith('sch_tasks')
  })

  it('throws and logs error on failure', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'Not found' } })

    await expect(updateTask('task-1', { title: 'X' })).rejects.toThrow('Failed to update task')
    expect(mockLogger.error).toHaveBeenCalled()
  })
})

describe('getTaskQueue', () => {
  it('queries with status, date filter, and priority sort', async () => {
    const mockData = [MOCK_TASK]
    // Sorting is now done in TS after fetching; query ends with .or(), not .order()
    vi.mocked(mockChain.or).mockReturnValueOnce(
      { data: mockData, error: null } as unknown as typeof mockChain,
    )

    await getTaskQueue('user-1', null, '2026-04-06')

    expect(mockFrom).toHaveBeenCalledWith('sch_tasks')
    expect(mockChain.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(mockChain.eq).toHaveBeenCalledWith('status', 'pending')
  })

  it('applies period_slug filter when provided', async () => {
    // With period_slug: chain ends with .eq('period_slug', ...) after .or()
    vi.mocked(mockChain.or).mockReturnValueOnce(mockChain)
    vi.mocked(mockChain.eq)
      .mockReturnValueOnce(mockChain) // eq(user_id)
      .mockReturnValueOnce(mockChain) // eq(status)
      .mockReturnValueOnce({ data: [], error: null } as unknown as typeof mockChain) // eq(period_slug)

    await getTaskQueue('user-1', 'morning', '2026-04-06')

    expect(mockChain.eq).toHaveBeenCalledWith('period_slug', 'morning')
  })
})

describe('getBacklog', () => {
  it('filters by scheduled_date IS NULL and pending status', async () => {
    let orderCallCount = 0
    vi.mocked(mockChain.order).mockImplementation(() => {
      orderCallCount++
      if (orderCallCount >= 3) {
        return { data: [], error: null } as unknown as typeof mockChain
      }
      return mockChain
    })

    await getBacklog('user-1')

    expect(mockChain.is).toHaveBeenCalledWith('scheduled_date', null)
    expect(mockChain.eq).toHaveBeenCalledWith('status', 'pending')
  })

  it('applies period_slug filter when provided', async () => {
    let orderCallCount = 0
    vi.mocked(mockChain.order).mockImplementation(() => {
      orderCallCount++
      if (orderCallCount >= 3) {
        return { data: [], error: null } as unknown as typeof mockChain
      }
      return mockChain
    })

    await getBacklog('user-1', 'work')

    expect(mockChain.eq).toHaveBeenCalledWith('period_slug', 'work')
  })
})

describe('getTasksByDate', () => {
  it('filters by exact scheduled_date', async () => {
    let orderCallCount = 0
    vi.mocked(mockChain.order).mockImplementation(() => {
      orderCallCount++
      if (orderCallCount >= 2) {
        return { data: [], error: null } as unknown as typeof mockChain
      }
      return mockChain
    })

    await getTasksByDate('user-1', '2026-04-06')

    expect(mockChain.eq).toHaveBeenCalledWith('scheduled_date', '2026-04-06')
  })
})

describe('findTasksByTitle', () => {
  it('uses ilike with %query% pattern', async () => {
    let orderCallCount = 0
    vi.mocked(mockChain.order).mockImplementation(() => {
      orderCallCount++
      if (orderCallCount >= 1) {
        return { data: [], error: null } as unknown as typeof mockChain
      }
      return mockChain
    })

    await findTasksByTitle('user-1', 'отчёт')

    expect(mockChain.ilike).toHaveBeenCalledWith('title', '%отчёт%')
  })
})
