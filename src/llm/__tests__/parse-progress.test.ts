import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../client.js', () => ({
  callLLM: vi.fn(),
  FAST_MODEL: 'mock-fast',
  STRONG_MODEL: 'mock-strong',
}))

import { parseProgressUpdate } from '../parse-progress.js'
import { callLLM } from '../client.js'

const mockCallLLM = vi.mocked(callLLM)

describe('parseProgressUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses message with title and note', async () => {
    mockCallLLM.mockResolvedValueOnce(
      '<progress>{ "title": "Написать отчёт", "note": "готово 50%" }</progress>',
    )

    const result = await parseProgressUpdate('обновил прогресс по задаче Написать отчёт: готово 50%')

    expect(result.title).toBe('Написать отчёт')
    expect(result.note).toBe('готово 50%')
  })

  it('returns fallback when response has no <progress> tag', async () => {
    mockCallLLM.mockResolvedValueOnce('Не могу обработать запрос.')

    const result = await parseProgressUpdate('какое-то сообщение')

    expect(result.title).toBe('')
    expect(result.note).toBeNull()
  })

  it('returns fallback and does not throw when callLLM throws', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('Network error'))

    const result = await parseProgressUpdate('продвинулся по Отчёту')

    expect(result.title).toBe('')
    expect(result.note).toBeNull()
  })
})
