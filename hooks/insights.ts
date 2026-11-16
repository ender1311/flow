// Pure logic for the Insights view: no `$`, so the tests can call it directly.
import type { Card, CardKind, Stats } from '../types'

export function emptyStats(): Stats {
  return { days: {}, byKind: {}, panel: 0, chat: 0, typed: 0, buttons: 0, spoken: 0, midBuild: 0, waits: [], ahead: 0, reviews: 0, skipped: 0 }
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const keyOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** The local calendar day of `ms`, as 'YYYY-MM-DD'. */
export function dayKey(ms: number): string {
  return keyOf(new Date(ms))
}

/** The day `n` days after `key` (negative goes back). */
export function shiftKey(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return keyOf(new Date(y!, m! - 1, d! + n))
}

/** Current streak counts back from today, or from yesterday when today has none yet. */
export function streaks(days: Record<string, number>, todayKey: string): { current: number; longest: number } {
  let current = 0
  for (let k = (days[todayKey] ?? 0) > 0 ? todayKey : shiftKey(todayKey, -1); (days[k] ?? 0) > 0; k = shiftKey(k, -1)) current++
  let longest = 0
  for (const k of Object.keys(days)) {
    if ((days[k] ?? 0) <= 0 || (days[shiftKey(k, -1)] ?? 0) > 0) continue
    let run = 0
    for (let d = k; (days[d] ?? 0) > 0; d = shiftKey(d, 1)) run++
    longest = Math.max(longest, run)
  }
  return { current, longest }
}

export function median(waits: readonly number[]): number | undefined {
  if (waits.length === 0) return undefined
  const s = [...waits].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2
}

/** 42s, 3m, 1h; a dash when there is nothing yet. */
export function duration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

/** The day at row (0 = Sunday) and column of a heatmap whose last column is this week. */
export function cellKey(todayMs: number, weeks: number, row: number, col: number): string {
  const today = new Date(todayMs)
  return shiftKey(dayKey(todayMs), row - today.getDay() - (weeks - 1 - col) * 7)
}

/** 7 rows (Sun..Sat) by `weeks` columns of answer counts; null for days after today. */
export function heatmap(days: Record<string, number>, todayMs: number, weeks: number): Array<Array<number | null>> {
  const today = dayKey(todayMs)
  return Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: weeks }, (_, col) => {
      const k = cellKey(todayMs, weeks, row, col)
      return k > today ? null : days[k] ?? 0
    }),
  )
}

/** One answered card counted: the day, its kind, where and how; panel answers also log the wait. */
export function tally(s: Stats, card: Pick<Card, 'kind' | 'source' | 'createdAt'>, now: number, how: 'typed' | 'buttons' | 'spoken' | 'chat'): Stats {
  const day = dayKey(now)
  const isPanel = how !== 'chat'
  return {
    ...s,
    days: { ...s.days, [day]: (s.days[day] ?? 0) + 1 },
    byKind: { ...s.byKind, [card.kind]: (s.byKind[card.kind] ?? 0) + 1 },
    panel: s.panel + (isPanel ? 1 : 0),
    chat: s.chat + (isPanel ? 0 : 1),
    typed: s.typed + (how === 'typed' ? 1 : 0),
    buttons: s.buttons + (how === 'buttons' ? 1 : 0),
    spoken: s.spoken + (how === 'spoken' ? 1 : 0),
    waits: isPanel ? [...s.waits, Math.max(0, now - card.createdAt)].slice(-200) : s.waits,
    ahead: s.ahead + (['prompt', 'project', 'upcoming'].includes(card.source) ? 1 : 0),
  }
}

export const answeredCount = (s: Stats) => s.panel + s.chat

/** A plain-text summary to copy. */
export function summaryText(s: Stats, now: number): string {
  const { current, longest } = streaks(s.days, dayKey(now))
  const kinds = (Object.entries(s.byKind) as Array<[CardKind, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
  return [
    'Flow insights',
    `Answered: ${answeredCount(s)} (panel ${s.panel} · chat ${s.chat})`,
    `Median reply: ${duration(median(s.waits))}`,
    `Mid-build: ${s.midBuild}`,
    `Streak: ${current} day${current === 1 ? '' : 's'} (longest ${longest})`,
    ...(kinds.length > 0 ? [`By kind: ${kinds.join(', ')}`] : []),
    `${s.typed} typed · ${s.buttons} buttons · ${s.spoken} spoken`,
    `${s.ahead} caught ahead · ${s.reviews} review links · ${s.skipped} skipped`,
  ].join('\n')
}
