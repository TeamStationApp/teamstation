import { appendFileSync } from 'node:fs'

import type { RequestHandler } from 'express'

/**
 * A development record of the requests one server answers, for a scenario
 * that must show which reads a phone sent and in what order: one line each,
 * `<ISO arrival time> <method> <path with query> <status>`, appended to the
 * file `TS_REQUEST_RECORD` names. Never a header or a body. With the
 * variable unset nothing is installed, and the operational
 * `request_completed` log is the only one.
 */
export function requestRecorder(
  env: Record<string, string | undefined> = process.env
): RequestHandler | undefined {
  const file = env.TS_REQUEST_RECORD
  if (file == null || file === '') return undefined
  return (req, res, next) => {
    const arrived = new Date().toISOString()
    const { method } = req
    const path = req.originalUrl
    let written = false
    const write = (): void => {
      if (written) return
      written = true
      try {
        appendFileSync(file, `${arrived} ${method} ${path} ${res.statusCode}\n`)
      } catch {
        // A record that cannot be written leaves the request as it was.
      }
    }
    res.once('finish', write)
    res.once('close', write)
    next()
  }
}
