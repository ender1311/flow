// Pure logic for Flow: no `$`, so the tests can call it directly.
import type { Answer, Card, CardKind, CardOption, Urgency } from '../types'

const KINDS: readonly CardKind[] = ['decision', 'choice', 'text', 'login', 'key', 'review', 'action']
const URGENCIES: readonly Urgency[] = ['blocking', 'soon', 'later']
const SOURCES = ['prompt', 'project', 'conversation', 'upcoming', 'live'] as const

/** A stable id from what the card asks, so a rescan finds the same card again. */
export function cardId(kind: string, title: string): string {
  const text = `${kind}:${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

const list = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map(x => str(x, 80)).filter(Boolean).slice(0, max) : []

/** Asking for a secret's value is never a card: the person puts it in the file. */
const ASKS_FOR_SECRET = /\b(password|passcode|passphrase|2fa code|otp|one[- ]time code|paste (your|the) (api )?key|enter (your|the) (api )?key|secret value)\b/i

/** Reads the model's reply into cards, dropping anything malformed or unsafe. */
export function parseCards(reply: string, now: number): Card[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return []
  }
  const raw = (data as { cards?: unknown }).cards
  if (!Array.isArray(raw)) return []
  const cards: Card[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const kind = KINDS.includes(o.kind as CardKind) ? (o.kind as CardKind) : 'text'
    const title = str(o.title, 120)
    if (!title || ASKS_FOR_SECRET.test(title)) continue
    const options: CardOption[] = Array.isArray(o.options)
      ? o.options
          .map(op => {
            const p = (typeof op === 'string' ? { label: op } : op) as Record<string, unknown>
            return {
              label: str(p.label, 48),
              pros: list(p.pros, 3),
              risks: list(p.risks ?? p.cons, 3),
              isRecommended: p.recommended === true || p.isRecommended === true,
            }
          })
          .filter(op => op.label)
          .slice(0, 5)
      : []
    const needsOptions = kind === 'decision' || kind === 'choice'
    if (needsOptions && options.length < 2) continue
    if (kind === 'review' && !str(o.url, 2000)) continue
    cards.push({
      id: cardId(kind, title),
      kind,
      title,
      why: str(o.why, 160),
      urgency: URGENCIES.includes(o.urgency as Urgency) ? (o.urgency as Urgency) : 'soon',
      source: (SOURCES as readonly string[]).includes(o.source as string)
        ? (o.source as Card['source'])
        : 'conversation',
      effort: str(o.effort, 12),
      options,
      isMulti: kind === 'choice' && o.multi === true,
      placeholder: str(o.placeholder, 80),
      url: safeUrl(str(o.url, 2000)),
      command: str(o.command, 120),
      envVar: str(o.envVar, 60).replace(/[^A-Z0-9_]/gi, ''),
      envFile: str(o.envFile, 60),
      createdAt: now,
    })
  }
  return cards
}

function safeUrl(url: string): string {
  return /^(https?:\/\/|file:\/\/\/)/i.test(url) ? url : ''
}

const RANK: Record<Urgency, number> = { blocking: 0, soon: 1, later: 2 }

/** Blocking first; reviews jump ahead of other "soon" work; older first after that. */
export function rank(cards: readonly Card[]): Card[] {
  const weight = (c: Card) => RANK[c.urgency] * 2 + (c.kind === 'review' ? 0 : 1)
  return [...cards].sort((a, b) => weight(a) - weight(b) || a.createdAt - b.createdAt)
}

/** Adds new cards to the queue, skipping ones already there or skipped before. */
export function merge(queue: readonly Card[], incoming: readonly Card[], skipped: readonly string[]): Card[] {
  const seen = new Set([...queue.map(c => c.id), ...skipped])
  const out = [...queue]
  for (const card of incoming) {
    if (seen.has(card.id)) continue
    seen.add(card.id)
    out.push(card)
  }
  return out.slice(-60)
}

/** The rows a card takes in the pane at `width` columns, for fitting to the screen. */
export function cardRows(card: Card, width: number, isOpen: boolean, hasInput: boolean): number {
  const inner = Math.max(16, width - 4)
  const lines = (s: string) => (s ? Math.ceil(s.length / inner) : 0)
  let rows = 2 /* border */ + 1 /* kind line */ + lines(card.title) + lines(card.why)
  if (card.kind === 'decision' || card.kind === 'choice') {
    rows += isOpen
      ? card.options.reduce((n, o) => n + 1 + o.pros.length + o.risks.length, 0)
      : card.kind === 'decision'
        ? card.options.length
        : 0
  }
  if (card.url) rows += 1 /* link line */
  if (card.kind === 'login' && card.command) rows += 1 /* "runs: !" line */
  if (card.kind === 'key') rows += 2 /* "put it in" and "never paste" */
  if (hasInput) rows += card.kind === 'text' ? 4 : 3 // the field and its frame
  rows += 1 /* buttons */
  return rows
}

const URL_IN_TEXT = /(?:https?:\/\/|file:\/\/\/)[^\s<>"']+/gi

/** Splits text into plain and link segments; trailing .,;:) stay in the plain text after the link. */
export function splitLinks(text: string): Array<{ text: string; url?: string }> {
  const out: Array<{ text: string; url?: string }> = []
  let last = 0
  const plain = (t: string) => {
    if (!t) return
    const prev = out[out.length - 1]
    if (prev && !prev.url) prev.text += t
    else out.push({ text: t })
  }
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(/[.,;:)]+$/, '')
    const at = m.index ?? 0
    plain(text.slice(last, at))
    if (url.replace(/^(https?:\/\/|file:\/\/\/)/i, '')) out.push({ text: url, url })
    else plain(url)
    plain(m[0].slice(url.length))
    last = at + m[0].length
  }
  plain(text.slice(last))
  return out
}

/** A plain-text version of a card, for copying. Holds no secret: cards never do. */
export function cardText(card: Card): string {
  const lines: string[] = [card.title]
  if (card.why) lines.push(card.why)
  if (card.kind === 'decision' || card.kind === 'choice') {
    for (const o of card.options) {
      lines.push(`- ${o.label}${o.isRecommended ? ' (recommended)' : ''}`)
      for (const x of o.pros) lines.push(`  + ${x}`)
      for (const x of o.risks) lines.push(`  - ${x}`)
    }
  }
  if (card.kind === 'login' && card.command) lines.push(`Run: ! ${card.command}`)
  if (card.kind === 'key') lines.push(`Put it in ${card.envFile || '.env.local'} as ${card.envVar || 'THE_KEY'}=`)
  if (card.url && (card.kind === 'login' || card.kind === 'key' || card.kind === 'review' || card.kind === 'action')) {
    lines.push(`Link: ${card.url}`)
  }
  return lines.filter(Boolean).join('\n')
}

/**
 * Which cards fit: in rank order, while the count stays under `max` (0: no cap)
 * and the rows stay inside `room`. One card always shows.
 */
export function fit(
  cards: readonly Card[],
  max: number,
  room: number,
  rowsOf: (c: Card) => number,
): { shown: Card[]; waiting: number } {
  const shown: Card[] = []
  let used = 0
  for (const card of cards) {
    if (max > 0 && shown.length >= max) break
    const rows = rowsOf(card)
    if (shown.length > 0 && used + rows > room) break
    shown.push(card)
    used += rows
  }
  return { shown, waiting: cards.length - shown.length }
}

/** How many cards a scan should try to keep queued: what shows, plus a few spare. */
export function backlogTarget(max: number): number {
  return max > 0 ? Math.min(24, max + 3) : 12
}

// ---- Review links: found in what Claude does, with no model call ----

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/gi
const ARTIFACT_URL = /\bhttps:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/gi
const PREVIEW_URL = /\bhttps:\/\/[a-z0-9-]+(?:-[a-z0-9]+)*\.vercel\.app\b[^\s"'<>)\]]*/gi

export type Found = { url: string; label: string }

/** URLs worth reviewing in a tool's output: a local app, a published page, a preview. */
export function findReviewUrls(text: string): Found[] {
  const out: Found[] = []
  const seen = new Set<string>()
  const add = (url: string, label: string) => {
    const clean = url
      .replace(/[.,;:]+$/, '')
      .replace('0.0.0.0', 'localhost')
      .replace(/^(https?:\/\/[^/]+)\/$/, '$1')
    if (seen.has(clean)) return
    seen.add(clean)
    out.push({ url: clean, label })
  }
  for (const m of text.matchAll(LOCAL_URL)) add(m[0], 'Local app is running')
  for (const m of text.matchAll(ARTIFACT_URL)) add(m[0], 'Page published')
  for (const m of text.matchAll(PREVIEW_URL)) add(m[0], 'Preview deployed')
  return out.slice(0, 3)
}

/** A file Claude wrote that the person would open to look at. */
export function isReviewableFile(path: string): boolean {
  return /\.(html?|svg|pdf|png|jpe?g|gif|webp|mp4)$/i.test(path) && !/(^|\/)(node_modules|\.next|dist|build|out|coverage)\//.test(path)
}

export function reviewCard(url: string, title: string, why: string, now: number): Card {
  return {
    id: cardId('review', url),
    kind: 'review',
    title,
    why,
    urgency: 'soon',
    source: 'live',
    effort: '1m',
    options: [],
    isMulti: false,
    placeholder: 'What should change? (or say it: fn fn)',
    url,
    command: '',
    envVar: '',
    envFile: '',
    createdAt: now,
  }
}

const baseName = (path: string) => path.split('/').pop() ?? path

export function fileReviewCard(path: string, now: number): Card {
  return reviewCard(`file://${encodeURI(path)}`, `Review ${baseName(path)}`, 'Claude wrote this file for you to look at.', now)
}

