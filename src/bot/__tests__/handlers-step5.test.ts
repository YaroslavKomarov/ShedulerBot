import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../db/users.js', () => ({ getUserByTelegramId: vi.fn() }))
vi.mock('../../db/periods.js', () => ({ getUserPeriods: vi.fn() }))
vi.mock('../../llm/intent.js', () => ({ detectIntent: vi.fn() }))
vi.mock('../../llm/parse-task.js', () => ({ parseTaskMessage: vi.fn() }))
vi.mock('../../llm/parse-progress.js', () => ({ parseProgressUpdate: vi.fn() }))
vi.mock('../../db/tasks.js', () => ({
  findTasksByTitle: vi.fn(),
  updateTask: vi.fn(),
  getBacklog: vi.fn(),
}))
vi.mock('../plan-helper.js', () => ({ sendPlanForDate: vi.fn() }))

import { handleFreeText } from '../handlers.js'
import { getUserByTelegramId } from '../../db/users.js'
import { getUserPeriods } from '../../db/periods.js'
import { detectIntent } from '../../llm/intent.js'
import { parseTaskMessage } from '../../llm/parse-task.js'
import { parseProgressUpdate } from '../../llm/parse-progress.js'
import { findTasksByTitle, updateTask, getBacklog } from '../../db/tasks.js'

const mockGetUser = vi.mocked(getUserByTelegramId)
const mockGetPeriods = vi.mocked(getUserPeriods)
const mockDetectIntent = vi.mocked(detectIntent)
const mockParseTask = vi.mocked(parseTaskMessage)
const mockParseProgress = vi.mocked(parseProgressUpdate)
const mockFindTasks = vi.mocked(findTasksByTitle)
const mockUpdateTask = vi.mocked(updateTask)
const mockGetBacklog = vi.mocked(getBacklog)

const BASE_USER = {
  id: 'user-1',
  telegram_id: 123,
  timezone: 'Europe/Moscow',
  name: 'Test',
  morning_time: '08:00',
  evening_time: '21:00',
  google_calendar_enabled: false,
  google_tokens: null,
  created_at: '2026-01-01T00:00:00Z',
}

const BASE_TASK = {
  id: 'task-1',
  user_id: 'user-1',
  title: 'Написать отчёт',
  description: null,
  is_urgent: false,
  deadline_date: null,
  estimated_minutes: null,
  period_slug: null,
  scheduled_date: null,
  status: 'pending',
  source: 'telegram',
  progress_note: null,
  created_at: '2026-01-01T00:00:00Z',
}

function makeCtx(text: string, intent: string) {
  const replySpy = vi.fn().mockResolvedValue(undefined)
  const ctx = {
    from: { id: 123 },
    message: { text },
    reply: replySpy,
    conversation: { enter: vi.fn() },
  } as any
  mockGetUser.mockResolvedValue(BASE_USER as any)
  mockGetPeriods.mockResolvedValue([])
  mockDetectIntent.mockResolvedValue({ intent: intent as any, confidence: 'high' })
  return { ctx, replySpy }
}

// ─── handleMarkDone ────────────────────────────────────────────────────────────

describe('handleMarkDone', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replies with clarification when parsed title is empty', async () => {
    const { ctx, replySpy } = makeCtx('сделал', 'mark_done')
    mockParseTask.mockResolvedValue({ title: '', needs_clarification: true } as any)

    await handleFreeText(ctx)

    expect(replySpy).toHaveBeenCalledWith(
      expect.stringContaining('Не понял'),
    )
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('replies "not found" when no matching tasks', async () => {
    const { ctx, replySpy } = makeCtx('выполнил Написать отчёт', 'mark_done')
    mockParseTask.mockResolvedValue({ title: 'Написать отчёт', needs_clarification: false } as any)
    mockFindTasks.mockResolvedValue([])

    await handleFreeText(ctx)

    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('не найдена'))
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('marks task done and replies with check when single match', async () => {
    const { ctx, replySpy } = makeCtx('выполнил Написать отчёт', 'mark_done')
    mockParseTask.mockResolvedValue({ title: 'Написать отчёт', needs_clarification: false } as any)
    mockFindTasks.mockResolvedValue([BASE_TASK] as any)
    mockUpdateTask.mockResolvedValue({ ...BASE_TASK, status: 'done' } as any)

    await handleFreeText(ctx)

    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { status: 'done' })
    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('✅ Отмечено'))
    expect(replySpy).not.toHaveBeenCalledWith(expect.stringContaining('несколько совпадений'))
  })

  it('uses first match and mentions multiple when several tasks found', async () => {
    const { ctx, replySpy } = makeCtx('выполнил Отчёт', 'mark_done')
    mockParseTask.mockResolvedValue({ title: 'Отчёт', needs_clarification: false } as any)
    const second = { ...BASE_TASK, id: 'task-2', title: 'Отчёт 2' }
    mockFindTasks.mockResolvedValue([BASE_TASK, second] as any)
    mockUpdateTask.mockResolvedValue({ ...BASE_TASK, status: 'done' } as any)

    await handleFreeText(ctx)

    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { status: 'done' })
    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('нашёл несколько совпадений'))
  })
})

// ─── handleUpdateProgress ──────────────────────────────────────────────────────

describe('handleUpdateProgress', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replies with clarification when parsed title is empty', async () => {
    const { ctx, replySpy } = makeCtx('обновил', 'update_progress')
    mockParseProgress.mockResolvedValue({ title: '', note: null })

    await handleFreeText(ctx)

    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('Не понял'))
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('replies "not found" when no matching tasks', async () => {
    const { ctx, replySpy } = makeCtx('обновил прогресс по Отчёту: 50%', 'update_progress')
    mockParseProgress.mockResolvedValue({ title: 'Отчёт', note: '50%' })
    mockFindTasks.mockResolvedValue([])

    await handleFreeText(ctx)

    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('не найдена'))
  })

  it('updates progress_note and confirms', async () => {
    const { ctx, replySpy } = makeCtx('обновил прогресс по Отчёту: готово 50%', 'update_progress')
    mockParseProgress.mockResolvedValue({ title: 'Написать отчёт', note: 'готово 50%' })
    mockFindTasks.mockResolvedValue([BASE_TASK] as any)
    mockUpdateTask.mockResolvedValue({ ...BASE_TASK, progress_note: 'готово 50%' } as any)

    await handleFreeText(ctx)

    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', { progress_note: 'готово 50%' })
    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('📝 Прогресс обновлён'))
  })
})

// ─── handleShowBacklog ─────────────────────────────────────────────────────────

describe('handleShowBacklog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('replies with empty backlog message when no tasks', async () => {
    const { ctx, replySpy } = makeCtx('покажи бэклог', 'show_backlog')
    mockGetBacklog.mockResolvedValue([])

    await handleFreeText(ctx)

    expect(replySpy).toHaveBeenCalledWith(expect.stringContaining('Бэклог пуст'))
  })

  it('includes task titles in reply when backlog has tasks', async () => {
    const { ctx, replySpy } = makeCtx('покажи бэклог', 'show_backlog')
    mockGetBacklog.mockResolvedValue([
      { ...BASE_TASK, title: 'Задача А' },
      { ...BASE_TASK, id: 'task-2', title: 'Задача Б' },
    ] as any)

    await handleFreeText(ctx)

    const replyText: string = replySpy.mock.calls[0][0]
    expect(replyText).toContain('Задача А')
    expect(replyText).toContain('Задача Б')
    // Should not throw on Markdown parsing
    expect(replySpy).toHaveBeenCalledWith(expect.any(String), { parse_mode: 'Markdown' })
  })
})
