import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../db/users.js', () => ({
  getUserByTelegramId: vi.fn(),
  getUserBySoloLevelingToken: vi.fn(),
}))
vi.mock('../../db/tasks.js', () => ({ createTask: vi.fn(), findTaskByExternalId: vi.fn(), updateTask: vi.fn() }))
vi.mock('../../db/periods.js', () => ({ getUserPeriods: vi.fn() }))
vi.mock('../../bot/index.js', () => ({
  bot: { api: { sendMessage: vi.fn() } },
}))

import { getUserByTelegramId, getUserBySoloLevelingToken } from '../../db/users.js'
import { createTask, findTaskByExternalId, updateTask } from '../../db/tasks.js'
import { getUserPeriods } from '../../db/periods.js'
import { bot } from '../../bot/index.js'
import { tasksRouter } from '../tasks.js'

const mockGetUser = vi.mocked(getUserByTelegramId)
const mockGetUserByToken = vi.mocked(getUserBySoloLevelingToken)
const mockCreateTask = vi.mocked(createTask)
const mockFindByExternalId = vi.mocked(findTaskByExternalId)
const mockUpdateTask = vi.mocked(updateTask)
const mockGetUserPeriods = vi.mocked(getUserPeriods)
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
  solo_leveling_token: 'sl-token-abc',
  created_at: '2026-01-01T00:00:00Z',
}

const MOCK_TASK = {
  id: 'task-uuid-1',
  user_id: 'user-uuid-1',
  title: 'Написать отчёт',
  description: null,
  is_urgent: false,
  is_overflow: false,
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
  mockGetUserPeriods.mockResolvedValue([])
  mockFindByExternalId.mockResolvedValue(null)
  mockUpdateTask.mockResolvedValue({ ...MOCK_TASK, status: 'done' })
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

  it('returns 400 when neither telegram_id nor schedulerbot_token is provided', async () => {
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

  it('returns 404 when user not found by telegram_id', async () => {
    mockGetUser.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'User not found' })
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('returns 404 when user not found by schedulerbot_token', async () => {
    mockGetUserByToken.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send({ schedulerbot_token: 'bad-token', title: 'Task' })

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'User not found' })
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('returns 201 with created:true, calls createTask and sendMessage when telegram_id auth', async () => {
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

  it('returns 201 but does NOT send notification when schedulerbot_token auth', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockCreateTask.mockResolvedValue(MOCK_TASK)

    const res = await request(app)
      .post('/api/tasks')
      .set('X-Api-Key', API_KEY)
      .send({ schedulerbot_token: 'sl-token-abc', title: 'Task from SL' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: 'task-uuid-1', created: true })
    expect(mockSendMessage).not.toHaveBeenCalled()
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

  describe('scheduled_date / deadline_date mutual exclusivity', () => {
    it('returns 400 when both scheduled_date and deadline_date are provided', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set('X-Api-Key', API_KEY)
        .send({ ...VALID_BODY, scheduled_date: '2026-05-01', deadline_date: '2026-05-10' })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Bad Request')
      expect(JSON.stringify(res.body.details)).toContain('взаимоисключающие')
      expect(mockCreateTask).not.toHaveBeenCalled()
    })

    it('returns 201 when only scheduled_date is provided', async () => {
      mockGetUser.mockResolvedValue(MOCK_USER)
      mockCreateTask.mockResolvedValue({ ...MOCK_TASK, scheduled_date: '2026-05-01' })
      mockSendMessage.mockResolvedValue({} as any)

      const res = await request(app)
        .post('/api/tasks')
        .set('X-Api-Key', API_KEY)
        .send({ ...VALID_BODY, scheduled_date: '2026-05-01' })

      expect(res.status).toBe(201)
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ scheduled_date: '2026-05-01' }),
      )
      expect(mockCreateTask.mock.calls[0][0]).not.toHaveProperty('deadline_date', expect.any(String))
    })

    it('returns 201 when only deadline_date is provided', async () => {
      mockGetUser.mockResolvedValue(MOCK_USER)
      mockCreateTask.mockResolvedValue({ ...MOCK_TASK, deadline_date: '2026-05-10' })
      mockSendMessage.mockResolvedValue({} as any)

      const res = await request(app)
        .post('/api/tasks')
        .set('X-Api-Key', API_KEY)
        .send({ ...VALID_BODY, deadline_date: '2026-05-10' })

      expect(res.status).toBe(201)
      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({ deadline_date: '2026-05-10' }),
      )
      expect(mockCreateTask.mock.calls[0][0]).not.toHaveProperty('scheduled_date', expect.any(String))
    })
  })
})

