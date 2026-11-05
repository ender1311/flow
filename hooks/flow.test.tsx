import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cardRows, cardText, exactMatches, fileReviewCard, findReviewUrls, fit, looksLikeSecret, parseCards, rank, splitLinks } from './cards'

const PANE = {
  plugin: 'flow',
  component: 'Pane',
  requestId: 'flow',
  props: {
    title: 'Flow',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const reply = JSON.stringify({
  cards: [
    { kind: 'decision', title: 'Postgres or SQLite for v1?', why: 'Schema work is next', urgency: 'blocking',
      options: [{ label: 'Postgres', pros: ['scales'], risks: ['setup'], recommended: true }, { label: 'SQLite', pros: ['zero ops'], risks: ['one writer'] }] },
    { kind: 'decision', title: 'Only one option', options: [{ label: 'A' }] },
    { kind: 'text', title: 'Enter your password for the server' },
    { kind: 'key', title: 'Create a Stripe test key', url: 'https://dashboard.stripe.com/test/apikeys', envVar: 'STRIPE_SECRET_KEY', urgency: 'later' },
    { kind: 'review', title: 'No url review' },
    { kind: 'login', title: 'Sign in to Vercel', command: 'vercel login', url: 'javascript:alert(1)' },
  ],
})

test('parseCards keeps good cards and drops unsafe or malformed ones', () => {
  const cards = parseCards(`Here you go:\n${reply}`, 1)
  expect(cards.map(c => c.title)).toEqual(['Postgres or SQLite for v1?', 'Create a Stripe test key', 'Sign in to Vercel'])
  expect(cards[2]?.url).toBe('')
  expect(cards[0]?.options[0]?.isRecommended).toBe(true)
  expect(parseCards('not json', 1)).toEqual([])
})

test('rank puts blocking first, then reviews', () => {
  const cards = parseCards(reply, 5)
  const review = fileReviewCard('/tmp/site/index.html', 9)
  expect(rank([...cards, review]).map(c => c.kind)).toEqual(['decision', 'review', 'login', 'key'])
})

test('fit stops at the count cap and at the bottom of the pane', () => {
  const cards = parseCards(reply, 1)
  expect(fit(cards, 2, 999, () => 5).shown.length).toBe(2)
  expect(fit(cards, 0, 11, () => 5)).toEqual({ shown: cards.slice(0, 2), waiting: 1 })
  expect(fit(cards, 0, 1, () => 5).shown.length).toBe(1)
  expect(cardRows(cards[0]!, 50, true, true)).toBeGreaterThan(cardRows(cards[0]!, 50, false, true))
})

test('review links are found in dev server and deploy output', () => {
  const out = '  ▲ Next.js 15\n  - Local:        http://localhost:3000\n  - Network: http://0.0.0.0:3000/\nPreview: https://my-app-abc123.vercel.app.'
  expect(findReviewUrls(out).map(f => f.url)).toEqual(['http://localhost:3000', 'https://my-app-abc123.vercel.app'])
})

test('an HTML file Claude writes becomes a review card, on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'flow' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/work/mock/landing.html', content: '<h1>hi</h1>' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Review landing\.html/ }))?.text).toBe('Review landing.html')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'gear' })
  await ui.press({ key: 'send-batch' })
  const card = await ui.find({ type: 'Text', text: /Review landing/ })
  expect(card).toBeDefined()
  const okKey = (await ui.find({ type: 'Button', text: /Looks good/ }))?.key
  expect(okKey).toBeDefined()
  await ui.press({ key: okKey! })
  expect((await ui.find({ type: 'Button', text: /Send 1 answer/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /All clear/ }))).toBeDefined()
  await ui.unmount()
})

test('the settings change how many cards show', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('tool.call', () => ({ result: {} }))
  for (const name of ['a', 'b', 'c']) {
    await $.tool.call({ tool: 'Write', file_path: `/work/${name}.html`, content: 'x' })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'gear' })
  await ui.press({ key: 'max1' })
  expect(await ui.find({ type: 'Text', text: /2 more queued/ })).toBeDefined()
  await ui.unmount()
})

