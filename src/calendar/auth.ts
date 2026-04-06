import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { logger } from '../lib/logger.js'

const SCOPES = ['https://www.googleapis.com/auth/calendar']

function getGoogleCredentials(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Missing required Google OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI',
    )
  }

  return { clientId, clientSecret, redirectUri }
}

export function createOAuthClient(): OAuth2Client {
  logger.debug('[calendar/auth] createOAuthClient')
  const { clientId, clientSecret, redirectUri } = getGoogleCredentials()
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

export function getAuthUrl(userId: string): string {
  logger.debug('[calendar/auth] getAuthUrl', { userId })
  const client = createOAuthClient()

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: userId,
  })
}
