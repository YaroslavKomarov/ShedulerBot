type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function getConfiguredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  if (raw in LEVELS) return raw as LogLevel
  return 'info'
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[getConfiguredLevel()]
}

function format(level: LogLevel, message: string, data?: unknown): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] ${level.toUpperCase()} ${message}`
  if (data !== undefined) {
    try {
      return `${base} ${JSON.stringify(data)}`
    } catch {
      return `${base} [unserializable data]`
    }
  }
  return base
}

export const logger = {
  debug(message: string, data?: unknown): void {
    if (shouldLog('debug')) console.debug(format('debug', message, data))
  },
  info(message: string, data?: unknown): void {
    if (shouldLog('info')) console.info(format('info', message, data))
  },
  warn(message: string, data?: unknown): void {
    if (shouldLog('warn')) console.warn(format('warn', message, data))
  },
  error(message: string, data?: unknown): void {
    if (shouldLog('error')) console.error(format('error', message, data))
  },
}
