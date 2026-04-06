import { google } from 'googleapis'
import type { calendar_v3 } from 'googleapis'
import { createOAuthClient } from './auth.js'
import { getUserById, updateUser } from '../db/users.js'
import { logger } from '../lib/logger.js'

export async function getCalendarClient(userId: string): Promise<calendar_v3.Calendar | null> {
  logger.debug('[calendar/client] getCalendarClient', { userId })

  const user = await getUserById(userId)
  if (!user) {
    logger.debug('[calendar/client] user not found', { userId })
    return null
  }

  if (!user.google_access_token || !user.google_refresh_token) {
    logger.debug('[calendar/client] no tokens, skipping', { userId })
    return null
  }

  const client = createOAuthClient()
  const expiryDate = user.google_token_expiry ? Date.parse(user.google_token_expiry) : undefined

  client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token,
    expiry_date: expiryDate,
  })

  // Refresh if expired (or expiry unknown, be safe and refresh)
  const isExpired = expiryDate === undefined || expiryDate < Date.now()
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken()
      client.setCredentials(credentials)

      await updateUser(userId, {
        google_access_token: credentials.access_token ?? null,
        google_refresh_token: credentials.refresh_token ?? user.google_refresh_token,
        google_token_expiry: credentials.expiry_date
          ? new Date(credentials.expiry_date).toISOString()
          : null,
      })

      logger.info('[calendar/client] tokens refreshed', { userId })
    } catch (err) {
      logger.error('[calendar/client] token refresh error', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  return google.calendar({ version: 'v3', auth: client })
}