describe('POST /api/tasks/batch', () => {
  const VALID_BATCH = {
    schedulerbot_token: 'sl-token-abc',
    tasks: [
      { external_id: 'ext-1', title: 'Task 1' },
      { external_id: 'ext-2', title: 'Task 2' },
    ],
  }

  it('returns 401 when X-Api-Key is missing', async () => {
    const res = await request(app).post('/api/tasks/batch').send(VALID_BATCH)

    expect(res.status).toBe(401)
  })

  it('returns 400 when schedulerbot_token is missing', async () => {
    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send({ tasks: [{ title: 'Task' }] })

    expect(res.status).toBe(400)
  })

  it('returns 400 when tasks array is empty', async () => {
    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send({ schedulerbot_token: 'sl-token-abc', tasks: [] })

    expect(res.status).toBe(400)
  })

  it('returns 404 when token does not match any user', async () => {
    mockGetUserByToken.mockResolvedValue(null)

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BATCH)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'User not found' })
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('creates all tasks and sends single notification', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(null)
    mockCreateTask
      .mockResolvedValueOnce({ ...MOCK_TASK, id: 'task-1', external_id: 'ext-1', title: 'Task 1' })
      .mockResolvedValueOnce({ ...MOCK_TASK, id: 'task-2', external_id: 'ext-2', title: 'Task 2' })
    mockSendMessage.mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BATCH)

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(2)
    expect(res.body.skipped).toBe(0)
    expect(res.body.failed).toBe(0)
    expect(res.body.results).toHaveLength(2)
    expect(res.body.results[0]).toEqual({ external_id: 'ext-1', id: 'task-1', created: true })
    expect(res.body.results[1]).toEqual({ external_id: 'ext-2', id: 'task-2', created: true })
    expect(mockCreateTask).toHaveBeenCalledTimes(2)
    // One summary message, not two individual ones
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledWith(
      MOCK_USER.telegram_id,
      expect.stringContaining('SoloLeveling'),
    )
  })

  it('skips tasks with duplicate external_id', async () => {
    const existingTask = { ...MOCK_TASK, id: 'existing-id', external_id: 'ext-1' }
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId
      .mockResolvedValueOnce(existingTask) // ext-1 exists
      .mockResolvedValueOnce(null)          // ext-2 is new
    mockCreateTask.mockResolvedValueOnce({ ...MOCK_TASK, id: 'task-2', external_id: 'ext-2', title: 'Task 2' })
    mockSendMessage.mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BATCH)

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)
    expect(res.body.skipped).toBe(1)
    expect(res.body.failed).toBe(0)
    expect(res.body.results[0]).toEqual({ external_id: 'ext-1', id: 'existing-id', created: false })
    expect(res.body.results[1]).toEqual({ external_id: 'ext-2', id: 'task-2', created: true })
    expect(mockCreateTask).toHaveBeenCalledTimes(1)
  })

  it('counts failed tasks without stopping processing', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(null)
    mockCreateTask
      .mockRejectedValueOnce(new Error('DB error'))
      .mockResolvedValueOnce({ ...MOCK_TASK, id: 'task-2', external_id: 'ext-2', title: 'Task 2' })
    mockSendMessage.mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send(VALID_BATCH)

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)
    expect(res.body.skipped).toBe(0)
    expect(res.body.failed).toBe(1)
    expect(res.body.results[0]).toMatchObject({ external_id: 'ext-1', id: null, created: false, error: 'DB error' })
    expect(res.body.results[1]).toEqual({ external_id: 'ext-2', id: 'task-2', created: true })
  })

  it('does not send notification when all tasks are skipped', async () => {
    const existingTask = { ...MOCK_TASK, id: 'existing-id', external_id: 'ext-1' }
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(existingTask)

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send({ schedulerbot_token: 'sl-token-abc', tasks: [{ external_id: 'ext-1', title: 'Task 1' }] })

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(0)
    expect(res.body.skipped).toBe(1)
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('includes period name in notification when all created tasks share same period', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(null)
    mockGetUserPeriods.mockResolvedValue([
      { id: 'p1', user_id: MOCK_USER.id, name: 'Работа', slug: 'work', queue_slug: 'work-queue', start_time: '09:00', end_time: '17:00', days_of_week: [1,2,3,4,5], order_index: 0, created_at: '' },
    ])
    mockCreateTask
      .mockResolvedValueOnce({ ...MOCK_TASK, id: 'task-1', period_slug: 'work-queue' })
      .mockResolvedValueOnce({ ...MOCK_TASK, id: 'task-2', period_slug: 'work-queue' })
    mockSendMessage.mockResolvedValue({} as any)

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send({
        schedulerbot_token: 'sl-token-abc',
        tasks: [
          { external_id: 'ext-1', title: 'Task 1', period_slug: 'work' },
          { external_id: 'ext-2', title: 'Task 2', period_slug: 'work' },
        ],
      })

    expect(res.status).toBe(200)
    expect(mockSendMessage).toHaveBeenCalledWith(
      MOCK_USER.telegram_id,
      expect.stringContaining('Работа'),
    )
  })

  it('returns 200 even when sendMessage throws', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(null)
    mockCreateTask.mockResolvedValue({ ...MOCK_TASK, id: 'task-1' })
    mockSendMessage.mockRejectedValue(new Error('Telegram down'))

    const res = await request(app)
      .post('/api/tasks/batch')
      .set('X-Api-Key', API_KEY)
      .send({ schedulerbot_token: 'sl-token-abc', tasks: [{ title: 'Task 1' }] })

    expect(res.status).toBe(200)
    expect(res.body.created).toBe(1)
  })
})

