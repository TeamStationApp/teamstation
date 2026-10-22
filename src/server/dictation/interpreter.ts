import { MAX_ASK_OPTIONS } from '../../common/api'
import {
  type BallInPlayAction,
  cleanAction,
  type Problem,
  type ScoringAction,
  taggedAction,
  type Tool,
  toolSchema,
  untaggedAction
} from '../../common/scoring/actions'
import {
  fieldingIds,
  TAGGED_IDS,
  taggedIds,
  taggedNames,
  withNames,
  writeTag,
  writtenTag
} from '../../common/scoring/playerTags'
import {
  asSaidRosterCommand,
  ROSTER_COMMAND_TYPES,
  type RosterTool,
  type SaidRosterCommand
} from '../../common/scoring/rosterCommands'
import { DICTATION_VOCABULARY } from '../../common/scoring/vocabulary'

/**
 * Turns what the scorer said into scoring actions, through an LLM.
 *
 * It reads no game and writes none. It is handed the game as text — the
 * context the client built from the screen — and it hands back actions for
 * the client to apply through the same reducer a tap goes through, and roster
 * commands as they were said, for the client to find the players of and
 * stage on its roster screen.
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

/**
 * What a model is told, once, of an undo the words did not ask for after
 * calls of its own for the sentence.
 */
export const UNDO_NOT_ASKED =
  "Not undone: undo takes back the scorer's last play, and only when his words say so. Your calls for this sentence stand as sent: do not send them again. If his words say something you have not called yet, call only that now; if not, answer with no tool call."

/** What a model is told when it sent a ball in play and no result for it. */
export const RESULT_MISSING =
  "Recorded. The ball in play has no result. If the scorer's words say how it ended — a hit, an out, an error, a fielder's choice — call result for it now; if they do not, answer with no tool call."

/**
 * What a model is told of a question it asked about a roster change, once a
 * sentence: the screen finds the player, and asks the scorer itself.
 */
export const ROSTER_NOT_ASKED =
  'Not asked: the screen finds the player of a roster change, and asks the scorer itself when it must. Report the change with the roster tools, each player as the scorer said him, except a name one sound off from exactly one player in ROSTERS, which is spelled as ROSTERS spells him. Give the team only if he named it.'

/**
 * What a follow-up model is told of each call it made: everything recorded
 * so far, so a call said twice ("ball, ball") is told from a duplicate.
 */
export function followUp(
  recorded: ReadonlyArray<ScoringAction | SaidRosterCommand>
): string {
  // Each player as the model named him: by his tag.
  const said = recorded.map(item =>
    isRosterCommand(item) ? item : taggedAction(item)
  )
  return `Recorded. So far, in order: ${JSON.stringify(said)}. Call a tool again only for something the scorer said that is not in that list yet. When all of it is there, answer with no tool call.`
}

function isRosterCommand(
  item: ScoringAction | SaidRosterCommand
): item is SaidRosterCommand {
  return (ROSTER_COMMAND_TYPES as readonly string[]).includes(item.type)
}

/**
 * The game as the model reads it: an app from before player tags wrote each
 * player's id, `(id 7)`, and that becomes his tag, as a newer app writes it.
 */
export function withTags(context: string): string {
  return context.replace(/ \(id (\d+)\)/g, (written, id: string) =>
    Number(id) < TAGGED_IDS ? ` ${writtenTag(Number(id))}` : written
  )
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
  /** The scope's roster tools, offered beside its scoring tools. Absent means none. */
  rosterTools?: readonly RosterTool[]
  fetch?: typeof fetch
  /**
   * One model round: the prompt it was shown and the tool calls it returned.
   * The route writes this to the journal. Absent in tests that do not care.
   */
  log?: (exchange: DictationExchange) => void
}

/** One tool call as it is logged: the name and the arguments the model sent. */
export interface LoggedCall {
  name: string
  arguments: unknown
}

/** One message of the prompt, as the model was shown it. */
export interface LoggedMessage {
  role: string
  content: string | null
  toolCallId?: string
  toolCalls?: LoggedCall[]
}

/**
 * What one round of a dictation sent the model, and what it called. `error`
 * is set when the provider never returned calls.
 */
export interface DictationExchange {
  model: string
  messages: LoggedMessage[]
  calls: LoggedCall[]
  said: string
  error?: string
}

/**
 * How much of a message goes on one journal line. systemd's default
 * `LineMax` is 48K, and a longer line is cut in two, which would split a
 * JSON record. A message past this is logged in numbered parts.
 */
const LOG_CONTENT_MAX = 12_000

/**
 * The journal lines for one model round. Each line is one JSON object:
 * `dictation-exchange` names the utterance and the model, `dictation-prompt`
 * is one message of the prompt, and `dictation-calls` is the tool calls and
 * any text the model wrote instead.
 */
export function dictationExchangeLines(
  id: string,
  exchange: DictationExchange
): string[] {
  const lines = [
    JSON.stringify({
      tag: 'dictation-exchange',
      id,
      model: exchange.model,
      ...(exchange.error == null ? {} : { error: exchange.error })
    })
  ]
  exchange.messages.forEach((message, index) => {
    const content = message.content ?? ''
    const parts = chunkLog(content)
    parts.forEach((part, partIndex) => {
      lines.push(
        JSON.stringify({
          tag: 'dictation-prompt',
          id,
          model: exchange.model,
          index,
          ...(parts.length > 1 ? { part: partIndex, parts: parts.length } : {}),
          role: message.role,
          ...(message.toolCallId == null
            ? {}
            : { toolCallId: message.toolCallId }),
          ...(partIndex === 0 && message.toolCalls != null
            ? { toolCalls: message.toolCalls }
            : {}),
          content: part
        })
      )
    })
  })
  lines.push(
    JSON.stringify({
      tag: 'dictation-calls',
      id,
      model: exchange.model,
      calls: exchange.calls,
      said: exchange.said
    })
  )
  return lines
}

/** The journal line for what the socket sent the scorer back. */
export function dictationReplyLine(
  id: string,
  model: string,
  transcript: string,
  turn: Turn
): string {
  return JSON.stringify({
    tag: 'dictation-reply',
    id,
    model,
    transcript,
    turn
  })
}

function chunkLog(text: string): string[] {
  if (text.length <= LOG_CONTENT_MAX) return [text]
  const parts: string[] = []
  for (let at = 0; at < text.length; at += LOG_CONTENT_MAX)
    parts.push(text.slice(at, at + LOG_CONTENT_MAX))
  return parts
}

