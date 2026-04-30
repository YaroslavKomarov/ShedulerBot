import { InlineKeyboard } from 'grammy'
import type { Conversation } from '@grammyjs/conversations'
import type { BotContext } from '../index.js'
import { waitForText } from './helpers.js'
import { getUserByTelegramId, updateUser } from '../../db/users.js'
import { getUserPeriods } from '../../db/periods.js'
import { registerUserCrons, unregisterUserCrons } from '../../cron/manager.js'
import { getAuthUrl } from '../../calendar/auth.js'
import { logger } from '../../lib/logger.js'
import { sendPeriodsToSoloLeveling, syncUserPeriodsToSoloLeveling } from '../../lib/solo-leveling.js'
import type { DbUser } from '../../types/index.js'

type SettingsConversation = Conversation<BotContext, BotContext>

function formatSettings(user: { timezone: string; morning_time: string; end_of_day_time: string }): string {
  return [
    'Текущие настройки:',
    `🌍 Часовой пояс: ${user.timezone}`,
    `☀️ Утренний план: ${user.morning_time}`,
    `🌙 Конец дня: ${user.end_of_day_time}`,
  ].join('\n')
}

function buildSettingsKeyboard(hasSLToken = false): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🌍 Часовой пояс', 'set_timezone').row()
    .text('☀️ Утренний план', 'set_morning').row()
    .text('🌙 Конец дня', 'set_eod').row()
    .text('📅 Google Calendar', 'set_calendar').row()
  if (process.env.SOLO_LEVELING_URL) {
    if (hasSLToken) {
      kb.text('🔗 SoloLeveling (синхронизировать)', 'set_solo_leveling').row()
      kb.text('⛓️ SoloLeveling (отвязать)', 'set_solo_leveling_unlink').row()
    } else {
      kb.text('🔗 SoloLeveling', 'set_solo_leveling').row()
    }
  }
  kb.text('✅ Готово', 'set_done')
  return kb
}