test('every card has a field; typing an answer clears the card, a key is held back', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('tool.call', () => ({ result: {} }))
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.tool.call({ tool: 'Write', file_path: '/work/page.html', content: 'x' })
  const card = fileReviewCard('/work/page.html', 0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: `${card.id}:in`, text: ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_') }) // a made-up key, built so scanners don't flag it
  expect(await ui.find({ type: 'Text', text: /Review page\.html/ })).toBeDefined()
  await ui.input({ key: `${card.id}:in`, text: 'Make the header smaller' })
  expect(sent).toEqual([expect.stringContaining('Make the header smaller')])
  expect(await ui.find({ type: 'Button', text: /Send 1 answer/ })).toBeUndefined()
  await ui.unmount()
})

test('only commands that start a server or deploy are read for review links', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_, e) => ({ result: {}, text: 'see https://myapp.vercel.app and http://localhost:3000' }) as never)
  await $.tool.call({ tool: 'Bash', command: 'cat .vercel/project.json docs/adding-an-app.md' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /All clear/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: 'cd web && npm run dev' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Local app is running/ })).toBeDefined()
  await ui.unmount()
})

test('splitLinks finds URLs and leaves trailing punctuation in the text', () => {
  expect(splitLinks('Open https://a.dev/x now')).toEqual([
    { text: 'Open ' },
    { text: 'https://a.dev/x', url: 'https://a.dev/x' },
    { text: ' now' },
  ])
  expect(splitLinks('See https://a.dev/x.')).toEqual([
    { text: 'See ' },
    { text: 'https://a.dev/x', url: 'https://a.dev/x' },
    { text: '.' },
  ])
  expect(splitLinks('no links here')).toEqual([{ text: 'no links here' }])
  expect(splitLinks('Look at file:///tmp/a.html (done)')).toEqual([
    { text: 'Look at ' },
    { text: 'file:///tmp/a.html', url: 'file:///tmp/a.html' },
    { text: ' (done)' },
  ])
})

test('cardText makes a plain-text copy of a card', () => {
  const [decision, key] = parseCards(reply, 1).filter(c => c.kind === 'decision' || c.kind === 'key')
  expect(cardText(decision!)).toBe(
    ['Postgres or SQLite for v1?', 'Schema work is next', '- Postgres (recommended)', '  + scales', '  - setup', '- SQLite', '  + zero ops', '  - one writer'].join('\n'),
  )
  expect(cardText(key!)).toBe(
    ['Create a Stripe test key', 'Put it in .env.local as STRIPE_SECRET_KEY=', 'Link: https://dashboard.stripe.com/test/apikeys'].join('\n'),
  )
})

// ---- regression: links, copy, and row counts ----

const URL_A = 'https://example.com/a'
const mk = (o: Record<string, unknown>) => parseCards(JSON.stringify({ cards: [{ title: 'T', ...o }] }), 1)[0]!
const linkCards = parseCards(
  JSON.stringify({
    cards: [
      { kind: 'review', title: 'Look at the page', url: 'file:///tmp/page.html', urgency: 'blocking' },
      { kind: 'login', title: 'Sign in to Vercel', command: 'vercel login', url: 'https://vercel.com/login', urgency: 'blocking' },
      { kind: 'key', title: 'Create a Stripe test key', url: 'https://dashboard.stripe.com/test/apikeys', envVar: 'STRIPE_SECRET_KEY', urgency: 'blocking' },
      { kind: 'action', title: 'Verify the domain', url: 'https://example.com/domain', urgency: 'blocking' },
      { kind: 'text', title: 'Read https://example.com/guide before answering', why: 'Details at https://example.com/why.', urgency: 'blocking' },
      { kind: 'decision', title: 'Postgres or SQLite for v1?', why: 'Schema work is next', urgency: 'blocking',
        options: [{ label: 'Postgres', pros: ['scales'], risks: ['setup'], recommended: true }, { label: 'SQLite', pros: ['zero ops'], risks: ['one writer'] }] },
    ],
  }),
  1,
)

