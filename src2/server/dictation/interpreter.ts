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

export interface InterpreterConfig {
  apiKey: string
  model: string
  baseUrl?: string
  deadlineMs?: number
  /**
   * Routes a scorer's requests to the provider server that holds the cached
   * prefix: xAI's `x-grok-conv-id` header.
   */
  cacheKey?: string
  /** The scope's tools. Absent means the scoring library's. */
  tools?: readonly Tool[]
  fetch?: typeof fetch
}

export interface AskOption {
  label: string
  actions?: ScoringAction[]
}

/** What one turn of the conversation came to. */
export type Turn =
  | { kind: 'actions'; actions: ScoringAction[]; dropped: Problem[] }
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

/** The one tool dictation adds: a question for the scorer. */
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

  constructor(
    private readonly config: InterpreterConfig,
    context: string,
    readonly transcript: string
  ) {
    this.messages = [
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
      return { kind: 'actions', actions: option.actions, dropped: [] }
    this.messages.push({
      role: 'tool',
      tool_call_id: open.callId,
      content: option.label
    })
    return await this.turn()
  }

  private async turn(): Promise<Turn> {
    const reply = await this.request()
    if ('error' in reply) return { kind: 'error', message: reply.error }
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
      return { kind: 'ask', question, options }
    }
    const actions: ScoringAction[] = []
    const dropped: Problem[] = []
    for (const call of calls) {
      const cleaned = clean(call.function.name, parse(call.function.arguments))
      if ('action' in cleaned) actions.push(cleaned.action)
      else dropped.push(cleaned.problem)
    }
    if (actions.length === 0)
      return {
        kind: 'error',
        message:
          dropped.length > 0
            ? `Nothing usable came back: ${dropped.map(p => p.message).join('; ')}`
            : reply.said === ''
              ? `Nothing to score in "${this.transcript}"`
              : `Nothing to score in "${this.transcript}": ${reply.said}`
      }
    return { kind: 'actions', actions, dropped }
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
    try {
      const response = await (this.config.fetch ?? fetch)(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            ...(this.config.cacheKey == null
              ? {}
              : { 'x-grok-conv-id': this.config.cacheKey })
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: 0,
            // Every sentence comes back as tool calls: actions, or a question.
            // Left to choose, the model has written a call out as text.
            tool_choice: 'required',
            // One sentence is regularly several actions.
            parallel_tool_calls: true,
            tools: [
              ...asOpenAiTools(this.config.tools ?? toolSchema()),
              ASK_SCORER
            ],
            messages: this.messages
          })
        }
      )
      const text = await response.text()
      if (!response.ok)
        return {
          error: `${provider} answered ${response.status}: ${text.slice(0, 200)}`
        }
      const body = parse(text) as {
        choices?: Array<{
          message?: { tool_calls?: ToolCall[]; content?: string | null }
        }>
      } | null
      const message = body?.choices?.[0]?.message
      return {
        calls: message?.tool_calls ?? [],
        said: (message?.content ?? '').trim().slice(0, 300)
      }
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
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
