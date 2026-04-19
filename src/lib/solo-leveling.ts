/**
 * HTTP client for SoloLeveling webhook.
 * Sends activity periods from ShedulerBot to SoloLeveling after onboarding.
 * Auth: user-provided SoloLeveling token sent in request body.
 * Requires SOLO_LEVELING_URL env var.
 */
import { logger } from './logger.js'

export interface SLPeriod {
  name: string
  slug: string
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