async function mountWithCards($: Engine, on: Parameters<typeof mock.store>[0], copied: string[]) {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: JSON.stringify({ cards: linkCards }) } }) as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 200 } }, surface: 'terminal' })
  await ui.press({ key: 'gear' })
  await ui.press({ key: 'max20' })
  await ui.press({ key: 'scan' })
  return ui
}

test('every card with a URL draws a Link to it, a copy-link button and its Open button', async ($, on) => {
  const ui = await mountWithCards($, on, [])
  const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  for (const c of linkCards.filter(x => x.url)) {
    expect(hrefs).toContain(c.url)
    expect(await ui.find({ type: 'Button', key: `${c.id}:copyurl`, text: '⧉ copy link' })).toBeDefined()
  }
  expect(await ui.find({ type: 'Button', text: /Open ↗|◉ Open|Open sign-in/ })).toBeDefined()
  for (const [kind, label] of [['review', /◉ Open ↗/], ['login', /web ↗/], ['key', /Get key ↗/], ['action', /▸ Open ↗/]] as const) {
    const c = linkCards.find(x => x.kind === kind)!
    const b = await ui.find({ type: 'Button', key: `${c.id}:${kind === 'login' ? 'web' : 'go'}` })
    expect(b?.text).toMatch(label)
  }
  await ui.unmount()
})

test('URLs in a title or why draw as Links', async ($, on) => {
  const ui = await mountWithCards($, on, [])
  const hrefs = (await ui.findAll({ type: 'Link' })).map(l => l.props.href)
  expect(hrefs).toContain('https://example.com/guide')
  expect(hrefs).toContain('https://example.com/why')
  await ui.unmount()
})

test('copy link copies exactly the URL, and copy copies the whole card', async ($, on) => {
  const copied: string[] = []
  const ui = await mountWithCards($, on, copied)
  const key = linkCards.find(c => c.kind === 'key')!
  await ui.press({ key: `${key.id}:copyurl` })
  expect(copied).toEqual([key.url])
  const decision = linkCards.find(c => c.kind === 'decision')!
  await ui.press({ key: `${decision.id}:copycard` })
  expect(copied[1]).toBe(cardText(decision))
  expect(copied).toHaveLength(2)
  await ui.unmount()
})

test('cardRows matches the rows each card kind draws (hand-counted, the test API has no height)', () => {
  // width 50: one-line title, no why. Base = border 2 + kind line 1 + title 1 + buttons 1 = 5.
  expect(cardRows(mk({ kind: 'review', url: URL_A }), 50, false, false)).toBe(6)
  expect(cardRows(mk({ kind: 'login', url: URL_A }), 50, false, false)).toBe(6)
  expect(cardRows(mk({ kind: 'login', command: 'vercel login' }), 50, false, false)).toBe(6)
  expect(cardRows(mk({ kind: 'login', command: 'vercel login', url: URL_A }), 50, false, false)).toBe(7)
  expect(cardRows(mk({ kind: 'key' }), 50, false, false)).toBe(7)
  expect(cardRows(mk({ kind: 'key', url: URL_A }), 50, false, false)).toBe(8)
  expect(cardRows(mk({ kind: 'action' }), 50, false, false)).toBe(5)
  expect(cardRows(mk({ kind: 'action', url: URL_A }), 50, false, false)).toBe(6)
  expect(cardRows(mk({ kind: 'text' }), 50, false, false)).toBe(5)
  expect(cardRows(mk({ kind: 'text' }), 50, false, true)).toBe(9)
  const options = [{ label: 'A', pros: ['x'], risks: ['y'] }, { label: 'B' }]
  expect(cardRows(mk({ kind: 'decision', options }), 50, false, false)).toBe(7)
  expect(cardRows(mk({ kind: 'decision', options }), 50, true, false)).toBe(5 + 3 + 1)
})

// ---- stop / continue ----

