// Flow: a side panel of everything Claude needs from you, so you stay in flow while Claude works.
// Free from Beacon Frontier (beaconfrontier.com/flow).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Answer, Card, CardKind, Prefs, ScanStatus } from '../types'
import {
  answersMessage,
  backlogTarget,
  cardRows,
  cardText,
  fileReviewCard,
  findReviewUrls,
  fit,
  isReviewableFile,
  looksLikeSecret,
  merge,
  rank,
  reviewCard,
  splitLinks,
} from './cards'
import { scan } from './scan'

const PANE = 'flow'
const HOME = 'https://beaconfrontier.com/flow'
const TEAL = '#3cc4b4'
// Typed text is drawn in the terminal's own color: on a dark theme a white field hides it, so the fill is slate.
const FIELD_DARK = '#34405c'
const DEFAULT_PREFS: Prefs = { maxCards: 0, scan: 'live', send: 'instant', isStopped: false }
const LIVE_EVERY_MS = 30_000
const LIVE_MIN_GAP_MS = 120_000
const TURN_MIN_GAP_MS = 45_000

const cards = atom({ plugin: 'flow', key: 'cards' } as const, [] as Card[], { shape: 'cards-1' })
const answers = atom({ plugin: 'flow', key: 'answers' } as const, [] as Answer[], { shape: 'answers-1' })
const prefs = atom({ plugin: 'flow', key: 'prefs' } as const, DEFAULT_PREFS, { shape: 'prefs-2' })
const status = atom({ plugin: 'flow', key: 'status' } as const, { isScanning: false, lastAt: 0, note: '' } as ScanStatus)
const openCard = atom({ plugin: 'flow', key: 'openCard' } as const, '')
const picks = atom({ plugin: 'flow', key: 'picks' } as const, {} as Record<string, string[]>, { shape: 'picks-1' })
const showSettings = atom({ plugin: 'flow', key: 'showSettings' } as const, false)
const isTurnRunning = atom({ plugin: 'flow', key: 'isTurnRunning' } as const, false)
const cleared = atom({ plugin: 'flow', key: 'cleared' } as const, 0)
const answered = atom({ plugin: 'flow', key: 'answered' } as const, [] as string[], { shape: 'answered-1' })
const held = atom({ plugin: 'flow', key: 'held' } as const, [] as Card[], { shape: 'held-1' })
const skipped = atom({ plugin: 'flow', key: 'skipped' } as const, [] as string[], { shape: 'skipped-1' })
// Off for this session: no panel, no scans, no live cards. Set at start from FLOW_AUTOSTART; /flow turns it on.
const isOff = atom({ plugin: 'flow', key: 'isOff' } as const, false)

/** FLOW_AUTOSTART=off (or 0, false, no) in the machine's settings env: each session starts with Flow off. */
function startsOff(value: string | undefined): boolean {
  return ['off', '0', 'false', 'no'].includes((value ?? '').trim().toLowerCase())
}

const KIND: Record<CardKind, { glyph: string; label: string; color: string }> = {
  decision: { glyph: '◆', label: 'DECIDE', color: TEAL },
  choice: { glyph: '◇', label: 'PICK', color: '#e0b36a' },
  text: { glyph: '✎', label: 'TELL ME', color: 'suggestion' },
  login: { glyph: '⚿', label: 'SIGN IN', color: 'permission' },
  key: { glyph: '⚷', label: 'API KEY', color: 'warning' },
  review: { glyph: '◉', label: 'REVIEW', color: 'success' },
  action: { glyph: '▸', label: 'DO THIS', color: 'claude' },
}

const PLACEHOLDER: Record<CardKind, string> = {
  decision: 'Or type your own answer…',
  choice: 'Something else…',
  text: 'Type your answer… (fn fn to dictate)',
  login: 'A note, e.g. which account (no passwords)',
  key: 'A note (never the key itself)',
  review: 'What should change?',
  action: 'A note, or how it went',
}


const SOURCE_LABEL: Record<Card['source'], string> = {
  prompt: 'from your ask',
  project: 'found in project',
  conversation: 'from the chat',
  upcoming: 'coming up',
  live: 'just now',
}

