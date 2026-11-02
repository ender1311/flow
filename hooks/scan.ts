// The look-ahead: what Claude needs, or will need, from the person.
import type { EngineInterface } from 'claude-code'
import type { Card } from '../types'
import { envNames, filledEnvNames, parseCards } from './cards'

const SCHEMA = `{"cards":[{
  "kind": "decision | choice | text | login | key | review | action",
  "title": "the ask, as a short question or instruction (max 90 chars)",
  "why": "what it unblocks, in plain words (max 120 chars)",
  "urgency": "blocking | soon | later",
  "source": "prompt | project | conversation | upcoming",
  "effort": "how long it takes the person: 10s, 1m, 5m",
  "options": [{"label": "max 40 chars", "pros": ["..."], "risks": ["..."], "recommended": true}],
  "multi": false,
  "placeholder": "hint for a text answer",
  "url": "the exact page to open (sign-in page, API key dashboard, thing to review)",
  "command": "a CLI login the person runs, e.g. gh auth login, vercel login",
  "envVar": "THE_ENV_VAR_NAME for a key",
  "envFile": ".env.local"
}]}`

function instructions(limit: number, known: readonly string[], digest: string): string {
  return `Find everything Claude needs, or will soon need, from the person to keep this project moving with no waiting. Look at:
1. what the person asked for at the start, and every request since that is not done yet;
2. the project itself (the digest below, plus what you know of the repo): missing config, unset env vars, TBDs, unmade decisions, accounts to sign in to, keys to fetch, things to approve;
3. what is coming next in the work: ask now what will block later.

Card kinds:
- decision: a judgment call. 2-4 options, each with 1-3 short pros and 1-3 short risks; mark exactly one "recommended": true (your pick).
- choice: pick from a short list (set "multi": true when several can apply).
- text: something only the person knows. Give a "placeholder".
- login: they must sign in. Give "command" (a CLI login) and/or "url" (the sign-in page).
- key: they must create an API key. Give the exact dashboard "url", the "envVar" name and the "envFile" it goes in. NEVER ask for the key's value.
- review: something made for them to look at (a page, a local app, a file). "url" is required (http://localhost:PORT, file:///abs/path, or https).
- action: a manual step (DNS, a store console, a payment). Give a "url" when there is one.

Rules:
- Never ask for a password, a one-time code or a secret's value.
- Only what is really needed and not yet answered. No busywork, no "anything else?".
- Anything the person already answered or decided anywhere in the conversation (including "Flow: … answers from the side panel" messages) is settled: never ask it again, not even reworded.
- Do not ask about things already done in the conversation.
- Most blocking first. At most ${limit} cards. Fewer is fine. Zero is fine: {"cards":[]}.
- Plain, short words. No competitor names. No markdown.
${known.length > 0 ? `- Already on the panel, answered or skipped (do not repeat): ${known.map(k => JSON.stringify(k)).join(', ')}` : ''}

${digest ? `Project digest:\n${digest}\n` : ''}
Reply with JSON only, this shape:
${SCHEMA}`
}

/** A short, value-free picture of the project: git, top level, TODOs, env names left unset. */
export async function projectDigest($: EngineInterface): Promise<string> {
  const parts: string[] = []
  try {
    const run = await $.process.run(
      [
        'sh',
        '-c',
        [
          'echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"',
          'echo "changed files:"; git status --short 2>/dev/null | head -20',
          'echo "top level:"; ls -1A 2>/dev/null | grep -v -E "^(node_modules|\\.git|\\.next|dist|build)$" | head -40',
          'echo "open TODO/TBD/FIXME:"; git grep -n -I -E "\\b(TODO|TBD|FIXME)\\b" -- . ":!*.lock" ":!*lock.json" ":!*.min.*" 2>/dev/null | cut -c1-150 | head -30',
        ].join('; '),
      ],
      { timeoutMs: 15000 },
    )
    parts.push(run.stdout.trim())
  } catch {
    // Not a shell we can run: the scan goes on with what the chat holds.
  }
  try {
    let expected: string[] = []
    for (const f of ['.env.example', '.env.sample', '.env.template', '.env.local.example']) {
      if (await $.fs.exists(f)) expected = [...expected, ...envNames(await $.fs.read(f))]
    }
    if (expected.length > 0) {
      const filled = new Set<string>()
      for (const f of ['.env', '.env.local', '.env.development.local']) {
        if (await $.fs.exists(f)) for (const n of filledEnvNames(await $.fs.read(f))) filled.add(n)
      }
      const missing = [...new Set(expected)].filter(n => !filled.has(n))
      if (missing.length > 0) parts.push(`env vars in the example file with no value set yet: ${missing.slice(0, 20).join(', ')}`)
    }
  } catch {
    // Unreadable env files are skipped; their values are never read into the scan.
  }
  return parts.join('\n').slice(0, 6000)
}

export type ScanOutcome = { cards: Card[]; note: string }

/**
 * One look-ahead. Forks over the session's own transcript when there is one
 * (the main thread's cached prefix, so it is cheap and sees the whole chat);
 * before the first turn, asks over the project alone.
 */
export async function scan($: EngineInterface, limit: number, known: readonly string[], signal?: AbortSignal): Promise<ScanOutcome> {
  const digest = await projectDigest($)
  const now = await $.clock.now()
  const ask = instructions(limit, known, digest)
  const fork = await $.model.fork({
    prompt: `[Flow side-panel scan. This is not the person talking and not a turn: do not continue the task, call no tools.]\n\n${ask}`,
  })
  if (fork.isAnswered) {
    const cards = parseCards(fork.text, now)
    return { cards, note: cards.length > 0 ? `found ${cards.length}` : 'nothing new' }
  }
  if (fork.reason !== 'nothing-to-fork') return { cards: [], note: `scan failed (${fork.reason})` }
  if (!digest) return { cards: [], note: 'waiting for the first prompt' }
  const solo = await $.model.complete({
    model: 'sonnet',
    maxTokens: 2500,
    system: 'You audit a software project for the things its owner must supply before an AI coding assistant can finish the work. You reply with JSON only.',
    prompt: ask,
  }, signal ? { signal } : undefined)
  if (!solo.isAnswered) return { cards: [], note: `scan failed (${solo.reason})` }
  const cards = parseCards(solo.text, now)
  return { cards, note: cards.length > 0 ? `found ${cards.length} in the project` : 'nothing new' }
}