const flowCmd = ($: Engine, args: string) =>
  $.command.run({ command: 'flow', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const flush = () =>
  new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(r, 30))

let modelCalls: string[] = []
let release: (() => void) | undefined
let gate = false

async function setupStop($: Engine, on: Parameters<typeof mock.store>[0], opts: { gate?: boolean } = {}) {
  modelCalls = []
  release = undefined
  gate = opts.gate ?? false
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', async () => {
    modelCalls.push('fork')
    if (gate) await new Promise<void>(r => (release = r))
    return { value: { isAnswered: true, text: JSON.stringify({ cards: gate ? linkCards : [] }) } } as never
  })
  on('model.complete', () => {
    modelCalls.push('complete')
    return { value: { isAnswered: true, text: '{"cards":[]}' } } as never
  })
  on('command.register', () => ({ value: { command: 'flow' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return toasts
}

test('stopped: a Write is held, not shown; continue brings it onto the panel', async ($, on) => {
  const toasts = await setupStop($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'stop' })
  expect(toasts).toContain('Flow stopped: no new cards until you continue.')
  expect(await ui.find({ type: 'Button', text: '▶ continue' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '■ stopped · no new cards until you continue' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'scan' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Press ▶ continue for new cards/ })).toBeDefined()

  const before = toasts.length
  await $.tool.call({ tool: 'Write', file_path: '/work/held.html', content: 'x' })
  expect(toasts.length).toBe(before)
  expect(await ui.find({ type: 'Text', text: /Review held\.html/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: '▶ continue · 1 held' })).toBeDefined()

  await ui.press({ key: 'stop' })
  expect(toasts).toContain('Flow continued. · 1 card came in')
  await flush()
  expect(await ui.find({ type: 'Text', text: /Review held\.html/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /■ stop/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /held/ })).toBeUndefined()
  await $.tool.call({ tool: 'Write', file_path: '/work/after.html', content: 'x' })
  expect(await ui.find({ type: 'Text', text: /Review after\.html/ })).toBeDefined()
  await ui.unmount()
})

test('/flow scan while stopped does not call the model; /flow continue works', async ($, on) => {
  await setupStop($, on)
  const stop = await flowCmd($, 'stop')
  expect(stop.text).toBe('Flow stopped. /flow continue starts it again.')
  const scanned = await flowCmd($, 'scan')
  expect(scanned.text).toBe('Flow is stopped. /flow continue starts it again.')
  expect(modelCalls).toEqual([])
  const cont = await flowCmd($, 'continue')
  expect(cont.text).toBe('Flow continued.')
  await flush()
  expect(modelCalls[0]).toBe('fork') // continue starts a fresh scan at once
})

test('the stopped flag survives a new session', async ($, on) => {
  await setupStop($, on)
  await flowCmd($, 'stop')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: '▶ continue' })).toBeDefined()
  await ui.unmount()
})

