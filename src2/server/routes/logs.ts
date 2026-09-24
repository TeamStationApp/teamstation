import {
  asArray,
  asObject,
  asOptional,
  asString,
  asUnknown,
  asValue
} from 'cleaners'
import { Router } from 'express'

import { badRequest } from '../../common/errors'
import { skipAudit } from '../middleware/withAudit'
import { withAsync } from '../middleware/withErrors'

// Where a client's own log lines land: the GameStation app, a phone app that
// reads another service, or anything else that runs away from the server and
// has to be understood from it.
//
// Lines are written to the server's log, tagged `[client <source>]` with the
// client's run id and the signed-in user when there is one, so the server's
// log shows what a phone saw next to what the server did. It answers
// without a session, because a client that cannot sign in is the one whose
// log matters most. One post is bounded, at `MAX_LINES` lines of at most
// `MAX_LINE` characters each. Nothing is stored in the database, not even an audit row.

/** The most lines one post may carry. */
export const MAX_LINES = 200
/** Where one line's text and data, together, are cut. */
export const MAX_LINE = 2000

const asLevel = asValue('debug', 'info', 'warn', 'error')

const asLogLine = asObject({
  at: asString,
  level: asLevel,
  text: asString,
  data: asOptional(asUnknown)
})

const asLogsBody = asObject({
  source: asString,
  run: asOptional(asString),
  build: asOptional(asString),
  lines: asArray(asLogLine)
})

/** A client's label, kept to letters, digits and a few separators. */
function label(raw: string | undefined, fallback: string): string {
  const clean = (raw ?? '').replace(/[^\w.-]/g, '').slice(0, 40)
  return clean === '' ? fallback : clean
}

function oneLine(raw: string): string {
  return raw.replace(/\s+/g, ' ')
}

export function logRoutes(): Router {
  const router = Router()

  router.post(
    '/logs',
    withAsync(async (req, res) => {
      skipAudit(res.locals)
      let body: ReturnType<typeof asLogsBody>
      try {
        body = asLogsBody(req.body)
      } catch (error) {
        throw badRequest(
          error instanceof Error ? error.message : 'Malformed request body'
        )
      }
      if (body.lines.length > MAX_LINES) {
        throw badRequest(`At most ${MAX_LINES} lines per post`)
      }
      const source = label(body.source, 'unknown')
      const run = label(body.run, '-')
      const build = label(body.build, '-')
      const who = req.actor == null ? 'anonymous' : String(req.actor.userId)
      for (const line of body.lines) {
        const data =
          line.data === undefined ? '' : ` ${JSON.stringify(line.data)}`
        // Whitespace is collapsed in everything the client wrote, so no
        // field can start a log line of its own and pass for another
        // client's, or the server's.
        const text = oneLine(`${line.text}${data}`)
        const at = oneLine(line.at).slice(0, 32)
        console.log(
          `[client ${source}] run=${run} build=${build} user=${who} ` +
            `at=${at} ${line.level} ${text.slice(0, MAX_LINE)}`
        )
      }
      res.status(204).end()
    })
  )

  return router
}
