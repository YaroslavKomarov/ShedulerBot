import { InlineKeyboard } from 'grammy'
import type { Conversation } from '@grammyjs/conversations'
import type { BotContext } from '../index.js'

type OnboardingConversation = Conversation<BotContext, BotContext>
import { continueInterview, parseInterviewResult, type ChatMessage, type InterviewResult } from '../../llm/interview.js'
import { waitForText } from './helpers.js'
import { getUserByTelegramId, createUser, updateUser } from '../../db/users.js'
import { getAuthUrl } from '../../calendar/auth.js'
import { createPeriods, deleteUserPeriods } from '../../db/periods.js'
import { registerUserCrons } from '../../cron/manager.js'
import { logger } from '../../lib/logger.js'
import { syncUserPeriodsToSoloLeveling, sendPeriodsToSoloLeveling } from '../../lib/solo-leveling.js'

function formatPeriodDays(days: number[]): string {
  const names: Record<number, string> = { 1: 'Пн', 2: 'Вт', 3: 'Ср', 4: 'Чт', 5: 'Пт', 6: 'Сб', 7: 'Вс' }
  return days.map((d) => names[d] ?? String(d)).join(', ')
}

function formatSummary(result: InterviewResult): string {
  const periodLines = result.periods
    .map((p) => `• ${p.name} (${p.start_time}–${p.end_time}, ${formatPeriodDays(p.days_of_week)})`)
    .join('\n')

  return [
    'Вот что я записал:',
    `🌍 Таймзона: ${result.timezone}`,
    `☀️ Утренний план: ${result.morning_time}`,
    `🌙 Конец дня: ${result.end_of_day_time}`,
    `📅 Периоды:\n${periodLines}`,
  ].join('\n')
}

