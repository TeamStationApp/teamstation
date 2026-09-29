import { MAX_ASK_OPTIONS } from '../../common/api'
import {
  cleanAction,
  type Problem,
  type ScoringAction,
  type Tool,
  toolSchema
} from '../../common/scoring/actions'
import { DICTATION_VOCABULARY } from '../../common/scoring/vocabulary'

/**
 * Turns what the scorer said into scoring actions, through an LLM.
 *
 * It reads no game and writes none. It is handed the game as text — the
 * context the client built from the screen — and it hands back actions for
 * the client to apply through the same reducer a tap goes through.
 */

export const DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/** How long an LLM may take before the utterance is given up on. */
export const DEADLINE_MS = 180_000

/** How many questions one utterance may ask before it is given up on. */
export const MAX_ASKS = 2

/** How many times a follow-up model is asked for more about one sentence. */
export const MAX_FOLLOW_UPS = 8

/**
 * Words that take back what was scored: "undo that", "scratch that",
 * "take that back". An undo call is kept only when the sentence has them.
 */
const TAKE_BACK =
  /\b(?:undo|undue|un-do|redo|scratch|strike that|take (?:that|it) back|take back|go back|back up|remove|erase|delete|cancel|never ?mind|disregard|reverse|revert|wrong|mistake|oops|correction|start over|no wait|wait no)\b/i

/**
 * A sentence that opens by taking back — "scratch that, it was a called
 * strike", "undo that" — takes back the last thing scored, whether or not
 * the model called undo: nothing before it in the sentence is what it takes
 * back. "Scratch hit" and "scratch single" are plays, not take-backs, and
 * "never mind" may drop only the sentence being said.
 */
const OPENS_WITH_TAKE_BACK =
  /^[\s"'“(]*(?:undo|undue|un-do|scratch (?:that|it|the last)|take (?:that|it) back)\b/i

/** Results a ball in play does not come to. */
const UNBATTED: ReadonlySet<string> = new Set([
  'strikeout',
  'hit_by_pitch',
  'intent_walk',
  'catcher_interference',
  'manual_placement'
])

/** What a model is told when it sent a ball in play and no result for it. */
export const RESULT_MISSING =
  "Recorded. The ball in play has no result. If the scorer's words say how it ended — a hit, an out, an error, a fielder's choice — call result for it now; if they do not, answer with no tool call."

/**
 * What a follow-up model is told of each call it made: everything recorded
 * so far, so a call said twice ("ball, ball") is told from a duplicate.
 */
export function followUp(recorded: readonly ScoringAction[]): string {
  return `Recorded. So far, in order: ${JSON.stringify(recorded)}. Call a tool again only for something the scorer said that is not in that list yet. When all of it is there, answer with no tool call.`
}

export interface InterpreterConfig {
  apiKey: string
  model: string
  baseUrl?: string
  /** OpenAI's chat completions (xAI speaks it too), or Anthropic's messages. */
  api?: 'chat' | 'messages'
  /** Fields the provider needs on every request for this model. */
  body?: Record<string, unknown>
  /**
   * The model makes one call a reply and waits for its result, as GPT does
   * with its reasoning off: each call is answered and the model asked again,
   * until it makes no more.
   */
  followUp?: boolean
  deadlineMs?: number
  /**
   * Routes a scorer's requests to the provider server that holds the cached
   * prefix: xAI's `x-grok-conv-id` header, and OpenAI's `prompt_cache_key`.
   */
  cacheKey?: string
  /**
   * The game goes in the user message, before the scorer's words, rather
   * than in a second system message: GPT caches the fixed prefix only so.
   */
  gameInUserMessage?: boolean
  /** The scope's tools. Absent means the scoring library's. */
  tools?: readonly Tool[]
  fetch?: typeof fetch
}

export interface AskOption {
  label: string
  actions?: ScoringAction[]
}

/**
 * What one turn of the conversation came to. `undo` asks for the last thing
 * scored to be taken back first, as the Undo button does.
 */
export type Turn =
  | {
      kind: 'actions'
      actions: ScoringAction[]
      dropped: Problem[]
      undo?: true
    }
  | { kind: 'ask'; question: string; options: AskOption[] }
  | { kind: 'error'; message: string }

interface OpenAiTool {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

/**
 * The library's tools are in Anthropic's shape; an OpenAI-compatible provider
 * wants each wrapped as a function. The mapping is mechanical, and it follows
 * `toolSchema()` so a new action reaches dictation without a change here.
 */
export function asOpenAiTools(tools: readonly Tool[]): OpenAiTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema
    }
  }))
}