test('a scan in flight when Stop is pressed adds no cards', async ($, on) => {
  await setupStop($, on, { gate: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scan' })
  expect(modelCalls).toEqual(['fork'])
  await flowCmd($, 'stop')
  release?.()
  await flush()
  expect(await ui.find({ type: 'Text', text: /Postgres or SQLite/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Sign in to Vercel/ })).toBeUndefined()
  await ui.unmount()
})

// ---- off by default: FLOW_AUTOSTART=off in the machine's settings env ----

async function setupOff($: Engine, on: Parameters<typeof mock.store>[0], env: Record<string, string>) {
  modelCalls = []
  gate = false
  mock.env(on, env)
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const opened: string[] = []
  const closed: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', () => {
    modelCalls.push('fork')
    return { value: { isAnswered: true, text: '{"cards":[]}' } } as never
  })
  on('model.complete', () => {
    modelCalls.push('complete')
    return { value: { isAnswered: true, text: '{"cards":[]}' } } as never
  })
  on('command.register', () => ({ value: { command: 'flow' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_, e) => e as never)
  on('turn.complete', (_, e) => e as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return { opened, closed, toasts }
}

test('FLOW_AUTOSTART=off: no panel, no scans, no live cards until /flow', async ($, on) => {
  const { opened, toasts } = await setupOff($, on, { FLOW_AUTOSTART: 'off' })
  expect(opened).toEqual([])
  await $.tool.call({ tool: 'Write', file_path: '/work/quiet.html', content: 'x' })
  expect(toasts.filter(t => t.startsWith('Flow:'))).toEqual([])
  expect(await flowCmd($, 'scan')).toMatchObject({ text: 'Flow is looking ahead.' }) // /flow scan turns it on
  await flush()
  expect(modelCalls[0]).toBe('fork')
  expect(opened).toEqual([])
})

test('FLOW_AUTOSTART=off: /flow turns it on, opens the panel and looks ahead', async ($, on) => {
  const { opened } = await setupOff($, on, { FLOW_AUTOSTART: 'OFF' })
  const ui0 = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui0.find({ type: 'Text', text: /Flow is off for this session/ })).toBeDefined()
  await ui0.unmount()
  expect(modelCalls).toEqual([])
  const res = await flowCmd($, '')
  expect(res.text).toBe('Flow is on for this session.')
  expect(opened).toEqual(['flow'])
  await flush()
  expect(modelCalls).toEqual(['fork'])
  await $.tool.call({ tool: 'Write', file_path: '/work/now.html', content: 'x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Review now\.html/ })).toBeDefined()
  await ui.unmount()
})

test('without FLOW_AUTOSTART the panel opens at start; /flow off closes it and stops live cards', async ($, on) => {
  const { opened, closed } = await setupOff($, on, {})
  expect(opened).toEqual(['flow'])
  const res = await flowCmd($, 'off')
  expect(res.text).toBe('Flow is off for this session. /flow turns it on.')
  expect(closed).toEqual(['flow'])
  await $.tool.call({ tool: 'Write', file_path: '/work/after-off.html', content: 'x' })
  expect((await flowCmd($, 'on')).text).toBe('Flow is on for this session.')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Review after-off\.html/ })).toBeUndefined()
  await ui.unmount()
})

// ---- regression: what counts as a secret in a typed answer ----
// Fake keys are assembled at runtime so no key-shaped string sits in the source (the repo is public, push protection on).
const j = (...parts: string[]) => parts.join('')
const RAND = 'Zx8kQ2mN7pL4vR9tW3yB6cH1dF5gJ0sAe7Uq'

test('links, ids, paths and slugs are not secrets', () => {
  for (const ok of [
    'https://app.notion.com/p/yvproduct/Nigeria-Global-Bible-Month-3e2f1f2d1b9281aeb4cfe9ad4fa8c2b7?source=copy_link',
    'Nigeria-Global-Bible-Month-3e2f1f2d1b9281aeb4cfe9ad4fa8c2b7',
    'use this one: https://www.notion.so/3e2f1f2d1b9281aeb4cfe9ad4fa8c2b7',
    'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit?usp=sharing',
    'https://beacon-frontier-git-feat-admin-viewers-dans-projects-d4d642e1.vercel.app/admin',
    'https://github.com/ender1311/beacon-frontier/pull/44',
    'https://example.com/reset?code=abc123def456ghi789',
    '86816d2f0c1e4b7a9d3f5e6a7b8c9d0e1f2a3b4c',
    'f597f24c-8a8e-4368-932b-0151ff61ad14',
    '/private/tmp/claude-502/-Users-danluk-projects-beacon-frontier/f597f24c-8a8e-4368-932b-0151ff61ad14/scratchpad',
    'redesign-the-homepage-checker-results-page-for-mobile',
    'skills-directory-for-claude-code-plugins',
    'the primary key = customer_id',
    'yes, ship it',
    // Any https link goes through whole, whatever it carries (Dan, 2026-11-02).
    j('https://hooks.slack.com/', 'services/T000/B000/', RAND),
    j('https://api.example.com/v1/data?', 'api_key=', 'abcd1234efgh5678'),
    j('https://example.com/cb?token=', RAND),
    j('https://admin:', 'hunter2hunter2', '@example.com/'),
    j('see https://example.com/', RAND, ' for details'),
  ]) expect(looksLikeSecret(ok), ok).toBe(false)
})

test('keys and tokens outside https links are secrets', () => {
  for (const bad of [
    j('sk-', 'ant-api03-', RAND),
    j('sk', '_live_', RAND),
    j('gh', 'p_', RAND),
    j('github', '_pat_', RAND, '_', RAND),
    j('AK', 'IA', 'QWERTYUIOPASDFGH'),
    j('AI', 'za', 'Sy', RAND.slice(0, 33)),
    j('xo', 'xb-', '1234567890-', RAND),
    j('re', '_AbC12345_', RAND),
    j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', RAND),
    j('-----BEGIN ', 'PRIVATE KEY-----'),
    j('STRIPE_SECRET_KEY', '=', 'abcdef123456'),
    j('postgres://admin:', 'hunter2hunter2', '@db.example.com/app'),
    j('redis://:', 'hunter2hunter2', '@cache.example.com:6379'),
    j('http://admin:', 'hunter2hunter2', '@example.com/'),
    j('https://example.com/docs and the key ', j('sk', '_live_', RAND)),
    RAND,
    j('here it is ', RAND, ' thanks'),
  ]) expect(looksLikeSecret(bad), bad.slice(0, 12)).toBe(true)
})

// ---- one conversation, two places: the panel and the chat share answers ----

const syncCards = parseCards(
  JSON.stringify({
    cards: [
      { kind: 'decision', title: 'Postgres or SQLite for v1?', urgency: 'blocking', options: [{ label: 'Postgres', recommended: true }, { label: 'SQLite' }] },
      { kind: 'text', title: 'Which domain should the site use?', urgency: 'soon' },
    ],
  }),
  1,
)
const dbCard = syncCards[0]!
const domainCard = syncCards[1]!
const CHECK = 'mcp__flow__check'

type Sync = {
  toasts: string[]
  completes: string[]
  dialogs: string[][]
  /** The model's reply by kind of call; undefined fails the call. */
  reply: (kind: 'pairs' | 'chat', prompt: string) => string | undefined
  dialogAnswer: (question: string) => string
  /** What a look-ahead finds. */
  found: typeof syncCards
}

const ask = (...questions: string[]) =>
  ({
    tool: 'AskUserQuestion',
    questions: questions.map(question => ({
      question,
      header: 'Q',
      options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      multiSelect: false,
    })),
  }) as never

async function setupSync($: Engine, on: Parameters<typeof mock.store>[0], env: Record<string, string> = {}): Promise<Sync> {
  const s: Sync = { toasts: [], completes: [], dialogs: [], reply: () => undefined, dialogAnswer: () => 'B', found: syncCards }
  mock.env(on, env)
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.toast', (_, e) => {
    s.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: JSON.stringify({ cards: s.found }) } }) as never)
  on('model.complete', (_, e) => {
    s.completes.push(e.prompt)
    const text = s.reply(/reply settles/.test(e.system ?? '') ? 'chat' : 'pairs', e.prompt)
    return { value: text === undefined ? { isAnswered: false, reason: 'empty-reply' } : { isAnswered: true, text } } as never
  })
  on('session.messages', () =>
    ({
      value: [
        { role: 'user', content: [{ type: 'text', text: 'Build the app' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Should v1 use Postgres or SQLite? And which domain?' }] },
      ],
    }) as never,
  )
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'flow' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const qs = (e as unknown as { questions: Array<{ question: string }> }).questions
    s.dialogs.push(qs.map(q => q.question))
    return { result: { questions: qs, answers: Object.fromEntries(qs.map(q => [q.question, s.dialogAnswer(q.question)])) } } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  if (!env.FLOW_AUTOSTART) {
    await flowCmd($, 'scan')
    await flush()
  }
  s.completes.length = 0
  return s
}

const panel = ($: Engine) => $.ui.mount({ ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 200 } }, surface: 'terminal' })