export async function onboardingConversation(
  conversation: OnboardingConversation,
  ctx: BotContext,
): Promise<void> {
  const userId = ctx.from?.id
  logger.info('[conversation/onboarding] start', { userId })

  await ctx.reply(
    'Привет! Я помогу настроить твоё расписание.\n\nДля начала — в каком городе или часовом поясе ты находишься?',
  )

  const history: ChatMessage[] = []
  let result: InterviewResult | null = null
  let round = 0

  // LLM interview loop
  while (true) {
    round++
    const { ctx: userMsgCtx, text: userText } = await waitForText(conversation)

    history.push({ role: 'user', content: userText })
    logger.debug('[conversation/onboarding] round', { userId, round, historyLength: history.length })

    const reply = await conversation.external(async () => continueInterview(history))

    history.push({ role: 'assistant', content: reply })

    // Strip the <data> block before sending to user
    const displayReply = reply.replace(/<data>[\s\S]*?<\/data>/g, '').trim()
    if (displayReply) {
      await userMsgCtx.reply(displayReply)
    }

    result = parseInterviewResult(reply)
    if (result) break
  }

  if (!result) {
    logger.error('[conversation/onboarding] no result after loop', { userId })
    await ctx.reply('Что-то пошло не так. Попробуй ещё раз — напиши /start')
    return
  }

  logger.info('[conversation/onboarding] data received', {
    userId,
    timezone: result.timezone,
    periodsCount: result.periods.length,
  })

  // Confirmation loop
  while (true) {
    const summary = formatSummary(result)
    const confirmKeyboard = new InlineKeyboard()
      .text('✅ Всё верно', 'confirm_yes')
      .text('✏️ Исправить', 'confirm_no')

    await ctx.reply(summary, { reply_markup: confirmKeyboard })

    const confirmCtx = await conversation.waitForCallbackQuery(/^confirm_/)
    await confirmCtx.answerCallbackQuery()

    const choice = confirmCtx.callbackQuery.data
    logger.info('[conversation/onboarding] confirmation choice', { userId, choice })

    if (choice === 'confirm_yes') break

    // User wants to correct — continue interview
    history.push({ role: 'user', content: 'Нет, давай исправим. ' + (confirmCtx.from?.first_name ? 'Скажи что нужно изменить.' : '') })
    await ctx.reply('Хорошо! Что именно хотим изменить?')

    while (true) {
      round++
      const { ctx: fixCtx, text: fixText } = await waitForText(conversation)

      history.push({ role: 'user', content: fixText })
      logger.debug('[conversation/onboarding] correction round', { userId, round })

      const reply = await conversation.external(async () => continueInterview(history))
      history.push({ role: 'assistant', content: reply })

      const displayReply = reply.replace(/<data>[\s\S]*?<\/data>/g, '').trim()
      if (displayReply) {
        await fixCtx.reply(displayReply)
      }

      const newResult = parseInterviewResult(reply)
      if (newResult) {
        result = newResult
        break
      }
    }
  }

  logger.info('[conversation/onboarding] confirmed by user', { userId })

  // Save to DB first — need user.id for the Google Calendar OAuth URL
  logger.info('[conversation/onboarding] saving to DB', { userId, periodsCount: result.periods.length })

  const telegramId = ctx.from!.id

  const user = await conversation.external(async () => {
    const existing = await getUserByTelegramId(telegramId)
    if (existing) {
      return updateUser(existing.id, {
        timezone: result!.timezone,
        morning_time: result!.morning_time,
        end_of_day_time: result!.end_of_day_time,
      })
    }
    return createUser({
      telegram_id: telegramId,
      timezone: result!.timezone,
      morning_time: result!.morning_time,
      end_of_day_time: result!.end_of_day_time,
    })
  })

  await conversation.external(async () => {
    await deleteUserPeriods(user.id)
    logger.debug('[FIX] deleted existing periods before re-create', { userId: user.id })
    await createPeriods(
      result!.periods.map((p, i) => ({
        user_id: user.id,
        name: p.name,
        slug: p.slug,
        queue_slug: p.slug,
        start_time: p.start_time,
        end_time: p.end_time,
        days_of_week: p.days_of_week,
        order_index: i,
      })),
    )
  })

  await conversation.external(async () => {
    registerUserCrons(user)
  })

  logger.info('[conversation/onboarding] saved to DB', { userId: user.id, periodsCount: result.periods.length })

  // Google Calendar offer
  const calendarKeyboard = new InlineKeyboard()
    .text('📅 Подключить', 'calendar_connect')
    .text('Пропустить', 'calendar_skip')

  await ctx.reply(
    'Хочешь подключить Google Calendar? Тогда задачи будут автоматически добавляться в твой календарь.',
    { reply_markup: calendarKeyboard },
  )

  const calendarCtx = await conversation.waitForCallbackQuery(/^calendar_/)
  await calendarCtx.answerCallbackQuery()

  const calendarChoice = calendarCtx.callbackQuery.data
  logger.info('[conversation/onboarding] calendar choice', { userId, calendarChoice })

  if (calendarChoice === 'calendar_connect') {
    const hasGoogleConfig = !!(
      process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REDIRECT_URI
    )

    if (hasGoogleConfig) {
      try {
        const authUrl = getAuthUrl(user.id)
        const doneKeyboard = new InlineKeyboard().text('Готово / Пропустить', 'calendar_done')
        await ctx.reply(
          `Для подключения Google Calendar перейди по ссылке:\n${authUrl}\n\nПосле авторизации нажми кнопку ниже.`,
          { reply_markup: doneKeyboard },
        )
        const doneCtx = await conversation.waitForCallbackQuery(/^calendar_done$/)
        await doneCtx.answerCallbackQuery()
      } catch (err) {
        logger.error('[conversation/onboarding] getAuthUrl failed', {
          userId: user.id,
          error: err instanceof Error ? err.message : String(err),
        })
        await ctx.reply('Не удалось получить ссылку для подключения. Настроить можно позже через /settings')
      }
    } else {
      await ctx.reply('Google Calendar временно недоступен. Настроить можно позже через /settings')
    }
  }

  // Optional SoloLeveling connection
  if (process.env.SOLO_LEVELING_URL) {
    if (user.solo_leveling_token) {
      // Token already saved — auto-sync silently
      logger.info('[FIX][conversation/onboarding] token exists, auto-syncing SoloLeveling', { userId: user.id })
      await conversation.external(async () => {
        try {
          await syncUserPeriodsToSoloLeveling(user.id)
          logger.info('[FIX][conversation/onboarding] auto-sync done', { userId: user.id })
        } catch (err) {
          const code = (err as { code?: number }).code
          logger.error('[FIX][conversation/onboarding] auto-sync failed', { userId: user.id, code, error: err instanceof Error ? err.message : String(err) })
          if (code === 401) {
            await ctx.reply('⚠️ Токен SoloLeveling устарел. Переподключи через /settings → SoloLeveling.')
          }
        }
      })
    } else {
      // No token — ask user
      const slKeyboard = new InlineKeyboard()
        .text('🔗 Подключить', 'sl_connect')
        .text('Пропустить', 'sl_skip')

      await ctx.reply(
        'Хочешь синхронизировать периоды с SoloLeveling? Найди токен в настройках приложения SoloLeveling.',
        { reply_markup: slKeyboard },
      )

      const slCtx = await conversation.waitForCallbackQuery(/^sl_/)
      await slCtx.answerCallbackQuery()
      const slChoice = slCtx.callbackQuery.data
      logger.info('[conversation/onboarding] solo-leveling choice', { userId, slChoice })

      if (slChoice === 'sl_connect') {
        await ctx.reply('Введи токен SoloLeveling:')
        const { text: slToken } = await waitForText(conversation)

        await conversation.external(async () => {
          try {
            await sendPeriodsToSoloLeveling(
              slToken.trim(),
              result!.periods.map((p) => ({
                name: p.name,
                slug: p.slug,
                queue_slug: p.slug,
                start_time: p.start_time,
                end_time: p.end_time,
                days_of_week: p.days_of_week,
              })),
            )
            await updateUser(user.id, { solo_leveling_token: slToken.trim() })
            logger.info('[FIX][conversation/onboarding] token saved and periods synced', { userId: user.id })
          } catch (err) {
            const code = (err as { code?: number }).code
            logger.error('[FIX][conversation/onboarding] SL sync failed', { userId: user.id, code, error: err instanceof Error ? err.message : String(err) })
            throw err
          }
        }).then(
          () => ctx.reply('✅ Периоды переданы в SoloLeveling! Теперь настрой маппинг сфер в настройках SoloLeveling.'),
          (err) => {
            const code = (err as { code?: number }).code
            if (code === 401) {
              return ctx.reply('❌ Неверный токен. Проверь токен в настройках SoloLeveling и попробуй снова через /settings')
            }
            return ctx.reply('❌ Не удалось связаться с SoloLeveling. Попробуй позже через /settings')
          },
        )
      }
    }
  }

  await ctx.reply('Готово! Жду тебя утром ☀️\n\nЕсли захочешь изменить настройки — напиши /settings')
}
