/**
 * A Messages answer as the provider streams it, for Tess's fake models:
 * `message_start`, each content block started, told in pieces and stopped,
 * then `message_delta` and `message_stop`, with a `ping` early on as the
 * provider sends. Text and thinking come a few words at a time, a thinking
 * block's signature at its end, and a tool call's input as JSON split in two,
 * so a reader has to put each back together.
 */

export type StreamBlock = Record<string, unknown>

export interface StreamedMessage {
  id?: string
  model?: string
  content: StreamBlock[]
  stop_reason?: string
  usage?: Record<string, unknown>
}

/** `text` in pieces of about three words, each keeping its spaces. */
export function pieces(text: string, words = 3): string[] {
  const parts = text.match(/\S+\s*/g) ?? []
  const out: string[] = []
  for (let at = 0; at < parts.length; at += words)
    out.push(parts.slice(at, at + words).join(''))
  if (out.length === 0) return text === '' ? [] : [text]
  // Leading white space belongs to the first piece.
  const lead = /^\s*/.exec(text)?.[0] ?? ''
  out[0] = `${lead}${out[0]}`
  return out
}

/** The stream's events, in order, for one answer. */
export function streamEvents(message: StreamedMessage): StreamBlock[] {
  const usage = message.usage ?? {}
  const events: StreamBlock[] = [
    {
      type: 'message_start',
      message: {
        id: message.id ?? 'msg_stream',
        type: 'message',
        role: 'assistant',
        model: message.model ?? 'claude-test',
        content: [],
        stop_reason: null,
        usage: { ...usage, output_tokens: 1 }
      }
    },
    { type: 'ping' }
  ]
  message.content.forEach((block, index) => {
    const delta = (value: StreamBlock): void => {
      events.push({ type: 'content_block_delta', index, delta: value })
    }
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' }
      })
      for (const text of pieces(String(block.text)))
        delta({ type: 'text_delta', text })
    } else if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      })
      for (const thinking of pieces(String(block.thinking)))
        delta({ type: 'thinking_delta', thinking })
      delta({ type: 'signature_delta', signature: String(block.signature) })
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { ...block, input: {} }
      })
      const json = JSON.stringify(block.input ?? {})
      const half = Math.floor(json.length / 2)
      for (const part of [json.slice(0, half), json.slice(half)])
        if (part !== '') delta({ type: 'input_json_delta', partial_json: part })
    } else
      events.push({ type: 'content_block_start', index, content_block: block })
    events.push({ type: 'content_block_stop', index })
  })
  events.push(
    {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason ?? 'end_turn' },
      usage: { output_tokens: usage.output_tokens ?? 0 }
    },
    { type: 'message_stop' }
  )
  return events
}

/** One event as it goes over the wire. */
export function sseOf(event: StreamBlock): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
}

/** A whole answer as the provider streams it. */
export function sseText(message: StreamedMessage): string {
  return streamEvents(message).map(sseOf).join('')
}
