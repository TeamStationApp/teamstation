/**
 * One server-sent event as it came: its name (`message` when it gives
 * none), its `data:` lines joined with newlines (null when it has none), and
 * the text of its comment lines (`: keep-alive`), joined the same way.
 */
export interface ServerSentEvent {
  event: string
  data: string | null
  comment: string | null
}

/**
 * Server-sent events from text that arrives in pieces, cut anywhere: `push`
 * takes the next piece and answers each event it completes, in order; `end`
 * answers the last one when the text ended without the blank line after it.
 * Lines end with LF or CRLF. Fields other than `event` and `data` (`id`,
 * `retry`) are not read.
 */
export function serverSentEvents(): {
  push: (text: string) => ServerSentEvent[]
  end: () => ServerSentEvent[]
} {
  let buffer = ''
  return {
    push: text => {
      buffer += text
      const events: ServerSentEvent[] = []
      for (;;) {
        const end = /\r?\n\r?\n/.exec(buffer)
        if (end == null) return events
        events.push(serverSentEvent(buffer.slice(0, end.index)))
        buffer = buffer.slice(end.index + end[0].length)
      }
    },
    end: () => {
      const rest = buffer
      buffer = ''
      return rest.trim() === '' ? [] : [serverSentEvent(rest)]
    }
  }
}

/** One event's lines, without the blank line that ends it. */
export function serverSentEvent(raw: string): ServerSentEvent {
  let event = 'message'
  const data: string[] = []
  const comments: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) comments.push(line.slice(1).trim())
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:'))
      data.push(line.slice(5).replace(/^ /, ''))
  }
  return {
    event,
    data: data.length === 0 ? null : data.join('\n'),
    comment: comments.length === 0 ? null : comments.join('\n')
  }
}
