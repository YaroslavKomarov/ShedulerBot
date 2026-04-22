/**
 * HTTP client for SoloLeveling webhook.
 * Sends activity periods from ShedulerBot to SoloLeveling after onboarding.
 * Auth: user-provided SoloLeveling token sent in request body.
 * Requires SOLO_LEVELING_URL env var.
 */
import { logger } from './logger.js'
import { getUserById, updateUser } from '../db/users.js'
import { getUserPeriods } from '../db/periods.js'

export interface SLPeriod {
  name: string
  slug: string
  queue_slug: string
  start_time: string
  end_time: string
  days_of_week: number[]  // ISO: 1=Mon..7=Sun (SoloLeveling normalizes on ingest)
}

export interface SLWebhookResult {
  success: boolean
  count: number
}

export async function sendPeriodsToSoloLeveling(
  token: string,
  periods: SLPeriod[],
): Promise<SLWebhookResult> {
  const baseUrl = process.env.SOLO_LEVELING_URL
  if (!baseUrl) {
    throw new Error('SOLO_LEVELING_URL env var is not set')
  }

  const url = `${baseUrl}/api/schedulerbot/webhook`
  logger.info('[solo-leveling] sending periods to SoloLeveling', { periodsCount: periods.length })

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, periods }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    logger.error('[solo-leveling] webhook request failed', { status: response.status, body })
    throw Object.assign(
      new Error(`SoloLeveling webhook error ${response.status}: ${body}`),
      { code: response.status }
    )
  }

  const result = await response.json() as SLWebhookResult
  logger.info('[solo-leveling] periods sent successfully', { count: result.count })
  return result
}

/**
 * Fetches current user periods from DB and sends them to SoloLeveling using the stored token.
 * Silently skips if SOLO_LEVELING_URL is not set or user has no token.
 * On 401: clears stored token and throws with code 401.
 */
export async function syncUserPeriodsToSoloLeveling(userId: string): Promise<void> {
  if (!process.env.SOLO_LEVELING_URL) {
    logger.debug('[FIX][solo-leveling] SOLO_LEVELING_URL not set, skipping sync', { userId })
    return
  }

  const user = await getUserById(userId)
  if (!user?.solo_leveling_token) {
    logger.debug('[FIX][solo-leveling] no token stored, skipping sync', { userId })
    return
  }

  const periods = await getUserPeriods(userId)
  logger.info('[FIX][solo-leveling] syncing periods', { userId, count: periods.length })

  try {
    await sendPeriodsToSoloLeveling(
      user.solo_leveling_token,
      periods.map((p) => ({
        name: p.name,
        slug: p.slug,
        queue_slug: p.queue_slug,
        start_time: p.start_time,
        end_time: p.end_time,
        days_of_week: p.days_of_week,
      })),
    )
    logger.info('[FIX][solo-leveling] sync done', { userId })
  } catch (err) {
    const code = (err as { code?: number }).code
    if (code === 401) {
      logger.warn('[FIX][solo-leveling] token invalid (401), clearing', { userId })
      await updateUser(userId, { solo_leveling_token: null })
    }
    throw err
  }
}
