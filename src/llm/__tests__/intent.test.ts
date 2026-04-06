import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../client.js', () => ({
  callLLM: vi.fn(),
  FAST_MODEL: 'mock-fast',
  STRONG_MODEL: 'mock-strong',
}))

import { detectIntent, parseIntentXml, type Intent } from '../intent.js'
import { callLLM } from '../client.js'

const mockCallLLM = vi.mocked(callLLM)

describe('parseIntentXml', () => {
  it('returns null when no <intent> tag is present', () => {
    expect(parseIntentXml('some text')).toBeNull()
  })

  it('returns null when JSON inside <intent> is malformed', () => {
    expect(parseIntentXml('<intent>{ bad json }</intent>')).toBeNull()
  })

  it('parses valid intent XML', () => {
    const result = parseIntentXml('<intent>{"intent":"add_task","confidence":"high"}</intent>')
    expect(result).not.toBeNull()
    expect(result!.intent).toBe('add_task')
    expect(result!.confidence).toBe('high')
  })
})

describe('detectIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const intents: Intent[] = [
    'add_task',
    'modify_task',
    'show_plan',
    'show_backlog',
    'mark_done',
    'update_progress',
    'other',
  ]

  for (const intent of intents) {
    it(`detects intent "${intent}"`, async () => {
      mockCallLLM.mockResolvedValueOnce(
        `<intent>${JSON.stringify({ intent, confidence: 'high' })}</intent>`,
      )

      const result = await detectIntent('some user message')

      expect(result.intent).toBe(intent)
      expect(result.confidence).toBe('high')
    })
  }

  it('returns fallback { intent: "other", confidence: "low" } when callLLM throws', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('LLM unavailable'))

    const result = await detectIntent('any message')

    expect(result.intent).toBe('other')
    expect(result.confidence).toBe('low')
  })

  it('returns fallback when response has no <intent> tag', async () => {
    mockCallLLM.mockResolvedValueOnce('I cannot classify this.')

    const result = await detectIntent('any message')

    expect(result.intent).toBe('other')
    expect(result.confidence).toBe('low')
  })
})
