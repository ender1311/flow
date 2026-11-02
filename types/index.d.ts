/** What kind of thing Claude needs from the person. */
export type CardKind =
  | 'decision' // a judgment call: options with pros and risks, one recommended
  | 'choice' // pick one (or several) of a short list
  | 'text' // something only the person can say
  | 'login' // sign in somewhere: a command to run or a page to open
  | 'key' // get an API key: the page, the env var name, where it goes
  | 'review' // look at something Claude made: a page, a local app, a file
  | 'action' // do a thing by hand: DNS, a store console, a payment

export type Urgency = 'blocking' | 'soon' | 'later'

export type CardOption = {
  label: string
  pros: string[]
  risks: string[]
  isRecommended: boolean
}

export type Card = {
  id: string
  kind: CardKind
  title: string
  why: string
  urgency: Urgency
  /** Where it came from: the first prompt, the project, the chat, what is coming. */
  source: 'prompt' | 'project' | 'conversation' | 'upcoming' | 'live'
  /** How long it takes the person, as a short phrase ("10s", "2m"). */
  effort: string
  options: CardOption[]
  isMulti: boolean
  placeholder: string
  url: string
  command: string
  envVar: string
  envFile: string
  createdAt: number
}

export type Answer = { cardId: string; title: string; text: string }

export type Prefs = {
  /** Most cards on screen; 0 fills the pane and stops at its bottom edge. */
  maxCards: number
  /** `live` scans while Claude works, `turn` after each turn, `manual` on ↻ only. */
  scan: 'live' | 'turn' | 'manual'
  /** `batch` waits for Send; `instant` hands each answer over as it is given. */
  send: 'batch' | 'instant'
}

export type ScanStatus = {
  isScanning: boolean
  lastAt: number
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'flow': {
      cards: Shaped<Card[]>
      answers: Shaped<Answer[]>
      prefs: Shaped<Prefs>
      status: ScanStatus
      openCard: string
      picks: Shaped<Record<string, string[]>>
      showSettings: boolean
      isTurnRunning: boolean
      cleared: number
      skipped: Shaped<string[]>
      /** Titles of cards already answered, so a later look-ahead never asks them again. */
      answered: Shaped<string[]>
    }
  }
}