// Only commands that start a server or deploy: a command that just mentions one (cat .vercel/…) is not.
const SERVER_OR_DEPLOY =
  /^\s*(?:\S+=\S+\s+)*(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|preview|serve)\b|npx\s+(?:next|vite|serve|expo)\b|next\s+(?:dev|start)\b|vite\b|serve\b|expo\s+start\b|python3?\s+-m\s+http\.server\b|vercel(?:\s+deploy|\s+--prod|\s*$|\s+--yes)|netlify\s+deploy\b|wrangler\s+(?:dev|deploy)\b)/

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

// Module state that may reset on a hot reload: a scan counter and unsent typing.
let toolsSinceScan = 0
const drafts = new Map<string, string>()
// Stop bumps the epoch and aborts the running scan: a fork cannot be aborted, so a late result is dropped by epoch.
let scanEpoch = 0
let scanAbort: AbortController | undefined

// ---------- scanning ----------

async function runScan($: EngineInterface, why: string): Promise<void> {
  if ((await read($, isOff)) || (await read($, prefs)).isStopped) return
  const st = await read($, status)
  const startedAt = await $.clock.now()
  // A scan left "running" by a reload mid-scan counts as over after 3 minutes.
  if (st.isScanning && startedAt - st.lastAt < 180_000) return
  await update($, status, () => ({ isScanning: true, lastAt: startedAt, note: why }))
  toolsSinceScan = 0
  const epoch = scanEpoch
  const controller = new AbortController()
  scanAbort = controller
  try {
    const p = await read($, prefs)
    const queue = await read($, cards)
    const skip = await read($, skipped)
    const room = backlogTarget(p.maxCards) - queue.length
    if (room <= 0) {
      const at = await $.clock.now()
      await update($, status, () => ({ isScanning: false, lastAt: at, note: 'queue is full' }))
      return
    }
    const done = [...(await read($, answered)), ...(await read($, answers)).map(a => a.title)]
    const known = [...queue.map(c => c.title), ...done].slice(-80)
    const found = await scan($, Math.min(8, room), known, controller.signal)
    // Stopped while this scan ran: its results and its status write are dropped.
    if (epoch !== scanEpoch || (await read($, prefs)).isStopped) return
    await update($, cards, q => merge(q, found.cards, skip))
    const at = await $.clock.now()
    await update($, status, () => ({ isScanning: false, lastAt: at, note: found.note }))
  } catch (err) {
    if (epoch !== scanEpoch) return
    const at = await $.clock.now()
    await update($, status, () => ({
      isScanning: false,
      lastAt: at,
      note: `scan failed: ${String((err as Error)?.message ?? err).slice(0, 60)}`,
    }))
  }
}

// ---------- answering ----------

async function deliver($: EngineInterface, list: readonly Answer[]): Promise<void> {
  if (list.length === 0) return
  const text = answersMessage(list)
  if (await read($, isTurnRunning)) {
    // Claude is mid-build: the answers join the running turn at its next step.
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    $.ui.toast(`Handed to Claude mid-build ✓ (${list.length})`)
  } else {
    await $.prompt.submit({ text, asUser: true })
    $.ui.toast(`Sent to Claude ✓ (${list.length})`)
  }
}

async function sendAll($: EngineInterface): Promise<void> {
  const list = await read($, answers)
  if (list.length === 0) return
  await update($, answers, () => [])
  await deliver($, list)
}

async function answer($: EngineInterface, card: Card, text: string, isTyped = false): Promise<void> {
  const reply = text.trim()
  if (!reply) return
  if (looksLikeSecret(reply)) {
    $.ui.toast('That looks like a key or token. Put it in your .env file instead; Flow never sends secrets.')
    return
  }
  drafts.delete(card.id)
  await update($, answered, list => [...list.filter(t => t !== card.title), card.title].slice(-150))
  await update($, cards, q => q.filter(c => c.id !== card.id))
  await update($, cleared, n => n + 1)
  await update($, openCard, id => (id === card.id ? '' : id))
  const item: Answer = { cardId: card.id, title: card.title, text: reply }
  // A typed answer goes the moment Enter is pressed; buttons follow the send setting.
  if (isTyped || (await read($, prefs)).send === 'instant') {
    await deliver($, [item])
  } else {
    await update($, answers, list => [...list.filter(a => a.cardId !== card.id), item])
  }
}

