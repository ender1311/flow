// Keeps the panel and the chat in step: which questions are the same, and which cards a chat reply answers.
import type { EngineInterface } from 'claude-code'
import type { Card } from '../types'
import { exactMatches, parseChatAnswers, parsePairs } from './cards'
import type { Candidate } from './cards'

// A small, fast model: these calls sit in front of the question dialog.
const MODEL = 'haiku'
const TIMEOUT_MS = 15_000

/**
 * Which of `questions` already sit among `candidates`: question index → candidate id.
 * Exact text first with no model call; the rest in one call. Never throws: a failure keeps the exact matches.
 */
export async function matchQuestions(
  $: EngineInterface,
  questions: readonly string[],
  candidates: readonly Candidate[],
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const found = exactMatches(questions, candidates)
  const open = questions.map((_, i) => i).filter(i => !found.has(i))
  if (open.length === 0 || candidates.length === 0) return found
  try {
    const res = await $.model.complete(
      {
        model: MODEL,
        maxTokens: 400,
        timeoutMs: TIMEOUT_MS,
        system: 'You match questions that ask the same thing. You reply with JSON only.',
        prompt: [
          'Questions:',
          ...open.map(i => `${i}. ${questions[i]}`),
          '',
          'Candidates:',
          ...candidates.map(c => `[${c.id}] ${c.question}`),
          '',
          'Pair a question with a candidate only when the candidate clearly asks the same thing: the same decision, not merely the same topic. Leave out anything you are unsure of.',
          'Reply with JSON only: {"pairs":[{"q":<question number>,"id":"<candidate id>"}]}. No pairs: {"pairs":[]}',
        ].join('\n'),
      },
      signal ? { signal } : undefined,
    )
    if (!res.isAnswered) return found
    for (const [q, id] of parsePairs(res.text, new Set(open), new Set(candidates.map(c => c.id)))) found.set(q, id)
  } catch {
    // The exact matches stand on their own.
  }
  return found
}

/** Which open cards the person's chat reply answers, each with the answer in a short phrase. Never throws. */
export async function matchChatAnswers(
  $: EngineInterface,
  assistantText: string,
  userText: string,
  open: readonly Card[],
): Promise<Array<{ cardId: string; answer: string }>> {
  if (open.length === 0 || !userText.trim()) return []
  try {
    const res = await $.model.complete({
      model: MODEL,
      maxTokens: 400,
      timeoutMs: TIMEOUT_MS,
      system: 'You tell which open questions a reply settles. You reply with JSON only.',
      prompt: [
        'Claude last said (the end of it):',
        '"""',
        assistantText || '(nothing)',
        '"""',
        'The person replied:',
        '"""',
        userText,
        '"""',
        'Open questions on the person\'s side panel:',
        ...open.map(c => `[${c.id}] ${c.title}`),
        '',
        'Which of these open questions does the reply clearly answer? Count one only when the reply really settles it. For each, give the answer as a short phrase (at most 12 words).',
        'Reply with JSON only: {"answers":[{"id":"<question id>","answer":"<short phrase>"}]}. None: {"answers":[]}',
      ].join('\n'),
    })
    if (!res.isAnswered) return []
    return parseChatAnswers(res.text, new Set(open.map(c => c.id)))
  } catch {
    return []
  }
}