export async function settingsConversation(
  conversation: SettingsConversation,
  ctx: BotContext,
): Promise<void> {
  const telegramId = ctx.from?.id
  if (!telegramId) return

  logger.info('[conversation/settings] start', { userId: telegramId })

  let user = await conversation.external(() => getUserByTelegramId(telegramId))
  if (!user) {
    await ctx.reply('Сначала пройди /start для настройки.')
    return
  }

  let changed = false

  await ctx.reply(formatSettings(user), { reply_markup: buildSettingsKeyboard(!!user.solo_leveling_token) })

  while (true) {
    const cbCtx = await conversation.waitForCallbackQuery(/^set_/)
    await cbCtx.answerCallbackQuery()
    const action = cbCtx.callbackQuery.data

    if (action === 'set_done') break

    if (action === 'set_solo_leveling_unlink') {
      user = await conversation.external(() => updateUser(user!.id, { solo_leveling_token: null }))
      logger.info('[conversation/settings] SoloLeveling token cleared', { userId: user.id })
      await ctx.reply('⛓️ SoloLeveling отвязан.', { reply_markup: buildSettingsKeyboard(false) })
      continue
    }

    if (action === 'set_timezone') {
      await ctx.reply('Введи часовой пояс (например: Europe/Moscow или Asia/Almaty):')
      const { text } = await waitForText(conversation)
      const timezone = text.trim()
      user = await conversation.external(() => updateUser(user!.id, { timezone }))
      changed = true
      logger.info('[conversation/settings] timezone updated', { userId: user.id, timezone })
      await ctx.reply(`✅ Часовой пояс изменён: ${user.timezone}`, { reply_markup: buildSettingsKeyboard(!!user?.solo_leveling_token) })
    } else if (action === 'set_morning') {
      await ctx.reply('Введи время утреннего плана в формате ЧЧ:ММ (например: 08:00):')
      const { text } = await waitForText(conversation)
      const morning_time = text.trim()
      user = await conversation.external(() => updateUser(user!.id, { morning_time }))
      changed = true
      logger.info('[conversation/settings] morning_time updated', { userId: user.id, morning_time })
      await ctx.reply(`✅ Утренний план: ${user.morning_time}`, { reply_markup: buildSettingsKeyboard(!!user?.solo_leveling_token) })
    } else if (action === 'set_eod') {
      await ctx.reply('Введи время конца дня в формате ЧЧ:ММ (например: 22:00):')
      const { text } = await waitForText(conversation)
      const end_of_day_time = text.trim()
      user = await conversation.external(() => updateUser(user!.id, { end_of_day_time }))
      changed = true
      logger.info('[conversation/settings] end_of_day_time updated', { userId: user.id, end_of_day_time })
      await ctx.reply(`✅ Конец дня: ${user.end_of_day_time}`, { reply_markup: buildSettingsKeyboard(!!user?.solo_leveling_token) })
    } else if (action === 'set_solo_leveling') {
      if (user!.solo_leveling_token) {
        // Token exists — auto-sync.
        // ctx.reply() must be OUTSIDE conversation.external() — calling Telegram API
        // inside external() breaks Grammy v2 replay: the call fires on first run but is
        // skipped during replay (external() returns cached result), causing step-counter
        // mismatch and a permanent waitForCallbackQuery hang.
        logger.info('[conversation/settings] token exists, auto-syncing', { userId: user!.id })
        type AutoSyncResult = 'ok' | 'expired' | 'error'
        const syncResult = await conversation.external<AutoSyncResult>(async () => {
          try {
            await syncUserPeriodsToSoloLeveling(user!.id)
            logger.info('[conversation/settings] auto-sync done', { userId: user!.id })
            return 'ok'
          } catch (err) {
            const code = (err as { code?: number }).code
            logger.error('[conversation/settings] auto-sync failed', { userId: user!.id, code, error: err instanceof Error ? err.message : String(err) })
            return code === 401 ? 'expired' : 'error'
          }
        })
        if (syncResult === 'expired') {
          // syncUserPeriodsToSoloLeveling already cleared the token — refresh user object.
          // Fallback to stale user on DB error: token is already cleared in DB, safe to continue.
          user = await conversation.external<DbUser>(async () => {
            try {
              return (await getUserByTelegramId(user!.telegram_id)) ?? user!
            } catch {
              return user!
            }
          })
          await ctx.reply('❌ Токен устарел и был удалён. Введи новый токен через /settings → SoloLeveling.', { reply_markup: buildSettingsKeyboard(false) })
        } else if (syncResult === 'error') {
          await ctx.reply('❌ Не удалось связаться с SoloLeveling. Попробуй позже.', { reply_markup: buildSettingsKeyboard(true) })
        } else {
          await ctx.reply('✅ Периоды синхронизированы с SoloLeveling!', { reply_markup: buildSettingsKeyboard(true) })
        }
      } else {
        // No token — ask for it
        await ctx.reply('Введи токен SoloLeveling (найти в настройках приложения):')
        const { text: slToken } = await waitForText(conversation)

        const periods = await conversation.external(() => getUserPeriods(user!.id))
        logger.info('[conversation/settings] sending periods to SoloLeveling', { userId: user!.id, count: periods.length })

        type SyncTokenResult =
          | { ok: true; updatedUser: DbUser }
          | { ok: false; code?: number }
        const result = await conversation.external<SyncTokenResult>(async () => {
          try {
            await sendPeriodsToSoloLeveling(
              slToken.trim(),
              periods.map((p) => ({
                name: p.name,
                slug: p.slug,
                queue_slug: p.queue_slug,
                start_time: p.start_time,
                end_time: p.end_time,
                days_of_week: p.days_of_week,
              })),
            )
            const updatedUser = await updateUser(user!.id, { solo_leveling_token: slToken.trim() })
            logger.info('[conversation/settings] token saved', { userId: updatedUser.id })
            return { ok: true, updatedUser }
          } catch (err) {
            const code = (err as { code?: number }).code
            logger.error('[conversation/settings] SoloLeveling sync failed', { userId: user!.id, code, error: err instanceof Error ? err.message : String(err) })
            return { ok: false, code }
          }
        })
        if (result.ok) {
          user = result.updatedUser
          await ctx.reply('✅ Периоды переданы в SoloLeveling! Настрой маппинг сфер в настройках SoloLeveling.', { reply_markup: buildSettingsKeyboard(true) })
        } else {
          const msg = result.code === 401
            ? '❌ Неверный токен. Проверь токен и попробуй снова.'
            : '❌ Не удалось связаться с SoloLeveling. Попробуй позже.'
          await ctx.reply(msg, { reply_markup: buildSettingsKeyboard(false) })
        }
      }
    } else if (action === 'set_calendar') {
      const hasGoogleConfig = !!(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.GOOGLE_REDIRECT_URI
      )

      if (!hasGoogleConfig) {
        await ctx.reply('Google Calendar временно недоступен.', { reply_markup: buildSettingsKeyboard(!!user?.solo_leveling_token) })
        continue
      }

      try {
        const authUrl = getAuthUrl(user.id)
        const calKeyboard = new InlineKeyboard().text('Готово / Пропустить', 'cal_done')
        await ctx.reply(
          `Для подключения Google Calendar перейди по ссылке:\n${authUrl}\n\nПосле авторизации нажми кнопку ниже.`,
          { reply_markup: calKeyboard },
        )
        const doneCtx = await conversation.waitForCallbackQuery(/^cal_done$/)
        await doneCtx.answerCallbackQuery()
        logger.info('[conversation/settings] calendar connect flow completed', { userId: user.id })
        await ctx.reply('Google Calendar подключён ✅', { reply_markup: buildSettingsKeyboard(!!user?.solo_leveling_token) })
      } catch (err) {
        logger.error('[conversation/settings] getAuthUrl failed', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        })
        await ctx.reply('Не удалось получить ссылку. Попробуй позже.', { reply_markup: buildSettingsKeyboard(!!user?.solo_leveling_token) })
      }
    }
  }

  if (changed) {
    await conversation.external(async () => {
      unregisterUserCrons(user!.id)
      await registerUserCrons(user!)
    })
    logger.info('[conversation/settings] crons re-registered', { userId: user.id })
    await ctx.reply('Настройки сохранены, расписание обновлено.')
  } else {
    await ctx.reply('Настройки не изменены.')
  }
}
