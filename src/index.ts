import 'dotenv/config'
import express from 'express'
import { webhookCallback } from 'grammy'
import { bot } from './bot/index.js'
import { logger } from './lib/logger.js'
import { registerAllUsers } from './cron/manager.js'
import { authRouter } from './routes/auth.js'
import { tasksRouter } from './routes/tasks.js'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const NODE_ENV = process.env.NODE_ENV ?? 'development'
const WEBHOOK_URL = process.env.WEBHOOK_URL

async function main(): Promise<void> {
  logger.info('[app] Integrations loaded', {
    soloLeveling: !!process.env.SOLO_LEVELING_URL,
    googleCalendar: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  })

  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  app.use('/auth', authRouter)
  app.use('/api', tasksRouter)

  if (NODE_ENV === 'production' && WEBHOOK_URL) {
    // Production: receive updates via webhook
    const webhookPath = '/telegram'
    logger.info('[app] Starting in webhook mode', { webhookUrl: `${WEBHOOK_URL}${webhookPath}` })

    await bot.api.setWebhook(`${WEBHOOK_URL}${webhookPath}`)
    app.use(webhookPath, webhookCallback(bot, 'express'))

    logger.info('[app] Webhook registered', { path: webhookPath })
  } else {
    // Development: long polling
    logger.info('[app] Starting in polling mode')
    void bot.start({
      onStart: (info) => logger.info('[app] Bot started polling', { username: info.username }),
    })
  }

  const server = app.listen(PORT, () => {
    logger.info('[app] Express listening', { port: PORT, env: NODE_ENV })
    logger.info('[app] Health check endpoint registered', { path: '/health' })
  })

  // Register cron jobs for all existing users
  try {
    logger.info('[app] Registering cron jobs for all users...')
    await registerAllUsers()
    logger.info('[app] Cron jobs registered')
  } catch (err) {
    logger.error('[app] Failed to register cron jobs', { error: String(err) })
  }

  // Graceful shutdown
  function shutdown(signal: string): void {
    logger.info('[app] Shutdown signal received', { signal })
    server.close(() => {
      logger.info('[app] HTTP server closed')
    })
    void bot.stop()
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error('[app] Fatal startup error', { error: String(err) })
  process.exit(1)
})