async function answerOnPanel($: Engine, card: { id: string }, text: string) {
  const ui = await panel($)
  await ui.input({ key: `${card.id}:in`, text })
  await ui.unmount()
}

async function onPanel($: Engine, title: RegExp): Promise<boolean> {
  const ui = await panel($)
  const found = (await ui.find({ type: 'Text', text: title })) !== undefined
  await ui.unmount()
  return found
}

const say = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const checkText = async ($: Engine, questions?: string[]) =>
  String(((await $.tool.call({ tool: CHECK, ...(questions ? { questions } : {}) } as never)) as { result?: unknown }).result)

test('exact text matches with no model call', async ($, on) => {
  expect([...exactMatches(['  Postgres or SQLite for V1 ', 'Other?'], [{ id: 'x', question: 'postgres or sqlite for v1?' }])]).toEqual([[0, 'x']])
  const s = await setupSync($, on)
  await answerOnPanel($, dbCard, 'Postgres')
  const r = await $.tool.call(ask('postgres or SQLite for v1'))
  expect(s.completes).toEqual([])
  expect(s.dialogs).toEqual([])
  expect(r).toMatchObject({ result: { answers: { 'postgres or SQLite for v1': 'Postgres' } } })
})

test('a chat reply that answers an open card clears it, logs it and says so', async ($, on) => {
  const s = await setupSync($, on)
  s.reply = kind => (kind === 'chat' ? JSON.stringify({ answers: [{ id: dbCard.id, answer: 'Postgres' }, { id: 'nope', answer: 'x' }] }) : undefined)
  expect(await onPanel($, /Postgres or SQLite/)).toBe(true)
  await say($, 'Go with Postgres for now')
  await flush()
  expect(s.completes).toHaveLength(1)
  expect(s.completes[0]).toContain('Should v1 use Postgres or SQLite?')
  expect(s.toasts).toContain('Flow: cleared 1 card you answered in chat.')
  expect(await onPanel($, /Postgres or SQLite/)).toBe(false)
  expect(await onPanel($, /Which domain/)).toBe(true)
  expect(await checkText($)).toContain('- Postgres or SQLite for v1? → Postgres')
  // Slash commands and Flow's own messages are never read as answers.
  await say($, '/flow 6')
  await say($, 'Flow: an answer from the side panel.')
  await flush()
  expect(s.completes).toHaveLength(1)
})

