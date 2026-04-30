# Implementation Plan: Mark task as completed via external API

Branch: master
Created: 2026-04-30

## Settings
- Testing: yes
- Logging: verbose, existing convention `[module/function] message {data}`

## Overview

Add `POST /api/tasks/:externalId/complete` endpoint. All required DB helpers already exist
(`findTaskByExternalId`, `updateTask`); the change is confined to one route file and one test file.

## Tasks

### Phase 1: Route implementation

- [x] Task 1: Add `POST /api/tasks/:externalId/complete` handler in `src/routes/tasks.ts`

  Add the handler after the existing `/tasks/batch` route.

  **Request schema (Zod):**
  ```ts
  const CompleteTaskSchema = z.object({ schedulerbot_token: z.string().min(1) })
  ```

  **Import update (line 6 of the file):**
  Add `updateTask` to the existing import from `'../db/tasks.js'`.

  **Handler logic:**
  1. Auth: check `x-api-key` header against `process.env.API_SECRET_KEY` → 401 if invalid
  2. Parse + validate body with `CompleteTaskSchema` → 400 if invalid
  3. `getUserBySoloLevelingToken(schedulerbot_token)` → 404 `{ error: 'User not found' }` if null
  4. `findTaskByExternalId(user.id, externalId)` → 404 `{ error: 'Task not found' }` if null
  5. If `task.status !== 'pending'` → 200 `{ success: true }` (idempotent: covers both `done` and `cancelled`)
  6. `updateTask(task.id, { status: 'done' })` → 200 `{ success: true }`

  **Logging requirements:**
  - Entry: INFO `[routes/tasks] POST /api/tasks/:externalId/complete` with `{ externalId, hasToken }`
  - Auth failure: WARN with `{ ip }`
  - User not found: WARN with `{ externalId, hasToken: !!schedulerbot_token }`
  - Task not found: WARN with `{ externalId, userId }`
  - Idempotent hit: INFO with `{ externalId, taskId, status: 'already done' }`
  - Success: INFO with `{ externalId, taskId, userId }`
  - Unexpected errors: ERROR with `{ error: err.message }`

  Files: `src/routes/tasks.ts`

### Phase 2: Tests

- [x] Task 2: Add tests for the new endpoint in `src/routes/__tests__/tasks.test.ts`

  **Setup changes:**
  1. Add `updateTask` to the existing `vi.mock('../../db/tasks.js', ...)` mock object
  2. Add `import { ..., updateTask } from '../../db/tasks.js'` to the imports block
  3. Add `const mockUpdateTask = vi.mocked(updateTask)` with other mock variables
  4. In `beforeEach`: add `mockUpdateTask.mockResolvedValue({ ...MOCK_TASK, status: 'done' })`

  **Test cases (new `describe` block):**

  - 401 — missing or wrong `x-api-key`
  - 400 — missing `schedulerbot_token` in body
  - 404 — user not found (token unknown)
  - 404 — task not found (wrong externalId for this user)
  - 200 — `status: 'done'` already: `updateTask` NOT called (idempotency verified)
  - 200 — `status: 'cancelled'`: `updateTask` NOT called (idempotent for cancelled too)
  - 200 — happy path: `updateTask` called with `{ status: 'done' }`, response `{ success: true }`
  - 500 — `updateTask` throws DB error → returns 500

  Files: `src/routes/__tests__/tasks.test.ts`
