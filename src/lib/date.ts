/**
 * Returns current date string and ISO day-of-week number (1=Mon…7=Sun) in the given timezone.
 */
export function getTodayInTimezone(timezone: string): { date: string; dayOfWeek: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const date = formatter.format(new Date()) // "YYYY-MM-DD" (en-CA locale)

  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  })
  const dayName = dayFormatter.format(new Date())

  // ISO week numbering: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
  const dayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  }
  const dayOfWeek = dayMap[dayName] ?? 1

  return { date, dayOfWeek }
}