describe('POST /api/tasks/:externalId/complete', () => {
  const EXTERNAL_ID = 'ext-uuid-1'
  const VALID_COMPLETE_BODY = { schedulerbot_token: 'sl-token-abc' }
  const PENDING_TASK = { ...MOCK_TASK, external_id: EXTERNAL_ID, status: 'pending' as const }

  it('returns 401 when X-Api-Key is missing', async () => {
    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 401 when X-Api-Key is wrong', async () => {
    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', 'wrong-key')
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when schedulerbot_token is missing', async () => {
    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send({})

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Bad Request')
  })

  it('returns 404 when user not found by token', async () => {
    mockGetUserByToken.mockResolvedValue(null)

    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'User not found' })
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('returns 404 when task not found by externalId for this user', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(null)

    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Task not found' })
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('returns 200 without calling updateTask when task is already done', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue({ ...PENDING_TASK, status: 'done' })

    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('returns 200 without calling updateTask when task is cancelled', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue({ ...PENDING_TASK, status: 'cancelled' })

    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(mockUpdateTask).not.toHaveBeenCalled()
  })

  it('returns 200 and calls updateTask with status done on success', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(PENDING_TASK)

    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
    expect(mockUpdateTask).toHaveBeenCalledWith(PENDING_TASK.id, { status: 'done' })
  })

  it('returns 500 when updateTask throws', async () => {
    mockGetUserByToken.mockResolvedValue(MOCK_USER)
    mockFindByExternalId.mockResolvedValue(PENDING_TASK)
    mockUpdateTask.mockRejectedValue(new Error('DB connection lost'))

    const res = await request(app)
      .post(`/api/tasks/${EXTERNAL_ID}/complete`)
      .set('X-Api-Key', API_KEY)
      .send(VALID_COMPLETE_BODY)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Internal Server Error' })
  })
})
