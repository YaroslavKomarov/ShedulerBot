import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../db/users.js', () => ({ getUserByTelegramId: vi.fn() }))
vi.mock('../../db/tasks.js', () => ({ createTask: vi.fn(), findTaskByExternalId: vi.fn() }))
vi.mock('../../bot/index.js', () => ({
  bot: { api: { sendMessage: vi.fn() } },
}))

import { getUserByTelegramId } from '../../db/users.js'
import { createTask, findTaskByExternalId } from '../../db/tasks.js'
import { bot } from '../../bot/index.js'
import { tasksRouter } from '../tasks.js'

const mockGetUser = vi.mocked(getUserByTelegramId)
const mockCreateTask = vi.mocked(createTask)
const mockFindByExternalId = vi.mocked(findTaskByExternalId)
const mockSendMessage = vi.mocked(bot.api.sendMessage)

const API_KEY = 'test-secret-key'

const app = express()
app.use(express.json())
app.use('/api', tasksRouter)

const MOCK_USER = {
  id: 'user-uuid-1',
  telegram_id: 123456,
  timezone: 'Europe/Moscow',
  morning_time: '08:00',
  end_of_day_time: '21:00',
  google_access_token: null,
  google_refresh_token: null,
  google_token_expiry: null,
          solo_leveling_token: null,
  created_at: '2026-01-01T00:00:00Z',
}

const MOCK_TASK = {
  id: 'task-uuid-1',
  user_id: 'user-uuid-1',
  title: 'Написать отчёт',
  description: null,
  is_urgent: false,
  deadline_date: null,
  estimated_minutes: null,
  period_slug: null,
  scheduled_date: null,
  status: 'pending' as const,
  source: 'external' as const,
  external_id: null,
  progress_note: null,
  created_at: '2026-04-07T10:00:00Z',
}

const VALID_BODY = {
  telegram_id: 123456,
  title: 'Написать отчёт',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('API_SECRET_KEY', API_KEY)
})

describe('POST /api/tasks', () => {
  it('returns 401 when X-Api-Key header is missing', async () => {
    const res = await request(app).post('/api/tasks').send(VALID_BODY)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when X-Api-Key is wrong', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', 'wrong-key')
      .send(VALID_BODY)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when telegram_id is missing', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send({ title: 'Some task' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Bad Request')
    expect(res.body.details).toBeDefined()
  })

  it('returns 400 when title is empty', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send({ telegram_id: 123456, title: '' })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Bad Request')
  })

  it('returns 404 when user not found', async () => {
    mockGetUser.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'User not found' })
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('returns 201 with created:true, calls createTask and sendMessage on success', async () => {
    mockGetUser.mockResolvedValue(MOCK_USER)
    mockCreateTask.mockResolvedValue(MOCK_TASK)
    mockSendMessage.mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BODY)

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: 'task-uuid-1', created: true })
    expect(mockCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: MOCK_USER.id,
        source: 'external',
        title: 'Написать отчёт',
      }),
    )
    expect(mockSendMessage).toHaveBeenCalledWith(
      MOCK_USER.telegram_id,
      expect.stringContaining('Написать отчёт'),
      { parse_mode: 'Markdown' },
    )
  })

  it('returns 200 with created:false when external_id already exists', async () => {
    const existingTask = { ...MOCK_TASK, id: 'existing-task-id', external_id: 'ext-123' }
    mockGetUser.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(existingTask)

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send({ ...VALID_BODY, external_id: 'ext-123' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'existing-task-id', created: false })
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('returns 201 even when sendMessage throws', async () => {
    mockGetUser.mockResolvedValue(MOCK_USER)
    mockCreateTask.mockResolvedValue(MOCK_TASK)
    mockSendMessage.mockRejectedValue(new Error('Telegram API error'))

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BODY)

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: 'task-uuid-1', created: true })
  })
})