// ---- What goes back to Claude ----

export function answersMessage(answers: readonly Answer[]): string {
  const lines = answers.map((a, i) => `${i + 1}. ${a.title}\n   → ${a.text}`)
  return [
    `Flow: ${answers.length === 1 ? 'an answer' : `${answers.length} answers`} from the side panel.`,
    '',
    ...lines,
    '',
    'Use these and carry on. Do not ask these again.',
  ].join('\n')
}

/** Parses `KEY=value` lines into the names that hold a non-empty value. Values never leave. */
export function filledEnvNames(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (m?.[1] && (m[2] ?? '').replace(/^["']|["']$/g, '').trim() !== '') names.add(m[1])
  }
  return names
}

export function envNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)
    if (m?.[1]) names.push(m[1])
  }
  return names
}

// ---- secrets in typed answers ----
// A typed answer that holds a key or token is held back (it belongs in the env file). Any https:// link always goes
// through as it is (Dan, 2026-11-02): links are everyday answers. The rest of the answer is checked for key formats,
// other links that carry a password (postgres://user:pass@…), `NAME_KEY=value` lines, and long random-looking runs.

/** An https link, taken whole: never judged. */
const HTTPS_URL = /\bhttps:\/\/[^\s"'<>]+/gi

/** Known key formats. */
const KEY_FORMATS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, // Anthropic, OpenAI
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe
  /\bwhsec_[A-Za-z0-9+/=]{16,}/, // webhook signing secrets
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/, // Resend
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, // SendGrid
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

/** `STRIPE_SECRET_KEY=…`, `password=…`: an env-style assignment of a secret-named variable. */
const SECRET_ASSIGNMENT = /\b[A-Za-z0-9_]*(?:key|token|secret|password|passwd|pwd)=\S{8,}/i

/** A non-https link with a password before the host: `postgres://user:pass@host`, `redis://:pass@host`. */
const URL_WITH_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i

/** Any other link (`postgres://…`, `file://…`): ids in a path are not secrets. */
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi

/**
 * Random-looking: a piece of 20+ characters (between `-`, `_`, `.` and `/`) mixing capitals, lowercase and digits.
 * Words, slugs, lowercase hex ids (git hashes, UUIDs, Notion ids) and paths don't mix all three, so they pass.
 */
function looksRandom(text: string): boolean {
  for (const run of text.match(/[A-Za-z0-9+/=_.-]{20,}/g) ?? []) {
    for (const piece of run.split(/[-_./]/)) {
      if (piece.length >= 20 && /[A-Z]/.test(piece) && /[a-z]/.test(piece) && /\d/.test(piece)) return true
    }
  }
  return false
}

/** Whether a typed answer holds a key, token or password. https links are never counted. */
export function looksLikeSecret(text: string): boolean {
  const rest = text.replace(HTTPS_URL, ' ')
  if (KEY_FORMATS.some(re => re.test(rest)) || SECRET_ASSIGNMENT.test(rest) || URL_WITH_PASSWORD.test(rest)) return true
  return looksRandom(rest.replace(ANY_URL, ' '))
}
