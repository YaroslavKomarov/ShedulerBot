import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock logger before importing the module
vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock callLLM
vi.mock('../client.js', () => ({
  callLLM: vi.fn(),
  FAST_MODEL: 'mock-fast',
  STRONG_MODEL: 'mock-strong',
}))

import { parseTaskMessage, parseTaskXml } from '../parse-task.js'
import { callLLM } from '../client.js'

const mockCallLLM = vi.mocked(callLLM)

const BASE_CONTEXT = {
  timezone: 'Europe/Moscow',
  today: '2026-04-06',
  periods: [
    { name: 'Утро', slug: 'morning' },
    { name: 'Работа', slug: 'work' },
  ],
}

describe('parseTaskXml', () => {
  it('returns null when no <task> tag is present', () => {
    expect(parseTaskXml('some text without tags')).toBeNull()
  })

  it('returns null when JSON inside <task> is malformed', () => {
    expect(parseTaskXml('<task>{ invalid json }</task>')).toBeNull()
  })

  it('parses valid task XML', () => {
    const xml = `<task>{"title":"Test","description":null,"is_urgent":false,"deadline_date":null,"estimated_minutes":30,"period_slug":null,"scheduled_date":null,"needs_clarification":false,"clarification_question":null}</task>`
    const result = parseTaskXml(xml)
    expect(result).not.toBeNull()
    expect(result!.title).toBe('Test')
    expect(result!.estimated_minutes).toBe(30)
  })
})

describe('parseTaskMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses a valid task with all fields', async () => {
    const taskJson = JSON.stringify({
      title: 'Написать отчёт',
      description: 'Ежемесячный финансовый отчёт',
      is_urgent: false,
      deadline_date: '2026-04-10',
      estimated_minutes: 60,
      period_slug: 'work',
      scheduled_date: '2026-04-06',
      needs_clarification: false,
      clarification_question: null,
    })
    mockCallLLM.mockResolvedValueOnce(`<task>${taskJson}</task>`)

    const result = await parseTaskMessage('Написать отчёт до 10 апреля на работе', BASE_CONTEXT)

    expect(result.title).toBe('Написать отчёт')
    expect(result.deadline_date).toBe('2026-04-10')
    expect(result.period_slug).toBe('work')
    expect(result.needs_clarification).toBe(false)
  })

  it('parses urgent task with deadline', async () => {
    const taskJson = JSON.stringify({
      title: 'Срочно позвонить клиенту',
      description: null,
      is_urgent: true,
      deadline_date: '2026-04-06',
      estimated_minutes: 15,
      period_slug: null,
      scheduled_date: '2026-04-06',
      needs_clarification: false,
      clarification_question: null,
    })
    mockCallLLM.mockResolvedValueOnce(`<task>${taskJson}</task>`)

    const result = await parseTaskMessage('Срочно позвонить клиенту сегодня', BASE_CONTEXT)

    expect(result.is_urgent).toBe(true)
    expect(result.deadline_date).toBe('2026-04-06')
  })

  it('returns needs_clarification for vague input', async () => {
    const taskJson = JSON.stringify({
      title: '',
      description: null,
      is_urgent: false,
      deadline_date: null,
      estimated_minutes: null,
      period_slug: null,
      scheduled_date: null,
      needs_clarification: true,
      clarification_question: 'Что именно нужно сделать?',
    })
    mockCallLLM.mockResolvedValueOnce(`<task>${taskJson}</task>`)

    const result = await parseTaskMessage('привет', BASE_CONTEXT)

    expect(result.needs_clarification).toBe(true)
    expect(result.clarification_question).toBeTruthy()
  })

  it('resolves "сегодня" to today\'s date', async () => {
    const taskJson = JSON.stringify({
      title: 'Купить продукты',
      description: null,
      is_urgent: false,
      deadline_date: null,
      estimated_minutes: null,
      period_slug: null,
      scheduled_date: BASE_CONTEXT.today,
      needs_clarification: false,
      clarification_question: null,
    })
    mockCallLLM.mockResolvedValueOnce(`<task>${taskJson}</task>`)

    const result = await parseTaskMessage('Купить продукты сегодня', BASE_CONTEXT)

    expect(result.scheduled_date).toBe(BASE_CONTEXT.today)
  })

  it('returns fallback with needs_clarification when LLM throws', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('Network error'))

    const result = await parseTaskMessage('какая-то задача', BASE_CONTEXT)

    expect(result.needs_clarification).toBe(true)
    expect(result.clarification_question).toBeTruthy()
  })

  it('returns fallback when response has no <task> tag', async () => {
    mockCallLLM.mockResolvedValueOnce('Sorry, I cannot process this.')

    const result = await parseTaskMessage('какая-то задача', BASE_CONTEXT)

    expect(result.needs_clarification).toBe(true)
  })
})