async function skip($: EngineInterface, card: Card): Promise<void> {
  await update($, cards, q => q.filter(c => c.id !== card.id))
  await update($, skipped, s => [...s, card.id].slice(-200))
}

async function later($: EngineInterface, card: Card): Promise<void> {
  const now = await $.clock.now()
  await update($, cards, q => q.map(c => (c.id === card.id ? { ...c, createdAt: now } : c)))
}

async function openUrl($: EngineInterface, url: string): Promise<void> {
  try {
    await $.process.run(['open', url], { timeoutMs: 5000 })
  } catch {
    try {
      await $.process.run(['xdg-open', url], { timeoutMs: 5000 })
    } catch {
      $.ui.toast(`Open this: ${url}`)
    }
  }
}

async function dictate($: EngineInterface, card: Card): Promise<void> {
  await $.prompt.fill({ text: `Flow › ${card.title} [flow:${card.id}] → ` })
  $.ui.toast('Speak your answer: Claude Code voice mode, or press fn twice for macOS dictation. Then Enter.')
}

async function savePrefs($: EngineInterface, change: Partial<Prefs>): Promise<void> {
  await update($, prefs, cur => ({ ...cur, ...change }))
  // Kept for the next session too; the panel works the same if this fails.
  await $.store.set('prefs-2', await read($, prefs)).catch(() => undefined)
}

/** Stop everything new: scans, live cards. Cards already on the panel stay and can be answered. */
async function stopFlow($: EngineInterface): Promise<void> {
  scanEpoch += 1
  scanAbort?.abort()
  scanAbort = undefined
  await savePrefs($, { isStopped: true })
  const at = await $.clock.now()
  await update($, status, () => ({ isScanning: false, lastAt: at, note: 'stopped' }))
  $.ui.toast('Flow stopped: no new cards until you continue.')
}

async function continueFlow($: EngineInterface): Promise<void> {
  await savePrefs($, { isStopped: false })
  const waiting = await read($, held)
  const skip = await read($, skipped)
  const before = (await read($, cards)).length
  if (waiting.length > 0) {
    await update($, cards, q => merge(q, waiting, skip))
    await update($, held, () => [])
  }
  const came = (await read($, cards)).length - before
  const at = await $.clock.now()
  await update($, status, s => ({ ...s, isScanning: false, lastAt: at, note: 'continued' }))
  $.ui.toast(`Flow continued.${came > 0 ? ` · ${came} card${came === 1 ? '' : 's'} came in` : ''}`)
  if ((await read($, prefs)).scan !== 'manual') void runScan($, 'continued')
}

async function addLive($: EngineInterface, card: Card): Promise<void> {
  if (await read($, isOff)) return
  if ((await read($, prefs)).isStopped) {
    // Real links Claude made: kept for when the person continues.
    await update($, held, h => (h.some(c => c.id === card.id) ? h : [...h, card].slice(-20)))
    return
  }
  const skip = await read($, skipped)
  const before = (await read($, cards)).length
  await update($, cards, q => merge(q, [card], skip))
  if ((await read($, cards)).length > before) $.ui.toast(`Flow: ${card.title}`)
}

/** Turns Flow on for this session: opens the panel, hands over waiting answers, and looks ahead. */
async function turnOn($: EngineInterface): Promise<void> {
  await update($, isOff, () => false)
  const p = await read($, prefs)
  if (p.send === 'instant') {
    const waiting = await read($, answers)
    if (waiting.length > 0) {
      await update($, answers, () => [])
      await deliver($, waiting).catch(() => undefined)
    }
  }
  if (p.scan !== 'manual') void runScan($, 'turned on')
}