export interface AskOption {
  label: string
  actions?: ScoringAction[]
  roster?: SaidRosterCommand[]
}

/**
 * What one turn of the conversation came to. `undo` asks for the last thing
 * scored to be taken back first, as the Undo button does. `roster` holds the
 * roster commands the sentence came to, as said, when it came to any: a
 * sentence should be one or the other, and the client refuses one that is
 * both.
 */
export type Turn =
  | {
      kind: 'actions'
      actions: ScoringAction[]
      roster?: SaidRosterCommand[]
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
export function asOpenAiTools(
  tools: ReadonlyArray<Tool | RosterTool>
): OpenAiTool[] {
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
      'The scorer takes back the last thing scored, as the Undo button does: "undo that", "undo that last play", "scratch that", "take that back". Call it once, in the same reply as the calls for anything said after it.',
    parameters: { type: 'object', additionalProperties: false, properties: {} }
  }
}

/** A tool dictation adds: a question for the scorer. */
export const ASK_SCORER: OpenAiTool = {
  type: 'function',
  function: {
    name: 'askScorer',
    description:
      'Ask the scorer, when the sentence cannot be resolved from the game: a first name two players share, a strikeout the count cannot reach, a play that reads two ways. Never about a roster change: the screen finds its players. Offer at most five options. Give an option actions when choosing it settles the whole sentence; leave actions off when the answer only narrows the question.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['about', 'question', 'options'],
      properties: {
        about: {
          type: 'string',
          enum: ['play', 'roster'],
          description:
            'What the sentence is: a play, or a roster change (a substitution, a lineup or a position), whose players the screen finds and asks about itself'
        },
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
                  'The actions or roster changes this answer comes to, each an object whose type is one of the other tools and whose fields are that tool’s',
                items: { type: 'object' }
              }
            }
          }
        }
      }
    }
  }
}

const CHOICE_INSTRUCTIONS = `- Preserve every spoken throw on a fielder's choice, including late throws.
  Each Out runnerMovement names only the chain through that putout. A Safe
  batter runnerMovement must carry fielders for the remaining relay, starting
  with the current ball holder; it does not credit any putout or assist.
  Send this Safe relay after the Out calls that precede its throws.
  If everyone is Safe, carry the entire named relay on the Safe batter.
  When one holder makes consecutive unassisted outs, each Out has just him.
  When the scorer explicitly calls it a fielder's choice, keep that result
  even if everyone is Safe. Send a Safe runnerMovement for each original
  runner he says advanced safely; never invent an out in this case.
  This is an exception to omitting the batter's automatic Safe call: when
  late throws are described, ALWAYS send that Safe batter runnerMovement
  with the full remaining chain, even when nobody was put out. Repeat a
  fielder when the ball comes back to him. Leave reason off a Safe relay;
  it is never Safe from Pickoff. An initial unassisted putout followed by
  3B to 2B to 1B late is Out fielders [3B], then Safe batter fielders
  [3B, 2B, 1B]. A force at home followed by C to 2B to 1B late is Out
  fielders [3B, C], then Safe batter fielders [C, 2B, 1B]. An all-Safe
  3B to 2B to 3B to 2B is Safe batter fielders [3B, 2B, 3B, 2B].`

