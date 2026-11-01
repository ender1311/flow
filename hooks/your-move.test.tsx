import { expect, mock, test } from 'claude-code/testing'

import { cardRows, fileReviewCard, findReviewUrls, fit, parseCards, rank } from './cards'

const PANE = {
  plugin: 'your-move',
  component: 'Pane',
  requestId: 'your-move',
  props: {
    title: 'Your Move',
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
  on('command.register', () => ({ value: { command: 'yourmove' } }))
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
