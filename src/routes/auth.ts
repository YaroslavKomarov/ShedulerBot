import { Router } from 'express'
import { createOAuthClient } from '../calendar/auth.js'
import { getUserById, updateUser } from '../db/users.js'
import { bot } from '../bot/index.js'
import { logger } from '../lib/logger.js'

export const authRouter = Router()

authRouter.get('/google/callback', async (req, res) => {
  const code = req.query['code'] as string | undefined
  const userId = req.query['state'] as string | undefined

  if (!code || !userId) {
    logger.warn('[routes/auth] google callback: missing code or state', { code: !!code, userId })
    res.status(400).send('Bad Request: missing code or state')
    return
  }

  logger.info('[routes/auth] google callback received', { userId })

  try {
    const oauthClient = createOAuthClient()
    const { tokens } = await oauthClient.getToken(code)

    await updateUser(userId, {
      google_access_token: tokens.access_token ?? null,
      google_refresh_token: tokens.refresh_token ?? null,
      google_token_expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : null,
    })

    logger.info('[routes/auth] tokens saved', { userId })

    const user = await getUserById(userId)
    if (user) {
      await bot.api.sendMessage(
        user.telegram_id,
        '✅ Google Calendar подключён! Теперь планы будут синхронизироваться.',
      )
      logger.debug('[routes/auth] telegram notified', { userId })
    }

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 40px;">
          <h2>✅ Авторизация прошла успешно</h2>
          <p>Google Calendar подключён. Можете закрыть эту страницу.</p>
        </body>
      </html>
    `)
  } catch (err) {
    logger.error('[routes/auth] callback error', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    res.status(500).send('Internal Server Error')
  }
})