/** Turns Flow off for this session: stops scans and live cards and closes the panel. */
async function turnOff($: EngineInterface): Promise<void> {
  scanEpoch += 1
  scanAbort?.abort()
  scanAbort = undefined
  await update($, isOff, () => true)
  const at = await $.clock.now()
  await update($, status, s => ({ ...s, isScanning: false, lastAt: at, note: 'off' }))
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

export const register: Register = on => {
  // ---------- lifecycle ----------

  on('session.start', async ($, e, next) => {
    const kept = (await $.store.get('prefs-2')) as Partial<Prefs> | undefined
    if (kept && typeof kept === 'object') await update($, prefs, p => ({ ...p, ...kept }))
    await $.command.register({
      name: 'flow',
      description: 'Flow: open the panel of what Claude needs from you',
      argumentHint: '[on | off | scan | send | stop | continue | 1-20 | fit]',
    })
    // FLOW_AUTOSTART=off: off until the person runs /flow in this session. The timers below still run and check it.
    const off = startsOff(await $.env.get('FLOW_AUTOSTART'))
    await update($, isOff, () => off)
    if (!off) void $.ui.open({ id: PANE, title: 'Flow' })
    if (!off && (await read($, prefs)).send === 'instant') {
      const waiting = await read($, answers)
      if (waiting.length > 0) {
        await update($, answers, () => [])
        await deliver($, waiting).catch(() => undefined)
      }
    }

    $.clock.after(3000, () => {
      void read($, prefs).then(p => (p.scan === 'manual' ? undefined : runScan($, 'first look')))
    })
    $.clock.every(LIVE_EVERY_MS, () => {
      void (async () => {
        const p = await read($, prefs)
        if (p.scan !== 'live' || (await read($, isOff)) || !(await read($, isTurnRunning)) || toolsSinceScan < 4) return
        const st = await read($, status)
        if ((await $.clock.now()) - st.lastAt < LIVE_MIN_GAP_MS) return
        await runScan($, 'looking ahead while Claude works')
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'flow' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'off') {
      await turnOff($)
      return { text: 'Flow is off for this session. /flow turns it on.' }
    }
    // Any other /flow turns Flow on first when this session started with it off.
    const wasOff = await read($, isOff)
    if (wasOff) await turnOn($)
    if (arg === 'on') {
      await $.ui.open({ id: PANE, title: 'Flow', focus: true })
      return { text: wasOff ? 'Flow is on for this session.' : 'Flow is already on.' }
    }
    if (arg === 'stop') {
      await stopFlow($)
      return { text: 'Flow stopped. /flow continue starts it again.' }
    }
    if (arg === 'continue' || arg === 'resume' || arg === 'start') {
      await continueFlow($)
      return { text: 'Flow continued.' }
    }
    if (arg === 'scan') {
      if ((await read($, prefs)).isStopped) return { text: 'Flow is stopped. /flow continue starts it again.' }
      void runScan($, 'you asked')
      return { text: 'Flow is looking ahead.' }
    }
    if (arg === 'send') {
      await sendAll($)
      return { text: 'Flow sent your answers.' }
    }
    const n = arg === 'fit' ? 0 : Number.parseInt(arg, 10)
    if (arg && Number.isFinite(n) && n >= 0 && n <= 50) {
      await update($, prefs, p => ({ ...p, maxCards: n }))
      await $.store.set('prefs-2', await read($, prefs)).catch(() => undefined)
    }
    await $.ui.open({ id: PANE, title: 'Flow', focus: true })
    if (wasOff) return { text: 'Flow is on for this session.' }
    return { text: n === 0 && arg === 'fit' ? 'Flow fills the pane.' : 'Flow is open.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isTurnRunning, () => false)
    const p = await read($, prefs)
    const st = await read($, status)
    const now = await $.clock.now()
    const queue = await read($, cards)
    if (p.scan !== 'manual' && !(await read($, isOff)) && (now - st.lastAt > TURN_MIN_GAP_MS || queue.length < backlogTarget(p.maxCards) - 2)) {
      $.clock.after(800, () => {
        void runScan($, 'after the turn')
      })
    }
    return next(e)
  })

  // A spoken or typed answer from the prompt, tagged by the ◖ speak button, clears its card.
  on('prompt.submit', async ($, e, next) => {
    const tag = /\[flow:([a-z0-9]+)\]/.exec(e.text)
    if (tag) {
      const id = tag[1]
      await update($, cards, q => q.filter(c => c.id !== id))
      await update($, cleared, n => n + 1)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Live review links: from what Claude actually does, with no model call.
  on('tool.call', async ($, e, next) => {
    toolsSinceScan += 1
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    try {
      const now = await $.clock.now()
      const tool = String(e.tool)
      const input = e as unknown as Record<string, unknown>
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      if (tool === 'Write' && isReviewableFile(filePath)) {
        await addLive($, fileReviewCard(filePath, now))
      } else {
        const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : ''
        const looks = tool === 'Artifact' || /Output$/.test(tool) || /deploy/i.test(tool) || command.split(/&&|;|\|\|/).some(part => SERVER_OR_DEPLOY.test(part))
        if (looks && typeof ran.text === 'string') {
          for (const f of findReviewUrls(ran.text)) {
            await addLive($, reviewCard(f.url, `${f.label}: take a look`, 'Open it, then say what to change or that it looks good.', now))
          }
        }
      }
    } catch {
      // Detection is a nicety: a failure here never touches the tool call.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---------- drawing ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    const Input = 'Input' in els ? els.Input : undefined

    const width = Math.max(24, (e.props.bodyColumns ?? 44) - 2)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 30
    const p = await read($, prefs)
    const queue = rank(await read($, cards))
    const pending = await read($, answers)
    const st = await read($, status)
    const open = await read($, openCard)
    const chosen = await read($, picks)
    const settings = await read($, showSettings)
    const busy = await read($, isTurnRunning)
    const done = await read($, cleared)
    const now = await $.clock.now()
    // The field stands out: white-framed slate on a dark theme, white with a navy frame on a light one.
    if (await read($, isOff)) {
      return (
        <Box flexDirection="column" width={width}>
          <Text color={TEAL} weight="bold">≈ FLOW</Text>
          <Text dimColor>Flow is off for this session. Run /flow to turn it on.</Text>
        </Box>
      )
    }
    const rowsOfConfig = await $.config.list().catch(() => [])
    const theme = String(rowsOfConfig.find(r => r.key === 'theme')?.value ?? 'dark')
    const isLight = theme.startsWith('light')

    const headerRows = 3 + (pending.length > 0 ? 2 : 0) + (settings ? 5 : 0)
    const footerRows = 3
    const room = Math.max(6, bodyRows - headerRows - footerRows)
    const { shown, waiting } = fit(queue, p.maxCards, room, c => cardRows(c, width, c.id === open, Input !== undefined))
    const blocking = queue.filter(c => c.urgency === 'blocking').length

    const heldCards = await read($, held)
    const setPrefs = (change: Partial<Prefs>) => savePrefs($, change)

    // --- one card ---
    const drawCard = (card: Card) => {
      const k = KIND[card.kind]
      const isOpen = open === card.id
      const urgent = card.urgency === 'blocking'
      const toggle = () => update($, openCard, id => (id === card.id ? '' : card.id))
      const field = (rows: number) =>
        Input ? (
          <Box
            borderStyle="round"
            borderColor={isLight ? '#1e2a44' : 'white'}
            backgroundColor={isLight ? 'white' : FIELD_DARK}
            paddingX={1}
          >
          <Input
            key={`${card.id}:in`}
            rows={rows}
            placeholder={card.placeholder || PLACEHOLDER[card.kind]}
            value={drafts.get(card.id)}
            submitLabel="answer"
            onInput={v => {
              drafts.set(card.id, v)
            }}
            onSubmit={v => void answer($, card, v, true)}
          />
          </Box>
        ) : null
      const copyText = async (press: { surface: Parameters<typeof $.ui.copy>[0]['surface'] }, text: string, done: string) => {
        const res = await $.ui.copy({ text, surface: press.surface })
        $.ui.toast(res.isCopied ? done : `Couldn't copy. Select the ${text === card.url ? 'link' : 'text'} and copy it instead.`)
      }
      const linked = (text: string) =>
        splitLinks(text).map((seg, i) =>
          seg.url ? <Link key={`${card.id}:l${i}`} href={seg.url} label={seg.text} /> : seg.text,
        )
      const urlLine = () => {
        const display = card.url.replace(/^file:\/\//, '')
        return (
          <Box gap={1} flexWrap="wrap">
            <Text weight="bold" color="success" underline>
              <Link href={card.url} label={`➜ ${display}`} />
            </Text>
            <Button
              key={`${card.id}:copyurl`}
              plain
              dimColor
              label="⧉ copy link"
              onPress={press => void copyText(press, card.url, 'Link copied.')}
            />
          </Box>
        )
      }
      const tools = (
        <Box gap={1}>
          <Button
            key={`${card.id}:copycard`}
            plain
            dimColor
            label="⧉ copy"
            onPress={press => void copyText(press, cardText(card), 'Card copied.')}
          />
          <Button key={`${card.id}:mic`} plain dimColor label="◖ speak" onPress={() => void dictate($, card)} />
          <Button key={`${card.id}:later`} plain dimColor label="later" onPress={() => void later($, card)} />
          <Button key={`${card.id}:skip`} plain dimColor label="skip" onPress={() => void skip($, card)} />
        </Box>
      )

      let body: RenderChildren = null
      if (card.kind === 'decision') {
        body = (
          <Box flexDirection="column">
            {card.options.map((o, i) =>
              isOpen ? (
                <Box key={`${card.id}:o${i}`} flexDirection="column">
                  <Text weight="bold">
                    {o.isRecommended ? <Text color={TEAL}>★ </Text> : '  '}
                    {o.label}
                  </Text>
                  {o.pros.map(x => (
                    <Text color="success">{'   + '}{x}</Text>
                  ))}
                  {o.risks.map(x => (
                    <Text color="error">{'   − '}{x}</Text>
                  ))}
                </Box>
              ) : (
                <Text>
                  {o.isRecommended ? <Text color={TEAL}>★ </Text> : '  '}
                  <Text weight="semibold">{o.label}</Text>
                  {o.pros[0] ? <Text color="success">{`  +${o.pros[0]}`}</Text> : ''}
                  {o.risks[0] ? <Text color="error">{`  −${o.risks[0]}`}</Text> : ''}
                </Text>
              ),
            )}
            <Box columnGap={1} rowGap={0} flexWrap="wrap">
              {card.options.map((o, i) => (
                <Button
                  key={`${card.id}:pick${i}`}
                  variant={o.isRecommended ? 'primary' : 'secondary'}
                  label={o.label}
                  onPress={() => void answer($, card, `${o.label}${o.isRecommended ? ' (your recommendation)' : ''}`)}
                />
              ))}
              <Button key={`${card.id}:yours`} dimColor label="your call" onPress={() => void answer($, card, 'Your call: go with your recommendation.')} />
              <Button key={`${card.id}:more`} plain dimColor label={isOpen ? '▴ less' : '▾ pros & risks'} onPress={() => void toggle()} />
            </Box>
          </Box>
        )
      } else if (card.kind === 'choice') {
        const mine = chosen[card.id] ?? []
        body = (
          <Box flexDirection="column">
            <Box columnGap={1} rowGap={0} flexWrap="wrap">
              {card.options.map((o, i) =>
                card.isMulti ? (
                  <Button
                    key={`${card.id}:pick${i}`}
                    variant={mine.includes(o.label) ? 'primary' : 'secondary'}
                    label={`${mine.includes(o.label) ? '☑' : '☐'} ${o.label}`}
                    onPress={() =>
                      void update($, picks, all => {
                        const cur = all[card.id] ?? []
                        const nextList = cur.includes(o.label) ? cur.filter(x => x !== o.label) : [...cur, o.label]
                        return { ...all, [card.id]: nextList }
                      })
                    }
                  />
                ) : (
                  <Button
                    key={`${card.id}:pick${i}`}
                    variant={o.isRecommended ? 'primary' : 'secondary'}
                    label={`${o.isRecommended ? '★ ' : ''}${o.label}`}
                    onPress={() => void answer($, card, o.label)}
                  />
                ),
              )}
              {card.isMulti && (
                <Button key={`${card.id}:done`} variant="primary" label={`Done (${mine.length})`} onPress={() => void answer($, card, mine.join(', ') || 'None of these')} />
              )}
            </Box>
          </Box>
        )
      } else if (card.kind === 'text') {
        body = Input ? null : <Text dimColor>Answer in the chat: tap ◖ speak.</Text>
      } else if (card.kind === 'login') {
        body = (
          <Box flexDirection="column">
            {card.command ? <Text dimColor>{`runs: ! ${card.command}`}</Text> : null}
            {card.url ? urlLine() : null}
            <Box gap={1}>
              <Button
                key={`${card.id}:go`}
                variant="primary"
                label={card.command ? '⚿ Sign in here' : '⚿ Open sign-in ↗'}
                onPress={() => {
                  if (card.command) {
                    void $.prompt.fill({ text: `! ${card.command}` })
                    $.ui.toast('Press Enter in the prompt to sign in. It runs right here.')
                  } else void openUrl($, card.url)
                }}
              />
              {card.command && card.url ? <Button key={`${card.id}:web`} label="web ↗" onPress={() => void openUrl($, card.url)} /> : null}
              <Button key={`${card.id}:ok`} label="Signed in ✓" onPress={() => void answer($, card, 'Done: I signed in.')} />
            </Box>
          </Box>
        )
      } else if (card.kind === 'key') {
        const where = card.envFile || '.env.local'
        body = (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>put it in </Text>
              <Text color={TEAL}>{where}</Text>
              <Text dimColor> as </Text>
              <Text weight="bold">{card.envVar || 'THE_KEY'}=…</Text>
            </Text>
            <Text dimColor>Never paste the key here. It stays on your machine.</Text>
            {card.url ? urlLine() : null}
            <Box gap={1}>
              {card.url ? <Button key={`${card.id}:go`} variant="primary" label="⚷ Get key ↗" onPress={() => void openUrl($, card.url)} /> : null}
              {card.envVar ? (
                <Button
                  key={`${card.id}:copy`}
                  label="copy name"
                  onPress={press => void $.ui.copy({ text: `${card.envVar}=`, surface: press.surface })}
                />
              ) : null}
              <Button key={`${card.id}:ok`} label="Added ✓" onPress={() => void answer($, card, `Done: ${card.envVar || 'the key'} is set in ${where}.`)} />
            </Box>
          </Box>
        )
      } else if (card.kind === 'review') {
        body = (
          <Box flexDirection="column">
            {urlLine()}
            <Box gap={1}>
              <Button key={`${card.id}:go`} variant="primary" label="◉ Open ↗" onPress={() => void openUrl($, card.url)} />
              <Button key={`${card.id}:ok`} label="Looks good ✓" onPress={() => void answer($, card, `Reviewed ${card.url}: looks good.`)} />
            </Box>
          </Box>
        )
      } else {
        body = (
          <Box flexDirection="column">
            {card.url ? urlLine() : null}
            <Box gap={1}>
              {card.url ? <Button key={`${card.id}:go`} variant="primary" label="▸ Open ↗" onPress={() => void openUrl($, card.url)} /> : null}
              <Button key={`${card.id}:ok`} label="Done ✓" onPress={() => void answer($, card, 'Done.')} />
            </Box>
          </Box>
        )
      }

      return (
        <Box key={`${card.id}:card`} flexDirection="column" borderStyle="round" borderColor={urgent ? 'error' : k.color} paddingX={1}>
          <Box justifyContent="space-between">
            <Text>
              <Text color={k.color} weight="bold">
                {k.glyph} {k.label}
              </Text>
              {urgent ? <Text color="error" weight="bold"> · blocking</Text> : <Text dimColor> · {card.urgency === 'later' ? 'later' : 'soon'}</Text>}
            </Text>
            <Text dimColor>{[card.effort, SOURCE_LABEL[card.source]].filter(Boolean).join(' · ')}</Text>
          </Box>
          <Text weight="bold">{linked(card.title)}</Text>
          {card.why ? <Text dimColor>{linked(card.why)}</Text> : null}
          {body}
          {Input ? field(card.kind === 'text' ? 2 : 1) : null}
          {tools}
        </Box>
      )
    }

    // --- the pane ---
    const beacon = st.isScanning ? '◌' : busy ? '◍' : '●'
    const statusLine = p.isStopped
      ? '■ stopped · no new cards until you continue'
      : st.isScanning
      ? `${beacon} looking ahead…`
      : `${beacon} ${st.lastAt ? `looked ${ago(now - st.lastAt)}` : 'warming up'}${st.note ? ` · ${st.note}` : ''}`
    const count = queue.length
    const COUNTS = [1, 2, 3, 6, 10, 20, 0]

    return (
      <Box flexDirection="column" width={width}>
        <Box justifyContent="space-between">
          <Text>
            <Text color={TEAL} weight="bold">≈ FLOW</Text>
            <Text dimColor>{count === 0 ? '  · all clear' : `  · ${count} need${count === 1 ? 's' : ''} you`}</Text>
            {blocking > 0 ? <Text color="error" weight="bold">{` · ${blocking} blocking`}</Text> : null}
          </Text>
          <Box gap={1}>
            {p.isStopped ? (
              <Button key="stop" variant="primary" label={heldCards.length > 0 ? `▶ continue · ${heldCards.length} held` : '▶ continue'} onPress={() => void continueFlow($)} />
            ) : (
              <Button key="stop" plain dimColor label="■ stop" onPress={() => void stopFlow($)} />
            )}
            {p.isStopped ? null : <Button key="scan" plain dimColor label="↻" onPress={() => void runScan($, 'you asked')} />}
            <Button key="gear" plain dimColor label="⚙" onPress={() => void update($, showSettings, v => !v)} />
          </Box>
        </Box>
        <Text dimColor>{statusLine}</Text>

        {settings ? (
          <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
            <Box columnGap={1} rowGap={0} flexWrap="wrap">
              <Text dimColor>show</Text>
              {COUNTS.map(n => (
                <Button
                  key={`max${n}`}
                  variant={p.maxCards === n ? 'primary' : 'secondary'}
                  label={n === 0 ? 'fill' : String(n)}
                  onPress={() => void setPrefs({ maxCards: n })}
                />
              ))}
            </Box>
            <Box columnGap={1} rowGap={0} flexWrap="wrap">
              <Text dimColor>look ahead</Text>
              {(['live', 'turn', 'manual'] as const).map(m => (
                <Button key={`scan-${m}`} variant={p.scan === m ? 'primary' : 'secondary'} label={m === 'live' ? 'while working' : m === 'turn' ? 'after turns' : 'only ↻'} onPress={() => void setPrefs({ scan: m })} />
              ))}
            </Box>
            <Box columnGap={1} rowGap={0} flexWrap="wrap">
              <Text dimColor>answers</Text>
              <Button key="send-batch" variant={p.send === 'batch' ? 'primary' : 'secondary'} label="batch, I send" onPress={() => void setPrefs({ send: 'batch' })} />
              <Button key="send-instant" variant={p.send === 'instant' ? 'primary' : 'secondary'} label="send each" onPress={() => void setPrefs({ send: 'instant' })} />
            </Box>
          </Box>
        ) : null}

        {pending.length > 0 ? (
          <Box gap={1} marginTop={1}>
            <Button key="send" variant="primary" label={`➤ Send ${pending.length} answer${pending.length === 1 ? '' : 's'} to Claude`} onPress={() => void sendAll($)} />
            <Text dimColor>{busy ? 'joins the build now' : 'starts a turn'}</Text>
          </Box>
        ) : null}

        <Box flexDirection="column" marginTop={1}>
          {shown.length === 0 ? (
            <Box flexDirection="column" alignItems="center" paddingY={1}>
              <Text color={TEAL}>·  ✦  ·</Text>
              <Text weight="bold">All clear. Nothing needs you.</Text>
              <Text dimColor>
                {p.isStopped ? 'Flow is stopped. Press ▶ continue for new cards.' : st.isScanning ? 'Looking ahead for what is next…' : 'Claude has what it needs for now.'}
              </Text>
              {done > 0 ? <Text dimColor>{`You cleared ${done} this session.`}</Text> : null}
            </Box>
          ) : (
            shown.map(drawCard)
          )}
          {waiting > 0 ? <Text dimColor>{`  + ${waiting} more queued. Clear one and the next slides in.`}</Text> : null}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Never asks for passwords or key values.</Text>
          <Text dimColor>
            Free from Beacon Frontier · <Link href={HOME} label="☕ buy Dan a coffee" />
          </Text>
        </Box>
      </Box>
    )
  })
}