/** A tool dictation adds: taking back the last thing scored. */
export const UNDO: OpenAiTool = {
  type: 'function',
  function: {
    name: 'undo',
    description:
      'The scorer takes back the last thing scored, as the Undo button does: "undo that", "undo that last play", "scratch that", "take that back". Call it once, before anything else said after it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} }
  }
}

/** A tool dictation adds: a question for the scorer. */
export const ASK_SCORER: OpenAiTool = {
  type: 'function',
  function: {
    name: 'askScorer',
    description:
      'Ask the scorer, when the sentence cannot be resolved from the game: a first name two players share, a strikeout the count cannot reach, a play that reads two ways. Offer at most five options. Give an option actions when choosing it settles the whole sentence; leave actions off when the answer only narrows the question.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'options'],
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          maxItems: MAX_ASK_OPTIONS,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label'],
            properties: {
              label: { type: 'string' },
              actions: {
                type: 'array',
                description:
                  'The actions this answer comes to, each an object whose type is one of the other tools and whose fields are that tool’s',
                items: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }
}

const INSTRUCTIONS = `YOUR JOB
Report what just happened as tool calls, one per thing that happened, in order.
Several calls from one sentence are normal.

- Report only what the scorer's sentence says happened. The vocabulary above
  says what words mean; it is not a list of events. Never report a pitch the
  sentence does not mention: "flies out to right" is a ball in play and its
  result, with no pitches before it. Each pitch call is one pitch the
  scorer described; never call pitch once for each of its codes.
- Report every action by calling its tool. Never write a call, or its JSON,
  as text.
- Never report a score, an out count, a count or an at-bat index. The game works
  those out from what you report.
- Never call gameFlow with kind closePlay. The game closes a play by itself
  when the next one begins.
- Players are named by first name and last initial, which is how a scorer says
  them. A scorer may say only the first name. Use the id the game gives for the
  player you mean.
- A number names a player by jersey: "number six", "number 6", "#6", "the
  six" or just "six" is the player the game lists as #6. Look for him among
  the fielders when he handles the ball, and among the batter and runners
  when he hits or runs.
- These scorers barely use position numbers. The one place they do is the
  chain that describes a double play — "six-four-three", "4-6-3 double play"
  — where each digit is a position: 1 pitcher, 2 catcher, 3 first, 4 second,
  5 third, 6 shortstop, 7 left, 8 center, 9 right. Read every other number
  as a jersey.
- A player named by base ("the runner at second") is the one the game says is
  there now.
- A steal names the base taken, and with it the runner: the one on the base
  before it — first for second, second for third, third for home — unless the
  scorer names someone else. "He steals third" with runners on first and
  second is the runner on second; do not ask who. With only one runner on,
  "he steals" or "steals" with no base and no name is that runner stealing
  the next base; do not ask. With two or more runners on, a steal with no
  base and no name does not say who: call askScorer, with an option for each
  runner who could steal and one for a double steal.
- A double or triple steal is one steal for each runner, and each takes only
  the next base: the runner on first steals second, the runner on second
  steals third, the runner on third steals home. With runners on first and
  second it is the runner on second to third and the runner on first to
  second. Report the lead runner's first.
- Credit a fielder only when the scorer named him or his base: "thrown to
  first" names the first baseman. Leave fielders off an out nobody described,
  rather than supplying the usual ones.
- Report what was said and leave the rest to the game, which settles it by
  rule and asks the scorer itself when it cannot: the batter out at first on a
  ground out, the batter safe at first on a fielder's choice and which runner
  was out on it, a runner sent home by a hit scoring, the fielder charged with
  an error. On a fielder's choice, send the ball in play and the result, and a
  runner out only when the scorer said which. Do not call askScorer for any of
  these.
- "Undo that", "undo that last play", "scratch that", "take that back": call
  undo, which takes back the last thing scored as the Undo button does, then
  report anything else the sentence says: "scratch that, it was a called
  strike" is undo and then pitch C. A correction inside the sentence, where
  the scorer takes back words he has just said with "no", "scratch that" or
  "I mean" — "ball, no, scratch that, called strike" — is not undo: report
  only what he settled on, pitch C. Take-back words that open the sentence,
  with nothing earlier in it to take back, take back the last thing scored:
  undo. Without such words every call counts: "ball, called strike" is two
  pitches, B then C. A play's own words — "caught stealing", "picked off",
  "out" — never call undo.
- If you cannot tell who or what, call askScorer instead of guessing. Ask a
  real question about this sentence, with an option for each real answer.`

/**
 * The system prompt: the language, then the job. It is the same for every
 * sentence of every game, so with the tools before it, it is the prefix a
 * provider caches. The game, which changes, follows it (`gamePrompt`).
 */
export function systemPrompt(): string {
  return `You are the scoring interpreter for a youth baseball game. The scorer's words come from a speech recogniser and may contain mistakes. The game as it stands follows, under GAME.

${DICTATION_VOCABULARY}

${INSTRUCTIONS}`
}

/** The game as it stands: a second system message, after the cached one. */
export function gamePrompt(context: string): string {
  return `GAME
${context}`
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * Tool calls a model wrote as text rather than calling: JSON objects, one
 * after another, each naming one of `names` with its fields as
 * `parameters` or `arguments` ({"name": "pitch", "parameters": {"call": "B"}},
 * with or without "type": "function"). Anything else in the text is left.
 */
export function callsWrittenAsText(
  text: string,
  names: ReadonlySet<string>
): ToolCall[] {
  const calls: ToolCall[] = []
  for (let start = text.indexOf('{'); start >= 0;) {
    // The object that opens here, to its matching brace, strings and all.
    let depth = 0
    let inString = false
    let end = -1
    for (let at = start; at < text.length && end < 0; at++) {
      const char = text[at]
      if (inString) {
        if (char === '\\') at++
        else if (char === '"') inString = false
      } else if (char === '"') inString = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) end = at
    }
    if (end < 0) break
    const object = parse(text.slice(start, end + 1))
    const name = object?.name
    const given = object?.parameters ?? object?.arguments
    const fields = typeof given === 'string' ? parse(given) : given
    if (
      typeof name === 'string' &&
      names.has(name) &&
      fields != null &&
      typeof fields === 'object'
    )
      calls.push({
        id: `written_${calls.length + 1}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(fields) }
      })
    start = text.indexOf('{', end + 1)
  }
  return calls
}

/** A closePlay call, which is never the scorer's to report. */
function isClosePlay(call: ToolCall): boolean {
  return (
    call.function.name === 'gameFlow' &&
    parse(call.function.arguments)?.kind === 'closePlay'
  )
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The tool's name is the action's `type`; the arguments are the rest of it. */
function clean(
  name: string,
  args: Record<string, unknown> | null
): { action: ScoringAction } | { problem: Problem } {
  if (args == null)
    return {
      problem: {
        code: 'malformed',
        message: `${name}: arguments are not an object`
      }
    }
  return cleanAction({ ...args, type: name })
}

function optionsOf(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskOption[] = []
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const { label, actions } = item as { label?: unknown; actions?: unknown }
    if (typeof label !== 'string' || label.trim() === '') continue
    const cleaned =
      Array.isArray(actions) && actions.length > 0
        ? actions.map(action => cleanAction(action))
        : []
    // An option keeps its actions only when every one of them cleans.
    const whole =
      cleaned.length > 0 && cleaned.every(result => 'action' in result)
        ? cleaned.map(result => ('action' in result ? result.action : null))
        : null
    options.push(
      whole == null
        ? { label }
        : { label, actions: whole.filter((a): a is ScoringAction => a != null) }
    )
    if (options.length === MAX_ASK_OPTIONS) break
  }
  return options
}

/**
 * One utterance's conversation with the LLM. `start` asks it about the
 * transcript; `answer` resolves a question it asked. It is kept by the route
 * only while a question is open.
 */
export class Interpretation {
  private readonly messages: Message[]
  private asks = 0
  private open: { callId: string; options: AskOption[] } | null = null
  /** What a follow-up model has reported so far. */
  private readonly actions: ScoringAction[] = []
  private readonly dropped: Problem[] = []
  /** Whether the next reply must be a tool call. */
  private required = true
  /** Whether the model called undo for words that take back a play. */
  private undo = false
  /** Whether the model was asked once for a result it left out. */
  private nudged = false

  constructor(
    private readonly config: InterpreterConfig,
    context: string,
    readonly transcript: string
  ) {
    this.messages =
      config.gameInUserMessage === true
        ? [
            { role: 'system', content: systemPrompt() },
            {
              role: 'user',
              content: `${gamePrompt(context)}\n\nTHE SCORER SAID\n${transcript}`
            }
          ]
        : [
            { role: 'system', content: systemPrompt() },
            { role: 'system', content: gamePrompt(context) },
            { role: 'user', content: transcript }
          ]
  }

  /** Whether a question is waiting on the scorer. */
  get asking(): boolean {
    return this.open != null
  }

  async start(): Promise<Turn> {
    return await this.turn()
  }

  /**
   * The scorer chose an option. One that carries actions settles the sentence
   * with no further call; one that does not goes back to the LLM as the
   * question's answer.
   */
  async answer(index: number): Promise<Turn> {
    const open = this.open
    if (open == null) return { kind: 'error', message: 'No question is open' }
    const option = open.options[index]
    if (option == null)
      return { kind: 'error', message: `There is no option ${index}` }
    this.open = null
    if (option.actions != null)
      return {
        kind: 'actions',
        actions: [...this.actions, ...option.actions],
        dropped: [...this.dropped],
        ...(this.undone() ? { undo: true as const } : {})
      }
    this.messages.push({
      role: 'tool',
      tool_call_id: open.callId,
      content: option.label
    })
    return await this.turn()
  }

  private async turn(): Promise<Turn> {
    for (let round = 0; ; round++) {
      const reply = await this.request()
      if ('error' in reply) return { kind: 'error', message: reply.error }
      // A model that wrote its calls out as text, as Grok sometimes does
      // despite being told to call, sometimes beside a call that is never
      // kept — a closePlay, an undo the words did not ask for: those calls,
      // read from the text.
      const written = reply.calls.every(
        call =>
          isClosePlay(call) ||
          (call.function.name === UNDO.function.name &&
            !TAKE_BACK.test(this.transcript))
      )
        ? callsWrittenAsText(reply.said, this.toolNames())
        : []
      const calls = written.length === 0 ? reply.calls : written
      const read = this.read({
        calls,
        said: written.length === 0 ? reply.said : ''
      })
      if (typeof read !== 'number') return read
      // A ball in play sent without its result: asked once for the result,
      // if the words say how it ended.
      const nudge = !this.nudged && calls.length > 0 && this.resultMissing()
      // A follow-up round that adds nothing new means the sentence is done.
      const more =
        this.config.followUp === true && read > 0 && round < MAX_FOLLOW_UPS
      if (!nudge && !more) return this.finished(reply.said)
      if (nudge) this.nudged = true
      // Each call answered, and the model asked for whatever is left.
      this.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: calls
      })
      for (const call of calls)
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: nudge
            ? this.config.followUp === true
              ? `${followUp(this.actions)} ${RESULT_MISSING.replace(/^Recorded\. /, '')}`
              : RESULT_MISSING
            : followUp(this.actions)
        })
      this.required = false
    }
  }

  /** Whether a ball in play the sentence sent has no result after it. */
  private resultMissing(): boolean {
    // In either order: a ball in play sent after its result has one.
    const balls = this.actions.filter(action => action.type === 'ballInPlay')
    const batted = this.actions.filter(
      action => action.type === 'result' && !UNBATTED.has(action.eventType)
    )
    return balls.length > batted.length
  }

  /**
   * One reply: a question, returned as the turn, or actions, kept — the
   * number of new ones. A `closePlay` is never the scorer's to report, and a
   * runner's move already kept is not kept twice.
   */
  private read(reply: { calls: ToolCall[]; said: string }): Turn | number {
    const calls = reply.calls
    const ask = calls.find(
      call => call.function.name === ASK_SCORER.function.name
    )
    if (ask != null) {
      this.asks++
      if (this.asks > MAX_ASKS)
        return {
          kind: 'error',
          message: `The model asked more than ${MAX_ASKS} questions about one sentence`
        }
      const args = parse(ask.function.arguments)
      const question = typeof args?.question === 'string' ? args.question : ''
      const options = optionsOf(args?.options)
      if (question.trim() === '' || options.length === 0)
        return {
          kind: 'error',
          message: 'The model asked a question with no options'
        }
      // Only the question stays in the conversation; its answer is the next message.
      this.messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [ask]
      })
      this.open = { callId: ask.id, options }
      this.required = true
      return { kind: 'ask', question, options }
    }
    let kept = 0
    for (const call of calls) {
      if (call.function.name === UNDO.function.name) {
        // Taking back a play is destructive: only when the words say so.
        if (!TAKE_BACK.test(this.transcript)) {
          this.dropped.push({
            code: 'malformed',
            message: 'An undo the words did not ask for was ignored'
          })
          kept++
          continue
        }
        if (!this.undo) kept++
        this.undo = true
        continue
      }
      const cleaned = clean(call.function.name, parse(call.function.arguments))
      if (!('action' in cleaned)) {
        this.dropped.push(cleaned.problem)
        kept++
        continue
      }
      const { action } = cleaned
      if (action.type === 'gameFlow' && action.kind === 'closePlay') continue
      // A runner's move is the same move for the same runner, base and
      // outcome, whatever fielders it names.
      const move = moveOf(action)
      if (
        move != null &&
        this.actions.some(earlier => moveOf(earlier) === move)
      )
        continue
      this.actions.push(action)
      kept++
    }
    return kept
  }

  /** Whether the scorer took back the last thing scored. */
  private undone(): boolean {
    return this.undo || OPENS_WITH_TAKE_BACK.test(this.transcript)
  }

  /** Every tool this conversation offers, by name. */
  private toolNames(): ReadonlySet<string> {
    return new Set([
      ...(this.config.tools ?? toolSchema()).map(tool => tool.name),
      ASK_SCORER.function.name,
      UNDO.function.name
    ])
  }

  /** The sentence's actions, or why there are none. */
  private finished(said: string): Turn {
    const { actions, dropped } = this
    if (this.undone())
      return {
        kind: 'actions',
        actions: [...actions],
        dropped: [...dropped],
        undo: true
      }
    if (actions.length === 0)
      return {
        kind: 'error',
        message:
          dropped.length > 0
            ? `Nothing usable came back: ${dropped.map(p => p.message).join('; ')}`
            : said === ''
              ? `Nothing to score in "${this.transcript}"`
              : `Nothing to score in "${this.transcript}": ${said.slice(0, 300)}`
      }
    return { kind: 'actions', actions: [...actions], dropped: [...dropped] }
  }

  /** The tool calls, and whatever the LLM wrote instead of calling one. */
  private async request(): Promise<
    { calls: ToolCall[]; said: string } | { error: string }
  > {
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL
    const provider = hostOf(baseUrl)
    const deadlineMs = this.config.deadlineMs ?? DEADLINE_MS
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, deadlineMs)
    const call =
      this.config.api === 'messages'
        ? this.messagesCall(baseUrl)
        : this.chatCall(baseUrl)
    try {
      const response = await (this.config.fetch ?? fetch)(call.url, {
        method: 'POST',
        signal: controller.signal,
        headers: { ...call.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...call.body, ...this.config.body })
      })
      const text = await response.text()
      if (!response.ok)
        return {
          error: `${provider} answered ${response.status}: ${text.slice(0, 200)}`
        }
      return call.read(parse(text))
    } catch (error) {
      if (timedOut)
        return {
          error: `${provider} gave no answer within ${Math.round(deadlineMs / 1000)}s`
        }
      return {
        error: `${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** OpenAI's chat completions, which xAI and OpenAI both answer. */
  private chatCall(baseUrl: string): LlmCall {
    return {
      url: `${baseUrl}/chat/completions`,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...(this.config.cacheKey == null
          ? {}
          : { 'x-grok-conv-id': this.config.cacheKey })
      },
      body: {
        model: this.config.model,
        temperature: 0,
        // Every sentence comes back as tool calls: actions, or a question.
        // Left to choose, the model has written a call out as text. Only a
        // follow-up model, asked for what is left, may answer with none.
        tool_choice: this.required ? 'required' : 'auto',
        // One sentence is regularly several actions.
        parallel_tool_calls: true,
        tools: [
          ...asOpenAiTools(this.config.tools ?? toolSchema()),
          ASK_SCORER,
          UNDO
        ],
        messages: this.messages,
        ...(this.config.cacheKey != null && hostOf(baseUrl) === 'api.openai.com'
          ? { prompt_cache_key: this.config.cacheKey }
          : {})
      },
      read: body => {
        const choices = body?.choices as
          | Array<{
              message?: { tool_calls?: ToolCall[]; content?: string | null }
            }>
          | undefined
        const message = choices?.[0]?.message
        return {
          calls: message?.tool_calls ?? [],
          said: (message?.content ?? '').trim()
        }
      }
    }
  }

  /**
   * Anthropic's messages. The library's tools are already in its shape; the
   * conversation is kept in the chat shape and translated here, and its
   * `tool_use` blocks are read back as the same tool calls.
   */
  private messagesCall(baseUrl: string): LlmCall {
    const [system, game, ...rest] = this.messages
    return {
      url: `${baseUrl}/messages`,
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: this.config.model,
        max_tokens: 4096,
        temperature: 0,
        // The tools and this block are the same for every sentence: cached.
        system: [
          {
            type: 'text',
            text: system.content,
            cache_control: { type: 'ephemeral' }
          },
          { type: 'text', text: game.content }
        ],
        // Any tool, and as many as the sentence needs.
        tool_choice: this.required ? { type: 'any' } : { type: 'auto' },
        tools: [
          ...(this.config.tools ?? toolSchema()),
          ...[ASK_SCORER, UNDO].map(tool => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters
          }))
        ],
        messages: anthropicTurns(rest.map(asAnthropicMessage))
      },
      read: body => {
        const blocks = Array.isArray(body?.content)
          ? (body.content as Array<Record<string, unknown>>)
          : []
        return {
          calls: blocks
            .filter(block => block.type === 'tool_use')
            .map(block => ({
              id: String(block.id),
              type: 'function' as const,
              function: {
                name: String(block.name),
                arguments: JSON.stringify(block.input ?? {})
              }
            })),
          said: blocks
            .filter(block => block.type === 'text')
            .map(block => String(block.text))
            .join(' ')
            .trim()
        }
      }
    }
  }
}

/** A runner's move as a key: who, what kind, to where, out or not. */
function moveOf(action: ScoringAction): string | undefined {
  if (action.type === 'runnerMovement')
    return `move ${action.runner} ${action.to} ${action.out === true}`
  if (action.type === 'baseRunning')
    return `run ${action.kind} ${action.runner} ${action.to ?? ''}`
  return undefined
}

/** One request to an LLM, and how its reply is read. */
interface LlmCall {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  read: (body: Record<string, unknown> | null) => {
    calls: ToolCall[]
    said: string
  }
}

/**
 * Anthropic takes every tool result of one turn in a single user message:
 * consecutive tool results are joined.
 */
function anthropicTurns(
  messages: ReadonlyArray<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const results = (message: Record<string, unknown>): unknown[] | null =>
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.every(
      (block: Record<string, unknown>) => block.type === 'tool_result'
    )
      ? message.content
      : null
  const out: Array<Record<string, unknown>> = []
  for (const message of messages) {
    const last = out.at(-1)
    const joined = last == null ? null : results(last)
    const these = results(message)
    if (joined != null && these != null)
      out[out.length - 1] = { role: 'user', content: [...joined, ...these] }
    else out.push(message)
  }
  return out
}

/** A chat-shaped message as Anthropic takes it. */
function asAnthropicMessage(message: Message): Record<string, unknown> {
  if (message.role === 'tool')
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: message.content
        }
      ]
    }
  if (message.role === 'assistant')
    return {
      role: 'assistant',
      content: [
        ...(message.content == null || message.content === ''
          ? []
          : [{ type: 'text', text: message.content }]),
        ...(message.tool_calls ?? []).map(call => ({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parse(call.function.arguments) ?? {}
        }))
      ]
    }
  return { role: 'user', content: message.content }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