test('AskUserQuestion answered in full from a panel answer never opens the dialog', async ($, on) => {
  const s = await setupSync($, on)
  await answerOnPanel($, dbCard, 'Postgres')
  s.reply = kind => (kind === 'pairs' ? '{"pairs":[{"q":0,"id":"0"},{"q":7,"id":"0"},{"q":0,"id":"zz"}]}' : undefined)
  const r = await $.tool.call(ask('Which database should v1 use?'))
  expect(s.dialogs).toEqual([])
  expect(r).toMatchObject({ result: { answers: { 'Which database should v1 use?': 'Postgres' } } })
  expect(s.toasts).toContain("Flow answered Claude's question from what you already told it.")
})

test('AskUserQuestion partly answered: only the new question reaches the dialog', async ($, on) => {
  const s = await setupSync($, on)
  await answerOnPanel($, dbCard, 'Postgres')
  s.reply = kind => (kind === 'pairs' ? '{"pairs":[]}' : undefined)
  s.dialogAnswer = () => 'Lumen'
  const r = await $.tool.call(ask('Postgres or SQLite for v1?', 'What should the app be called?'))
  expect(s.dialogs).toEqual([['What should the app be called?']])
  expect(r).toMatchObject({
    result: {
      questions: [{ question: 'Postgres or SQLite for v1?' }, { question: 'What should the app be called?' }],
      answers: { 'Postgres or SQLite for v1?': 'Postgres', 'What should the app be called?': 'Lumen' },
    },
  })
  expect(await checkText($)).toContain('- What should the app be called? → Lumen')
})

test('an answer in the dialog clears the matching card', async ($, on) => {
  const s = await setupSync($, on)
  s.reply = kind => (kind === 'pairs' ? JSON.stringify({ pairs: [{ q: 0, id: domainCard.id }] }) : undefined)
  s.dialogAnswer = () => 'flow.dev'
  await $.tool.call(ask('Which domain do you want?'))
  expect(s.dialogs).toEqual([['Which domain do you want?']])
  expect(s.toasts).toContain('Flow: cleared 1 card you answered in chat.')
  expect(await onPanel($, /Which domain should/)).toBe(false)
  expect(await onPanel($, /Postgres or SQLite/)).toBe(true)
  expect(await checkText($)).toContain('- Which domain do you want? → flow.dev')
})