const INSTRUCTIONS = `YOUR JOB
Report what just happened as tool calls, one per thing that happened, in order.
Several calls from one sentence are normal.

- Report only what the scorer's sentence says happened. The vocabulary above
  says what words mean; it is not a list of events. Never report a pitch the
  sentence does not mention: "flies out to right" is a ball in play and its
  result, with no pitches before it. Each pitch call is one pitch the
  scorer described; never call pitch once for each of its codes. Pitches
  said one after another — "foul ball, swing and a miss, called strike
  three" — are that many pitches, in order; never ask which one happened.
  Strike three, called or swinging, is the strikeout by itself: never send
  a result or an out after it. A batter hit by the pitch — "he beaned him",
  "hit by pitch", "plunked" — is result hit_by_pitch alone: never send a
  pitch or a ballInPlay with it.
- Report every action by calling its tool. Never write a call, or its JSON,
  as text.
- Never report a score, an out count, a count or an at-bat index. The game works
  those out from what you report.
- Never call gameFlow with kind closePlay. The game closes a play by itself
  when the next one begins.
- Players are named by first name and last initial, which is how a scorer says
  them. A scorer may say only the first name. GAME follows each player with
  his tag: in "SS Mike T. #27 ${writeTag('QV2')}", SS is where he plays and QV2 is
  his tag. Wherever a tool takes a player, give his tag, QV2: never a
  jersey, a position, a base or any other number. A tag's digit is part
  of its name and says nothing about bases: QV2 need not be on second,
  and a tag ending in 3 is not on third and does not steal third.
- A number names a player by jersey: "number six", "number 6", "#6", "the
  six" or just "six" is the player the game lists as #6. A counting word is
  that same kind of number: "one", "two", "three", "four", "five", "six",
  "seven", "eight" and "nine", and "number three", are the players listed
  as #1, #2, #3, #4, #5, #6, #7, #8 and #9. Look for him among the fielders
  when he handles the ball, and
  among the batter and runners when he hits or runs. A base is not a number: "steals third" names no #3,
  and the runner on second is whoever the game lists on second, not #2.
- An ordinal is a base, always, and never a jersey and never a player.
  "1st", "2nd" and "3rd", and the words "first", "second" and "third", are
  first base, second base and third base. "Steals 3rd", "steals third",
  "thrown to 2nd", "the runner at 1st" and "at third" name those bases.
  "Third" is not "three": third is the base, three is jersey 3. "2nd" is
  not "two", and "1st" is not "one". Nobody's jersey is 1st, 2nd or 3rd.
  "Third disengagement", "disengaged a third time" and "stepped off a third
  time" are not third base. They are a balk: batteryEvent balk. A balk moves
  every runner up one base by itself. Do not call defensive_indifference,
  and do not send advances.
- "The third baseman", "third baseman", "3rd baseman" and "at third base"
  are the fielder GAME lists at 3B. Give his tag from the Fielders line.
  He is not whoever wears #3, even when the first baseman wears 3. "Caught
  by the third baseman" is that 3B's tag, never the tag of #3. The same for
  the first baseman and "1st base" (the fielder at 1B, not jersey 1) and
  the second baseman and "2nd base" (the fielder at 2B, not jersey 2).
- When the scorer names who made an error — "the shortstop boots it",
  "dropped by the left fielder", "error by the third baseman" — charge that
  fielder. Send ballInPlay with his tag from the Fielders line, result
  field_error, and fieldingPlay with error set to the same tag. "The third
  baseman" there is the fielder at 3B, not whoever wears #3. Do not send the
  error with nobody charged, and do not ask who when he already said.
- These scorers barely use position numbers. The one place they do is the
  chain that describes a double play — "six-four-three", "4-6-3 double play"
  — where each digit is a position: 1 pitcher, 2 catcher, 3 first, 4 second,
  5 third, 6 shortstop, 7 left, 8 center, 9 right. Read every other number
  as a jersey.
- A double play on a ground ball ("double play", "they turn two",
  "six-four-three") is two outs. With a runner on first and no other runner
  said to be out, they are the runner from first out at second and the
  batter out at first. Send the ball in play to the fielder who fielded it,
  its result, and both outs, with only the fielders the scorer said: the
  game credits the usual ones. A double play said with no kind of ball is
  a ground ball. Do not ask which runners were out, who made the throws or
  how the ball was hit. A double play that did not happen — "they couldn't
  turn two", "they try to turn two but the relay is late" — is only the out
  the scorer says. The runner out at second and the batter safe at first is
  result fielders_choice with the runner's out; the batter out at first and
  the runner safe at second ("they only get the batter at first") is result
  field_out with the runner's move to second.
- A player named by base ("the runner at second") is the one the game says is
  there now.
- A steal names the base taken, and with it the runner: the one on the base
  before it — first for second, second for third, third for home — unless the
  scorer names someone else. His tag is the one GAME gives on that base's
  line: "On second: …" for the runner on second.
  - "He steals third", "the runner steals third" or "steals third", with
    runners on first and second, is the runner on second; the runner on
    first stays on first. Do not send him to third, and do not ask who.
  - With only one runner on, "he steals", "and he steals" or "steals",
    with no base and no name, is that runner stealing the next base: a
    runner alone on first steals second. Call baseRunning for him, and
    never ask, not even to confirm.
  - With two or more runners on, a steal with no base and no name does not
    say who: call askScorer, with an option for each runner who could steal
    and one for a double steal.
- A double or triple steal is one steal for each runner, and each takes only
  the next base: the runner on first steals second, the runner on second
  steals third, the runner on third steals home. With runners on first and
  second it is the runner on second to third and the runner on first to
  second. Never both to the same base, and never the runner on first to
  third: that runner steals second. Do not ask. Call the lead runner's
  steal first: third before second, home before third.
  Worked. "Double steal" is baseRunning steal of the runner on the "On
  second" line, to 3B, then baseRunning steal of the runner on the "On
  first" line, to 2B. "He steals third" is only that "On second" runner,
  to 3B. The "On first" runner stays on first. Neither tag is a jersey.
- A steal moves only a runner already on base: the "On first", "On second"
  or "On third" line. Never the batter, not even when he wears #3, his tag
  ends in 3, or ROSTERS says he "bats 3rd". "bats 1st", "bats 2nd" and
  "bats 3rd" are his place in the batting order, not a base he stands on
  and not third base. A double steal is exactly two baseRunning calls, one
  for each of those runners, each to the next base: not the batter, and not
  two runners to third.
- A steal takes one base: "he steals, and scores when the throw gets away"
  is his steal of the next base, then runnerMovement of him to home. The
  throw that gets away is not a wild pitch.
- "Four pitches, a strike", with or without the comma, names one pitch, the
  called strike, plus the rest of the sentence. It is not four pitches and
  it is not three balls and a strike. The word four counts pitches he does
  not call. "Four pitches a strike and he steals second" is exactly one
  pitch C and that steal. pitch B, pitch B, pitch B, pitch C invents three
  balls and is wrong. Do not ask.
- A wild pitch or a passed ball is refused until a pitch is on the at-bat.
  When the count is 0-0, send the pitch first — pitch B unless he called a
  strike or a swing — then batteryEvent with each runner he moved. "Wild
  pitch and he scores from third" at 0-0 is pitch B and batteryEvent
  wild_pitch of the runner on third to home.
- ballInPlay contact is only swing or bunt. A ground ball, grounder or
  grabber is contact swing and trajectory ground_ball, unless he said he
  bunted. Never put ground_ball, line_drive, fly_ball, popup or chopper in
  contact: the play is refused and nothing scores.
- A fielder is his tag from the Fielders line, the tag written after his
  name. Never invent a name, a tag or a placeholder. "Down to third" is the
  player GAME lists at 3B, and the tag on that Fielders entry. A fielder who
  is not a tag in GAME is refused and the whole play is lost.
- Credit a fielder only when the scorer named him or his base: "thrown to
  first" names the first baseman. Leave fielders off an out nobody described,
  rather than supplying the usual ones.
- Report what was said and leave the rest to the game, which settles it by
  rule and asks the scorer itself when it cannot: the batter out at first on a
  ground out, the batter safe at first on a fielder's choice and which runner
  was out on it, a runner the hit's own bases send home scoring. When the
  scorer does not say who made an error, leave that charge off: the game
  asks. On a fielder's choice, send the ball in play and the
  result, and a runner out only when the scorer said which. Do not call
  askScorer for any of these. Safe at first with nobody on is result single
  — a bunt single when he bunted — never fielders_choice. A fielder's choice
  needs a runner already on. Safe at first with a runner on, when the scorer
  does not say that runner was out, is a single too, and the single moves
  him: do not record an out he did not say, and do not send runnerMovement.
  "He bunted down to third and he's safe at first", with a runner on, is
  contact bunt and result single. result fielders_choice is wrong there:
  he never said the runner was out.
  A throw to first the scorer calls late, after a runner is out somewhere
  else, means the batter is safe: result fielders_choice, not field_out.
  "Ground ball to third, out at second, but Sol's throw to first is late"
  is contact swing, trajectory ground_ball, result fielders_choice, and
  runnerMovement of the runner out at second. Send that result. It is not
  undo: do not call undo. Leave that runnerMovement's fielders off: the
  game credits the player the scorer named. Do not send only the third
  baseman. "Ground ball to third. Runner is out at second, but safe at
  first." is the same result fielders_choice, with that runnerMovement.
  Send the result. A sacrifice is only a sentence that says sacrifice, so
  this is not field_out and not a ball with no result. Send one
  runnerMovement, of the runner who was on base. The batter is safe, so he
  is not that runner, and the fielder who took the throw is not a runner.
  "Grounder to third. The throw out to second to Remy, but the throw to
  first is late." is that same fielders_choice: contact swing, the runner
  who was on first out at second, and the result sent. Remy took the throw.
  Leave his fielders off.
  A ground out at first is ballInPlay and result field_out with outBy throw,
  and nothing else. "Grounder to third, and he throws him out at first" is
  that: contact swing, trajectory ground_ball, result field_out, outBy
  throw. The batter being thrown out is the result, not a runnerMovement.
  Do not send runnerMovement for it. Never send a runner
  to the base batter. A runner the scorer says went further than the
  hit's bases took him — "the runner at second scored" on a single — is
  runnerMovement for him. So is a runner the scorer says moved or scored on
  an out: "thrown to first for the out, the runner at third scores" is
  ballInPlay, result field_out and runnerMovement of the runner on third to
  home.
  "Sacrifice bunt to third base, and thrown out at first. But Casey scores."
  is contact bunt, the fielder left off, result field_out with outBy
  throw, and runnerMovement of the runner on third to home. He is not out.
  Thrown out at first is the out, not who fielded the bunt: do not set the
  first baseman. The batter's out is the result: do not send runnerMovement
  for the batter.
  "Sacrifice bunt to the shortstop, and Casey takes third." is contact bunt,
  the shortstop, result field_out with outBy throw, and runnerMovement of
  the runner on second to third, not out.
- Where a ball went — left, left center, center, right center, right field —
  is ballInPlay direction. Left center and right center are the center
  fielder, unless the scorer names someone else. Leave the fielder off when
  he names nobody: the game credits the center fielder. Do not set the
  shortstop, the left fielder or the right fielder for either gap.
  "Pop fly to right center field, it's caught" is direction right_center,
  the fielder left off, and result field_out with outBy catch — never the
  right fielder and never the shortstop. Left center is the same: the
  fielder left off, never the left fielder.
  "Pop fly to right center field, it's caught. Casey tags up and takes third."
  is that same catch, and runnerMovement of the runner on second to third.
  He is not out. Leave the fielder off.
  "Popped up to left center, at the wall, but Sam catches it, robbing the home run."
  is direction left_center, the center fielder the scorer named, and result
  field_out with outBy catch. Robbing the home run is the catch, not result
  home_run.
- A caught foul ball — a foul pop, "foul ball caught by the first baseman" —
  is result field_out with outBy catch and foulCaught true, never an
  ordinary fly out. Leave out who caught it when the scorer does not say;
  do not ask.
- Any caught ball, fair or foul: send ballInPlay first, with fielder set to
  the player who caught it when the scorer named him, then the result.
  Every out, hit or error the scorer says has its result in the same reply:
  "pop up to the shortstop", "pops out to the second baseman", "flies out
  to the left fielder" and "lines out to short" are ballInPlay with that
  fielder and result field_out with outBy catch; "ground out to short" is
  result field_out with outBy throw; "double to right center" is result
  double. "Line drive, triple to right center field, and Casey takes home."
  is direction right_center, trajectory line_drive, the fielder left off,
  and result triple, with runnerMovement of the runner on first to home.
  Not the right fielder, not the shortstop, and not a home run. Only a ball
  in play the words leave unfinished — "ground ball to second", "fly ball to
  deep center", with no out, hit or error said — goes
  alone, with no result.
- A foul tip is a foul ball, pitch F, and cannot be strike three. A foul tip
  caught, with no mitt said, is a caught foul pop — result field_out, outBy
  catch, foulCaught — not strike three. Only a foul tip the scorer says went
  into the catcher's mitt or glove is pitch T. "The bat hits the catcher's
  mitt" is result catcher_interference, not a pitch and not undo. The runner
  advancing is that interference: do not send runnerMovement, and do not
  call undo.
- A ground ball or a bunt to a base — "to third", "to short", "to the
  shortstop" — names the fielder the ball went to. Set ballInPlay fielder
  to his tag. "Thrown out at first" is where the out was, not who fielded.
- A runner thrown out at a base is runnerMovement with out true. Without
  that movement the runner is not out. Fielders are the thrower, then the
  fielder who took the throw there — the catcher at home, the third baseman
  at third, the first baseman at first. At second, the second baseman takes
  the throw when the shortstop or the third baseman fielded the ball, and
  the shortstop takes it when the first baseman or anyone else did. A
  player the scorer names takes that throw instead. The game credits those
  fielders when you leave them off. Do not send a chain you worked out:
  a chain you send is kept, even when it names the wrong fielder, so a guess
  is worse than leaving fielders off. After a caught fly the thrower is the
  fielder who caught it, and he is credited with the putout and the assist.
  "Pop fly to left. The runner tags and is thrown out at home" is ballInPlay
  direction left, result field_out with outBy catch, and runnerMovement of
  the runner on third to home, out true, with fielders left off. "Pop fly to
  left. The runner tags and is thrown out at second" is that catch and
  runnerMovement of the runner on first to second, out true, fielders left
  off. "Pop up to third. The runner tags and is thrown out at second" is
  the same, the ballInPlay fielder the third baseman, and the
  runnerMovement's fielders left off. The second baseman takes the throw.
  Do not set him as the fielder the ball was hit to. On a base hit the
  outfielder for the direction gets the assist, not a putout, and the
  center fielder covers either gap.
  "Single to left center. The runner is thrown out at second" is result
  single, not field_out, and runnerMovement of the runner on first to
  second, out true, fielders left off. Send a fielder only when the scorer
  named him, and then only as the tag copied from the Fielders line.
  Initials, a name and a made-up word are not tags, and any of them drops
  the whole play, so omit that fielder instead.
- A runner caught stealing was thrown out by the catcher. The game credits
  the catcher and the fielder at the base: the third baseman at third, the
  catcher at home, and at second the shortstop, not the second baseman. The
  pitcher gets no assist. Leave fielders off. Do not send them unless the
  scorer named the player. "Caught stealing at second" is the runner on
  first, to second, fielders left off. "Double steal, but Evan is thrown
  out at third" is caught_stealing of the lead runner to third and a steal
  of the runner on first to second, fielders left off. Never invent a tag.
- A pickoff that gets the runner is the pitcher's throw, unless the scorer
  says someone else threw. The first baseman takes it at first, the third
  baseman at third, and the shortstop at second. A pickoff the runner is
  safe on credits nobody. Leave fielders off when the scorer named none.
  "A second pickoff attempt, and he's safe." and
  "Third pickoff attempt and he's still safe." are another safe pickoff of
  the runner already on base, at that base. The second and the third count
  the attempt. They are not
  second base and not third base. Leave fielders off.
- A runner who tags up on a catch says the catch happened: "the runner on
  second tags up to third on the foul pop out" is the caught ball, its out
  and the runner's move: ballInPlay, result field_out with outBy catch and
  foulCaught, and runnerMovement of the runner on second to third. Leave out
  who caught it when the scorer does not say; do not ask.
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
  "out" — never call undo. A throw the scorer calls late is not undo.
- If you cannot tell who or what, call askScorer instead of guessing. A
  first name or a number that fits two or more players the game lists does
  not say which, even when one of them seems likelier: ask, with an option
  for each. With Chase L. on second and Chase M. on first, "Chase was picked
  off" asks which Chase; it does not pick the runner on first. Ask a real
  question about this sentence, with an option for each real answer. Write
  the question and every label as the scorer would say them, with names,
  numbers, bases and teams, never a tag.
- A number the scorer gives for a fielder — an error, a throw, a catch — is
  the fielder in the field who wears it, not a batter or runner who wears it
  too, and his tag is the one GAME gives that fielder.

ROSTER
Some sentences change a team's roster, its batting order or who plays where,
rather than say what happened: "number 3 subs in at third base", "Soto subs
in for the pitcher", "Betts pinch hits", "Freeman runs for the runner on
second", "put Judge fourth". Report those with the roster tools, when you
are offered them.
- Report each player just as the scorer said him: a number as jersey, in
  digits ("number 3" is jersey "3"), a name as name, and both when he said
  both. "Three" is that same jersey. "Third", "3rd" and "third base" are
  the base, not jersey 3. ROSTERS lists the players so that you can spell a
  name you heard.
  Report a name even when ROSTERS shows nobody by it: ROSTERS shows a
  player by first name and last initial, and the screen knows whole names.
  With Mike T. and Mike B. listed, "Mike Trout pitches" is setPositions with
  name "Mike Trout": no question.
  Never add a name or a number the scorer did not say, and never give a
  tag. Spelling a listed player as ROSTERS spells him is not adding a name.
  A new player joins only through addPlayer, when the scorer says to
  add or create him. This creates a real team-roster player by default.
  Set placeholder true only when the scorer explicitly says "placeholder".
  "Create a player named Shohei Ohtani, number 17" creates a real roster
  player; "Create a placeholder player named Shohei Ohtani, number 17"
  creates a game-only placeholder. Never infer placeholder from an unknown
  name, a missing surname, or the fact that the player is not listed.
  A name off by a sound from exactly one listed player is that player. The
  name in the tool call is the ROSTERS spelling, first and last, not the
  spelling that was heard. "Add Jarrett to the lineup", when Jared Hale is
  the only close name, is placeInLineup of name "Jared Hale" — at the end
  when no place was said — not addPlayer, and not the name Jarrett. "Add
  Jarrett third" is that same name at slot 3. addPlayer stays for a name
  that is not a mishearing of anyone listed.
- Give side only when the scorer says the team: its name, or home or away
  ("the Hosts' number 3", "for the visitors"). Otherwise leave it out, even
  when you can tell, and even when both teams have the name or number: the
  screen takes a defensive change from the team in the field, and a pinch
  hitter or runner from the team at bat.
- Never call askScorer about a roster change, whatever the rules above say
  about asking: not which team, not which player, not whether to add him.
  Report it as said. The screen finds the player, and asks the scorer
  itself when it must.
- A defensive change — "subs in at third base", "subs in for the pitcher",
  "moves to short" — is setPositions. Place only the player the scorer puts
  somewhere: the one he comes in for leaves that position by himself.
  "Number 3 subs in at third base" is jersey "3" at 3B. "Morgan subs in for
  the pitcher" is that player at P. "Jared moves to short" is that player
  at SS. "Jared comes in for Sol." is Jared at the position Sol is playing.
  Place Jared only. Leave side out on each of these.
  A pinch hitter or a pinch runner is the one who comes in, never the batter
  or the runner he replaces. The runner he replaces is named by base alone:
  "Garcia runs for the runner on first" is pinchRunner with Garcia as
  player and 1B as base.
- "Set this lineup" followed by names is setLineup with every name, in the
  order said. "Put Judge fourth", "add Ohtani to the end" and "Judge, Soto
  and Betts as numbers 3, 4 and 5" are placeInLineup. A place may come
  through as a word that sounds like it: "forth" is fourth, "for" is four.
  That place in the batting order is the one time an ordinal is not a base.
  In a play, 1st, 2nd and 3rd are still bases, and three, four and five are
  still jerseys.
- "Substitute A for B in the lineup" is setLineup of the batting order of
  the team ROSTERS lists A on. When more than one player is named B, replace
  the one on A's team. Write that whole order: A where that B stood, B left
  out, every other batter of that team still there, in the same places. The
  name B does not appear in the order. "Substitute Nico for Matt", when
  Nico and Matt Brooks share a team and another Matt plays for the other
  team, is Nico in Matt Brooks's place and no Matt in that order. Do not
  write the other team's order, even when that team is batting, and do not
  ask which B. It is not placeInLineup, which would keep B, and not
  pinchHitter unless A is hitting for the batter due up right now.
- A sentence carries roster changes or scoring actions, never both.

The name in a roster tool is the ROSTERS spelling whenever the heard name is
one sound off from exactly one listed player. Heard "Jarrett", with Jared
Hale the only close name, is the name "Jared Hale" in the tool call. The
string Jarrett is never an argument.`

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

