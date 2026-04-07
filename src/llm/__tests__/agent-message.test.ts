import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../client.js', () => ({
  llmClient: {
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  },
  STRONG_MODEL: 'mock-strong',
  LLMInsufficientCreditsError: class LLMInsufficientCreditsError extends Error {
    constructor() {
      super('OpenRouter balance is insufficient')
      this.name = 'LLMInsufficientCreditsError'
    }
  },
}))

vi.mock('../../db/periods.js', () => ({
  getUserPeriods: vi.fn().mockResolvedValue([]),
  getPeriodsForDay: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../db/tasks.js', () => ({
  getTasksByDate: vi.fn().mockResolvedValue([]),
  getBacklog: vi.fn().mockResolvedValue([]),
  getTaskQueue: vi.fn().mockResolvedValue([]),
  createTask: vi.fn(),
  findTasksByTitle: vi.fn(),
  updateTask: vi.fn(),
}))

import { handleAgentMessage } from '../agent-query.js'
import { llmClient } from '../client.js'
import { createTask, findTasksByTitle, updateTask, getTasksByDate } from '../../db/tasks.js'
import type { DbUser } from '../../types/index.js'

const mockCreate = vi.mocked(llmClient.chat.completions.create)
const mockCreateTask = vi.mocked(createTask)
const mockFindTasksByTitle = vi.mocked(findTasksByTitle)
const mockUpdateTask = vi.mocked(updateTask)
const mockGetTasksByDate = vi.mocked(getTasksByDate)

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

function makeLLMResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: undefined } }],
    usage: { total_tokens: 100 },
  }
}

function makeLLMToolCallResponse(toolName: string, args: Record<string, unknown>) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: { total_tokens: 50 },
  }
}

describe('handleAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scenario 1: single-turn task creation calls add_task with correct args', async () => {
    mockCreateTask.mockResolvedValueOnce({
      id: 'task-new',
      user_id: 'user-1',
      title: 'написать тесты',
      description: null,
      is_urgent: false,
      deadline_date: null,
      estimated_minutes: null,
      status: 'pending',
      scheduled_date: '2026-04-08',
      period_slug: null,
      source: 'user',
      external_id: null,
      progress_note: null,
      created_at: '2026-04-07T00:00:00.000Z',
    })

    mockCreate
      .mockResolvedValueOnce(makeLLMToolCallResponse('add_task', {
        title: 'написать тесты',
        scheduled_date: '2026-04-08',
      }) as never)
      .mockResolvedValueOnce(makeLLMResponse('Задача "написать тесты" создана на завтра.') as never)

    const reply = await handleAgentMessage(mockUser, 'добавь задачу написать тесты на завтра', [])

    expect(mockCreateTask).toHaveBeenCalledOnce()
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'написать тесты', scheduled_date: '2026-04-08', user_id: 'user-1' }),
    )
    expect(reply).toContain('написать тесты')
  })

  it('scenario 2: multi-turn task creation uses conversation history', async () => {
    mockCreateTask.mockResolvedValueOnce({
      id: 'task-2',
      user_id: 'user-1',
      title: 'написать тесты',
      description: null,
      is_urgent: false,
      deadline_date: null,
      estimated_minutes: null,
      status: 'pending',
      scheduled_date: null,
      period_slug: null,
      source: 'user',
      external_id: null,
      progress_note: null,
      created_at: '2026-04-07T00:00:00.000Z',
    })

    mockCreate
      .mockResolvedValueOnce(makeLLMToolCallResponse('add_task', { title: 'написать тесты' }) as never)
      .mockResolvedValueOnce(makeLLMResponse('Задача "написать тесты" создана.') as never)

    const history = [
      { role: 'user' as const, content: 'добавь задачу' },
      { role: 'assistant' as const, content: 'Как называется задача?' },
    ]

    const reply = await handleAgentMessage(mockUser, 'написать тесты', history)

    // Verify history was passed to the LLM (first create call should include history messages)
    const firstCallMessages = mockCreate.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    const roles = firstCallMessages.map((m) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')

    expect(mockCreateTask).toHaveBeenCalledOnce()
    expect(reply).toBeTruthy()
  })

  it('scenario 3: cancellation follow-up calls cancel_task with correct title_query', async () => {
    mockFindTasksByTitle.mockResolvedValueOnce([
      {
        id: 'task-3',
        user_id: 'user-1',
        title: 'тесты к авторизации',
        description: null,
        is_urgent: false,
        deadline_date: null,
        estimated_minutes: null,
        status: 'pending',
        scheduled_date: null,
        period_slug: null,
        source: 'user',
        external_id: null,
        progress_note: null,
        created_at: '2026-04-07T00:00:00.000Z',
      },
    ])
    mockUpdateTask.mockResolvedValueOnce({
      id: 'task-3',
      user_id: 'user-1',
      title: 'тесты к авторизации',
      description: null,
      is_urgent: false,
      deadline_date: null,
      estimated_minutes: null,
      status: 'cancelled',
      scheduled_date: null,
      period_slug: null,
      source: 'user',
      external_id: null,
      progress_note: null,
      created_at: '2026-04-07T00:00:00.000Z',
    })

    mockCreate
      .mockResolvedValueOnce(makeLLMToolCallResponse('cancel_task', { title_query: 'тесты к авторизации' }) as never)
      .mockResolvedValueOnce(makeLLMResponse('Задача "тесты к авторизации" отменена.') as never)

    const history = [
      { role: 'user' as const, content: 'удали задачу' },
      { role: 'assistant' as const, content: 'Какую именно?' },
    ]

    const reply = await handleAgentMessage(mockUser, 'тесты к авторизации', history)

    expect(mockFindTasksByTitle).toHaveBeenCalledWith('user-1', 'тесты к авторизации')
    expect(mockUpdateTask).toHaveBeenCalledWith('task-3', { status: 'cancelled' })
    expect(reply).toBeTruthy()
  })

  it('scenario 4: query calls get_tasks_by_date and returns formatted answer', async () => {
    const today = new Date().toISOString().split('T')[0]
    mockGetTasksByDate.mockResolvedValueOnce([
      {
        id: 'task-4',
        user_id: 'user-1',
        title: 'Позвонить клиенту',
        description: null,
        is_urgent: false,
        deadline_date: null,
        estimated_minutes: 15,
        status: 'pending',
        scheduled_date: today,
        period_slug: null,
        source: 'user',
        external_id: null,
        progress_note: null,
        created_at: '2026-04-07T00:00:00.000Z',
      },
    ])

    mockCreate
      .mockResolvedValueOnce(makeLLMToolCallResponse('get_tasks_by_date', { date: today }) as never)
      .mockResolvedValueOnce(makeLLMResponse('На сегодня: Позвонить клиенту.') as never)

    const reply = await handleAgentMessage(mockUser, 'какие задачи на сегодня?', [])

    expect(mockGetTasksByDate).toHaveBeenCalledWith('user-1', today)
    expect(reply).toContain('Позвонить клиенту')
  })
})