test('when the model call fails nothing is cleared and the dialog asks everything', async ($, on) => {
  const s = await setupSync($, on)
  await answerOnPanel($, dbCard, 'Postgres')
  s.reply = () => undefined
  const r = await $.tool.call(ask('Which database should v1 use?', 'Which domain do you want?'))
  expect(s.dialogs).toEqual([['Which database should v1 use?', 'Which domain do you want?']])
  expect(r).toMatchObject({ result: { answers: { 'Which database should v1 use?': 'B', 'Which domain do you want?': 'B' } } })
  expect(s.toasts.filter(t => /cleared|answered Claude/.test(t))).toEqual([])
  expect(await onPanel($, /Which domain should/)).toBe(true)
  await say($, 'flow.dev')
  await flush()
  expect(await onPanel($, /Which domain should/)).toBe(true)
})

test('Flow off: AskUserQuestion goes straight through and check says so', async ($, on) => {
  const s = await setupSync($, on, { FLOW_AUTOSTART: 'off' })
  const r = await $.tool.call(ask('Postgres or SQLite for v1?'))
  expect(s.dialogs).toEqual([['Postgres or SQLite for v1?']])
  expect(r).toMatchObject({ result: { answers: { 'Postgres or SQLite for v1?': 'B' } } })
  expect(s.completes).toEqual([])
  expect(await checkText($, ['Postgres or SQLite for v1?'])).toBe('Flow is off in this session. Ask the person directly.')
})

test('check lists what is answered (unsent too), what waits on the panel and what is not known', async ($, on) => {
  const s = await setupSync($, on)
  expect(await checkText($, [])).toBe(
    ['Waiting on the Flow panel:', '- Postgres or SQLite for v1?', '- Which domain should the site use?'].join('\n'),
  )
  const ui = await panel($)
  await ui.press({ key: 'gear' })
  await ui.press({ key: 'send-batch' })
  await ui.press({ key: `${dbCard.id}:pick0` })
  expect(await ui.find({ type: 'Button', text: /Send 1 answer/ })).toBeDefined()
  await ui.unmount()
  s.reply = kind => (kind === 'pairs' ? '{"pairs":[{"q":0,"id":"ans:0"}]}' : undefined)
  expect(await checkText($, ['Which database for v1?', 'Which domain should the site use', 'What is the app name?'])).toBe(
    [
      'Already answered:',
      '- Postgres or SQLite for v1? → Postgres (your recommendation)',
      '',
      'Waiting on the Flow panel:',
      '- Which domain should the site use?',
      '',
      'Not known yet (ask these):',
      '- What is the app name?',
    ].join('\n'),
  )
  expect(await checkText($)).toBe(
    [
      'Already answered:',
      '- Postgres or SQLite for v1? → Postgres (your recommendation)',
      '',
      'Waiting on the Flow panel:',
      '- Which domain should the site use?',
    ].join('\n'),
  )
  // check only reads: the batched answer still waits to be sent.
  const after = await panel($)
  expect(await after.find({ type: 'Button', text: /Send 1 answer/ })).toBeDefined()
  await after.unmount()
})

test('check with nothing on file says to ask', async ($, on) => {
  const s = await setupSync($, on, { FLOW_AUTOSTART: 'off' })
  s.found = []
  await flowCmd($, 'on')
  await flush()
  s.reply = () => '{"pairs":[]}'
  expect(await checkText($)).toBe('Nothing on file yet. Ask the person.')
})

test('a secret-looking chat answer is never kept', async ($, on) => {
  const s = await setupSync($, on)
  const key = j('sk', '_live_', RAND)
  // A key typed in the chat is not even read.
  await say($, `the domain key is ${key}`)
  await flush()
  expect(s.completes).toEqual([])
  // A key the model hands back as the answer clears the card but is not kept.
  s.reply = kind => (kind === 'chat' ? JSON.stringify({ answers: [{ id: domainCard.id, answer: key }] }) : undefined)
  await say($, 'use the one in the vault')
  await flush()
  expect(await onPanel($, /Which domain should/)).toBe(false)
  // A key typed in the dialog is not kept either.
  s.dialogAnswer = () => key
  await $.tool.call(ask('What is the API token?'))
  const text = await checkText($)
  expect(text).not.toContain(key)
  expect(text).not.toContain('Which domain')
  expect(text).not.toContain('API token')
})