/**
 * What an undo in a reply takes back: of each kind of call the reply sends
 * after it, as many of the last it sent before as it sends again — one
 * undo and one pitch take back the last pitch.
 */
function lastSent(
  sent: readonly ScoringAction[],
  after: readonly ToolCall[]
): ScoringAction[] {
  const again = new Map<string, number>()
  for (const call of after)
    if (call.function.name !== UNDO.function.name)
      again.set(call.function.name, (again.get(call.function.name) ?? 0) + 1)
  const taken = new Set<ScoringAction>()
  for (const [type, count] of again)
    for (const action of sent.filter(each => each.type === type).slice(-count))
      taken.add(action)
  return sent.filter(action => taken.has(action))
}

/**
 * A ball in play corrected by the same ball said again: what the second
 * says wins, and a second that places the ball drops the first's places.
 */
function corrected(
  first: BallInPlayAction,
  second: BallInPlayAction
): BallInPlayAction {
  const placed =
    second.location != null ||
    second.direction != null ||
    second.depth != null ||
    second.distanceFeet != null
  if (!placed) return { ...first, ...second }
  const {
    location: _location,
    direction: _direction,
    depth: _depth,
    distanceFeet: _distanceFeet,
    ...unplaced
  } = first
  return { ...unplaced, ...second }
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

type Cleaned =
  | { action: ScoringAction }
  | { command: SaidRosterCommand }
  | { problem: Problem }

/** A roster command as said, checked by the scoring library's own cleaner. */
function cleanCommand(raw: { type: string }): Cleaned {
  try {
    return { command: asSaidRosterCommand(raw) }
  } catch (error) {
    return {
      problem: {
        code: 'malformed',
        message: `${raw.type}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
}

/**
 * The players a game written for a model gives a tag, by id, and the fielder
 * at each position: who a call may name.
 */
interface Players {
  ids: ReadonlySet<number>
  fielding: ReadonlyMap<string, number>
}

/**
 * An action as the model called for it, its players' tags (and a fielder's
 * position) read back as ids of players `game` gives, then checked.
 */
function cleanTagged(
  raw: Record<string, unknown> & { type: string },
  game: Players
): Cleaned {
  // These model labels repeat the play/base, not a separate advance reason.
  // Keep the actual runner, destination and Out call for the game to settle.
  const optionalReason =
    raw.type === 'runnerMovement' &&
    typeof raw.reason === 'string' &&
    (/^fielder['’]?s? choice$/i.test(raw.reason) ||
      (raw.out === true && /^out at (?:first|second|third)$/i.test(raw.reason)))
  const untagged = untaggedAction(
    optionalReason ? { ...raw, reason: undefined } : raw,
    game.ids,
    game.fielding
  )
  return 'problem' in untagged ? untagged : cleanAction(untagged.raw)
}

/**
 * The tool's name is the action's or the command's `type`; the arguments are
 * the rest of it. A roster tool's call is a command only when the scope
 * offers that tool.
 */
function clean(
  name: string,
  args: Record<string, unknown> | null,
  rosterNames: ReadonlySet<string>,
  game: Players
): Cleaned {
  if (args == null)
    return {
      problem: {
        code: 'malformed',
        message: `${name}: arguments are not an object`
      }
    }
  return rosterNames.has(name)
    ? cleanCommand({ ...args, type: name })
    : cleanTagged({ ...args, type: name }, game)
}

/** An option's item: a roster command by its `type`, or else an action. */
function cleanItem(raw: unknown, game: Players): Cleaned {
  const type = (raw as { type?: unknown } | null)?.type
  if (typeof type !== 'string') return cleanAction(raw)
  return (ROSTER_COMMAND_TYPES as readonly string[]).includes(type)
    ? cleanCommand(raw as { type: string })
    : cleanTagged(raw as Record<string, unknown> & { type: string }, game)
}

/**
 * The options of a question, each label as the scorer reads it: with names,
 * never a tag (`withNames`).
 */
function optionsOf(
  raw: unknown,
  game: Players,
  names: ReadonlyMap<string, string>
): AskOption[] {
  if (!Array.isArray(raw)) return []
  const options: AskOption[] = []
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const { label: said, actions } = item as {
      label?: unknown
      actions?: unknown
    }
    if (typeof said !== 'string') continue
    const label = withNames(said, names)
    if (label === '') continue
    const cleaned = Array.isArray(actions)
      ? actions.map(item => cleanItem(item, game))
      : []
    // An option keeps its actions and commands only when every one cleans.
    if (cleaned.length === 0 || cleaned.some(result => 'problem' in result))
      options.push({ label })
    else {
      const kept = cleaned.flatMap(result =>
        'action' in result ? [result.action] : []
      )
      const roster = cleaned.flatMap(result =>
        'command' in result ? [result.command] : []
      )
      options.push({
        label,
        ...(kept.length === 0 ? {} : { actions: kept }),
        ...(roster.length === 0 ? {} : { roster })
      })
    }
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
  private readonly roster: SaidRosterCommand[] = []
  private readonly dropped: Problem[] = []
  /** Whether the next reply must be a tool call. */
  private required = true
  /** Whether the model called undo for words that take back a play. */
  private undo = false
  /** Whether the model was asked once for a result it left out. */
  private nudged = false
  /** Whether the model was told once that an undo of its own is not one. */
  private undoAnswered = false
  /** Whether the last reply held an undo after calls the model had kept. */
  private ownUndo = false
  /** Whether this reply answers being told its calls stand. */
  private answering = false
  /**
   * Each ball in play said again before its result and merged into the
   * first, for the sentence: undone when its results outnumber its balls.
   */
  private readonly merges: Array<{
    merged: ScoringAction
    before: BallInPlayAction
    ball: BallInPlayAction
  }> = []

  /** Whether a question about a roster change was turned back once. */
  private rosterAsked = false
  /**
   * The players the game gives a tag, by id, and who fields each position:
   * the only ones a call may name.
   */
  private readonly players: Players
  /**
   * Each tag's name in the game: what the scorer reads in place of a tag in
   * anything the model wrote for him.
   */
  private readonly names: ReadonlyMap<string, string>

  constructor(
    private readonly config: InterpreterConfig,
    given: string,
    readonly transcript: string
  ) {
    const context = withTags(given)
    const choiceRules = /\bfielder['’]?s? choice\b/i.test(transcript)
      ? `\n\nFIELDER CHOICE RELAYS\n${CHOICE_INSTRUCTIONS}`
      : ''
    const game = `${gamePrompt(context)}${choiceRules}`
    this.players = {
      ids: taggedIds(context),
      fielding: fieldingIds(context)
    }
    this.names = taggedNames(context)
    this.messages =
      config.gameInUserMessage === true
        ? [
            { role: 'system', content: systemPrompt() },
            {
              role: 'user',
              content: `${game}\n\nTHE SCORER SAID\n${transcript}`
            }
          ]
        : [
            { role: 'system', content: systemPrompt() },
            { role: 'system', content: game },
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
    if (option.actions != null || option.roster != null)
      return this.settled(
        [...this.actions, ...(option.actions ?? [])],
        [...this.roster, ...(option.roster ?? [])]
      )
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
      // A question about a roster change is the screen's to ask: the model
      // is told so, once, and asked again for the change as said.
      const rosterAsk = this.rosterAsk(calls)
      if (rosterAsk != null) {
        this.messages.push(
          { role: 'assistant', content: null, tool_calls: [rosterAsk] },
          {
            role: 'tool',
            tool_call_id: rosterAsk.id,
            content: ROSTER_NOT_ASKED
          }
        )
        this.required = true
        continue
      }
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
      // An undo the words did not ask for, after calls of the model's own:
      // it is told once that its calls stand, and asked for what is left.
      const ownUndo = !this.undoAnswered && this.ownUndo
      if (!nudge && !more && !ownUndo) return this.finished(reply.said)
      if (nudge) this.nudged = true
      if (ownUndo) this.undoAnswered = true
      this.answering = ownUndo
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
          content:
            ownUndo && call.function.name === UNDO.function.name
              ? UNDO_NOT_ASKED
              : nudge
                ? this.config.followUp === true
                  ? `${followUp(this.recorded())} ${RESULT_MISSING.replace(/^Recorded\. /, '')}`
                  : RESULT_MISSING
                : followUp(this.recorded())
        })
      this.required = false
    }
  }

  /**
   * The model's question, when it is about a roster change and none was
   * turned back yet: one the model says is, any question in a scope of
   * roster tools alone, and one whose options carry a roster tool's call,
   * whether or not its players clean.
   */
  private rosterAsk(calls: readonly ToolCall[]): ToolCall | undefined {
    if (this.rosterAsked || this.rosterNames().size === 0) return undefined
    const ask = calls.find(
      call => call.function.name === ASK_SCORER.function.name
    )
    if (ask == null) return undefined
    const args = parse(ask.function.arguments)
    const options = args?.options
    const roster =
      args?.about === 'roster' ||
      (this.config.tools ?? toolSchema()).length === 0 ||
      (Array.isArray(options) &&
        options.some(
          (option: { actions?: unknown } | null) =>
            Array.isArray(option?.actions) &&
            option.actions.some((item: { type?: unknown } | null) =>
              this.rosterNames().has(String(item?.type))
            )
        ))
    if (!roster) return undefined
    this.rosterAsked = true
    return ask
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
      const question =
        typeof args?.question === 'string'
          ? withNames(args.question, this.names)
          : ''
      const options = optionsOf(args?.options, this.players, this.names)
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
    this.ownUndo = false
    // What this reply kept, and, after an undo of the model's own in it,
    // what of that its next calls replace.
    const sent: ScoringAction[] = []
    let retaken: ScoringAction[] = []
    // Told its calls stand, a reply that sends the kept result again is
    // sending its play again, its ball too; a new result is a new batter's.
    const lastResult = this.actions.findLast(
      action => action.type === 'result' && !UNBATTED.has(action.eventType)
    )
    const resent =
      this.answering &&
      lastResult?.type === 'result' &&
      calls.some(
        call =>
          call.function.name === 'result' &&
          parse(call.function.arguments)?.eventType === lastResult.eventType
      )
    for (const [index, call] of calls.entries()) {
      if (call.function.name === UNDO.function.name) {
        // Taking back a play is destructive: only when the words say so.
        if (!TAKE_BACK.test(this.transcript)) {
          // After calls of its own for this sentence, it is the model taking
          // those back, not a play. In the same reply, the calls it sends
          // next replace them; a later reply is told they stand.
          if (this.actions.length === 0)
            this.dropped.push({
              code: 'malformed',
              message: 'An undo the words did not ask for was ignored'
            })
          else {
            this.ownUndo = true
            retaken = lastSent(sent, calls.slice(index + 1))
          }
          kept++
          continue
        }
        if (!this.undo) kept++
        this.undo = true
        continue
      }
      const cleaned = clean(
        call.function.name,
        this.withContact(
          call.function.name,
          this.rosterNames().has(call.function.name)
            ? parse(call.function.arguments)
            : this.withTagsForNames(parse(call.function.arguments))
        ),
        this.rosterNames(),
        this.players
      )
      if ('problem' in cleaned) {
        this.dropped.push(this.named(cleaned.problem))
        kept++
        continue
      }
      if ('command' in cleaned) {
        this.roster.push(cleaned.command)
        kept++
        continue
      }
      const action = this.onlyDefenders(cleaned.action)
      if (action.type === 'gameFlow' && action.kind === 'closePlay') continue
      // A runner's move is the same move for the same runner, base and
      // outcome, whatever fielders it names.
      const move = moveOf(action)
      if (
        move != null &&
        this.actions.some(earlier => moveOf(earlier) === move)
      )
        continue
      // After its own undo in this reply, a call like one it took back
      // replaces it, in order; any more are the play's next calls.
      const taken = retaken.findIndex(earlier => earlier.type === action.type)
      if (taken >= 0) {
        const [earlier] = retaken.splice(taken, 1)
        const at = this.actions.indexOf(earlier)
        if (at < 0) continue
        const replaced =
          earlier.type === 'ballInPlay' && action.type === 'ballInPlay'
            ? corrected(earlier, action)
            : action
        this.actions[at] = replaced
        sent[sent.indexOf(earlier)] = replaced
        kept++
        continue
      }
      // Told its calls stand, a batted result said again, no ball waiting
      // for it, is the one kept. Two batters' same results are two.
      const last = this.actions.findLast(
        kept => kept.type === 'result' && !UNBATTED.has(kept.eventType)
      )
      if (
        this.answering &&
        action.type === 'result' &&
        !UNBATTED.has(action.eventType) &&
        last != null &&
        !this.resultMissing() &&
        JSON.stringify(last) === JSON.stringify(action)
      )
        continue
      // A second ball in play before the first has its result is the same
      // ball said again, perhaps corrected: what it says wins. So is one
      // sent again with its result after the model was told they stand.
      const earlier = this.actions.findLastIndex(
        kept => kept.type === 'ballInPlay'
      )
      if (
        resent &&
        action.type === 'ballInPlay' &&
        earlier >= 0 &&
        !this.resultMissing()
      ) {
        this.actions[earlier] = corrected(
          this.actions[earlier] as BallInPlayAction,
          action
        )
        kept++
        continue
      }
      if (
        action.type === 'ballInPlay' &&
        earlier >= 0 &&
        this.resultMissing()
      ) {
        const before = this.actions[earlier] as BallInPlayAction
        const merged = corrected(before, action)
        this.merges.push({ merged, before, ball: action })
        this.actions[earlier] = merged
        const at = sent.indexOf(before)
        if (at >= 0) sent[at] = merged
        else sent.push(merged)
      } else {
        this.actions.push(action)
        sent.push(action)
      }
      kept++
    }
    // Two batters' balls sent before their results were two balls after all.
    for (const merge of [...this.merges].reverse()) {
      if (!this.resultsOutnumberBalls()) break
      const at = this.actions.indexOf(merge.merged)
      if (at < 0) continue
      this.actions[at] = merge.before
      this.actions.splice(at + 1, 0, merge.ball)
      this.merges.splice(this.merges.indexOf(merge), 1)
    }
    return kept
  }

  /** Whether the sentence has more batted results than balls in play. */
  private resultsOutnumberBalls(): boolean {
    const balls = this.actions.filter(action => action.type === 'ballInPlay')
    const batted = this.actions.filter(
      action => action.type === 'result' && !UNBATTED.has(action.eventType)
    )
    return batted.length > balls.length
  }

  /**
   * An action whose relay names only the fielding side: with the whole
   * defense in GAME, a player off it — a batter whose tag the model took for
   * the first baseman's — is no fielder, and the screen finds the relay
   * from the words.
   */
  private onlyDefenders(action: ScoringAction): ScoringAction {
    const defenders = new Set(this.players.fielding.values())
    if (
      defenders.size < 9 ||
      !('fielders' in action) ||
      !Array.isArray(action.fielders) ||
      action.fielders.every(id => defenders.has(id))
    )
      return action
    // A fielding play names its fielders: its defenders, or, with none, its
    // own. Any other relay with a player off the defense is no relay — the
    // screen finds it from the words — since a part of one credits wrongly.
    if (action.type === 'fieldingPlay') {
      const fielders = action.fielders.filter(id => defenders.has(id))
      return fielders.length === 0 ? action : { ...action, fielders }
    }
    const { fielders: _all, ...rest } = action
    return rest
  }

  /**
   * A player the model wrote by his whole name, as GAME gives it, in place
   * of his tag: his tag, when no one else has that name. Not for a roster
   * command, which may name a player by name on purpose.
   */
  private withTagsForNames(
    args: Record<string, unknown> | null
  ): Record<string, unknown> | null {
    if (args == null) return args
    const tagOf = (value: unknown): unknown => {
      if (typeof value !== 'string') return value
      const tags = [...this.names]
        .filter(([, name]) => name.toLowerCase() === value.trim().toLowerCase())
        .map(([tag]) => tag)
      return tags.length === 1 ? tags[0] : value
    }
    return Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.map(tagOf) : tagOf(value)
      ])
    )
  }

  /**
   * A ball in play said again before its result, without its contact: the
   * contact of the ball it repeats.
   */
  private withContact(
    name: string,
    args: Record<string, unknown> | null
  ): Record<string, unknown> | null {
    if (name !== 'ballInPlay' || args == null || args.contact != null)
      return args
    const earlier = this.actions.findLast(kept => kept.type === 'ballInPlay')
    return earlier != null && this.resultMissing()
      ? { ...args, contact: earlier.contact }
      : args
  }

  /** A problem as the scorer reads it, its message with names, never a tag. */
  private named(problem: Problem): Problem {
    return { ...problem, message: withNames(problem.message, this.names) }
  }

  /** Whether the scorer took back the last thing scored. */
  private undone(): boolean {
    return this.undo || OPENS_WITH_TAKE_BACK.test(this.transcript)
  }

  /** Every tool this conversation offers, by name. */
  private toolNames(): ReadonlySet<string> {
    return new Set([
      ...(this.config.tools ?? toolSchema()).map(tool => tool.name),
      ...this.rosterNames(),
      ASK_SCORER.function.name,
      UNDO.function.name
    ])
  }

  /** The roster tools this conversation offers, by name. */
  private rosterNames(): ReadonlySet<string> {
    return new Set((this.config.rosterTools ?? []).map(tool => tool.name))
  }

  /** Everything kept so far, actions and commands, for a follow-up model. */
  private recorded(): Array<ScoringAction | SaidRosterCommand> {
    return [...this.actions, ...this.roster]
  }

  /** A sentence settled: its actions, its roster commands and any undo. */
  private settled(actions: ScoringAction[], roster: SaidRosterCommand[]): Turn {
    return {
      kind: 'actions',
      actions,
      ...(roster.length === 0 ? {} : { roster }),
      dropped: [...this.dropped],
      ...(this.undone() ? { undo: true as const } : {})
    }
  }

  /** The sentence's actions and commands, or why there are none. */
  private finished(said: string): Turn {
    const { actions, roster, dropped } = this
    if (this.undone() || actions.length > 0 || roster.length > 0)
      return this.settled([...actions], [...roster])
    return {
      kind: 'error',
      message:
        dropped.length > 0
          ? `Nothing usable came back: ${dropped.map(p => p.message).join('; ')}`
          : said === ''
            ? `Nothing to score in "${this.transcript}"`
            : `Nothing to score in "${this.transcript}": ${withNames(said, this.names).slice(0, 300)}`
    }
  }

  /** One tool call as logged: its name and its arguments. */
  private loggedCall(call: ToolCall): LoggedCall {
    return {
      name: call.function.name,
      arguments: parse(call.function.arguments) ?? call.function.arguments
    }
  }

  /** The prompt this round showed the model, and the calls it returned. */
  private note(
    result: { calls: ToolCall[]; said: string } | { error: string }
  ): void {
    const log = this.config.log
    if (log == null) return
    const exchange: DictationExchange = {
      model: this.config.model,
      messages: this.messages.map(message =>
        message.role === 'tool'
          ? {
              role: message.role,
              content: message.content,
              toolCallId: message.tool_call_id
            }
          : message.role === 'assistant'
            ? {
                role: message.role,
                content: message.content,
                ...(message.tool_calls == null
                  ? {}
                  : {
                      toolCalls: message.tool_calls.map(call =>
                        this.loggedCall(call)
                      )
                    })
              }
            : { role: message.role, content: message.content }
      ),
      calls:
        'error' in result
          ? []
          : result.calls.map(call => this.loggedCall(call)),
      said: 'error' in result ? '' : result.said,
      ...('error' in result ? { error: result.error } : {})
    }
    try {
      log(exchange)
    } catch (error) {
      console.error(
        `dictation log failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
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
      if (!response.ok) {
        const error = `${provider} answered ${response.status}: ${text.slice(0, 200)}`
        this.note({ error })
        return { error }
      }
      const read = call.read(parse(text))
      this.note(read)
      return read
    } catch (error) {
      const failure = timedOut
        ? `${provider} gave no answer within ${Math.round(deadlineMs / 1000)}s`
        : `${provider} could not be reached: ${error instanceof Error ? error.message : String(error)}`
      this.note({ error: failure })
      return { error: failure }
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
          ...asOpenAiTools(this.config.rosterTools ?? []),
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
        // No temperature: Claude Haiku 5.5 refuses one.
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
          ...(this.config.rosterTools ?? []),
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
