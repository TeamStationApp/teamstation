import { parseArgs } from 'node:util'

import WebSocket from 'ws'

import {
  asSearchServerFrame,
  type SearchFrame,
  type SearchServerFrame
} from '../src/common/search/types'

/**
 * Opens the search socket and shows what streams back: each `search` frame
 * sent and each frame received, with when it happened.
 *
 *   node -r sucrase/register scripts/searchProbe.ts \
 *     --url ws://127.0.0.1:<port>/api/v1/search --text "san diego" \
 *     [--text "san diego ca" ...] [--token <session token>] \
 *     [--gap 150] [--wait 3000]
 *
 * Each `--text` is one frame, in order, `--gap` milliseconds apart, the way
 * a person types. The probe then waits `--wait` milliseconds for the last
 * answers and closes. A received frame for an older `seq` than the latest
 * sent is marked stale: the app's `SearchSocket` drops it. Without
 * `--token` the probe searches signed out. The token is never printed.
 */
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    text: { type: 'string', multiple: true },
    token: { type: 'string' },
    gap: { type: 'string', default: '150' },
    wait: { type: 'string', default: '3000' }
  }
})
const texts = values.text ?? []
const gapMs = Number(values.gap)
const waitMs = Number(values.wait)
if (
  values.url == null ||
  texts.length === 0 ||
  !Number.isFinite(gapMs) ||
  !Number.isFinite(waitMs)
) {
  console.error(
    'Usage: node -r sucrase/register scripts/searchProbe.ts --url <ws url> --text <text> [--text <text> ...] [--token <token>] [--gap <ms>] [--wait <ms>]'
  )
  process.exit(2)
}

const started = Date.now()
const stamp = (): string =>
  `${new Date().toISOString()} +${String(Date.now() - started).padStart(5)}ms`

const summary = (frame: SearchServerFrame): string => {
  if (frame.type === 'error')
    return `error seq=${frame.seq ?? '-'} ${frame.code}: ${frame.message}`
  const rows = frame.results.map(result =>
    result.kind === 'person'
      ? `${result.name} (person)`
      : `${result.name} (${result.kind})`
  )
  const pills = frame.locations.map(location => location.label)
  return [
    `results seq=${frame.seq} stage=${frame.stage} rows=${frame.results.length}`,
    ...rows.map((row, at) => `    ${String(at + 1).padStart(2)}. ${row}`),
    ...(pills.length === 0 ? [] : [`    pills: ${pills.join(' | ')}`])
  ].join('\n')
}

let latest = 0
/** The stages each seq was answered with, in order. */
const answered = new Map<number, string[]>()
const ws = new WebSocket(
  values.url,
  values.token == null
    ? {}
    : { headers: { authorization: `Bearer ${values.token}` } }
)
console.log(
  `${stamp()} connecting ${values.url}${values.token == null ? ' (signed out)' : ' (with a token)'}`
)

ws.on('open', () => {
  console.log(`${stamp()} open`)
  const run = async (): Promise<void> => {
    for (const [at, text] of texts.entries()) {
      if (at > 0) await new Promise(resolve => setTimeout(resolve, gapMs))
      const frame: SearchFrame = {
        type: 'search',
        seq: at + 1,
        text,
        location: null,
        mode: 'all'
      }
      latest = frame.seq
      answered.set(frame.seq, [])
      console.log(`${stamp()} > ${JSON.stringify(frame)}`)
      ws.send(JSON.stringify(frame))
    }
    await new Promise(resolve => setTimeout(resolve, waitMs))
    ws.close(1000, 'probe done')
  }
  run().catch((error: unknown) => {
    console.log(`${stamp()} error: ${String(error)}`)
    process.exitCode = 1
  })
})

ws.on('message', data => {
  let frame: SearchServerFrame
  try {
    frame = asSearchServerFrame(JSON.parse((data as Buffer).toString('utf8')))
  } catch (error: unknown) {
    console.log(`${stamp()} < unreadable: ${String(error)}`)
    return
  }
  if (frame.seq != null)
    answered
      .get(frame.seq)
      ?.push(frame.type === 'error' ? 'error' : frame.stage)
  const stale =
    frame.seq != null && frame.seq < latest
      ? `  [stale: seq ${frame.seq} < latest ${latest}, dropped by SearchSocket]`
      : ''
  console.log(`${stamp()} < ${summary(frame)}${stale}`)
})

ws.on('unexpected-response', (_request, response) => {
  console.log(`${stamp()} refused: HTTP ${response.statusCode}`)
  process.exitCode = 1
})

ws.on('error', error => {
  console.log(`${stamp()} error: ${error.message}`)
  process.exitCode = 1
})

ws.on('close', (code, reason) => {
  console.log(`${stamp()} closed ${code} ${reason.toString()}`.trimEnd())
  for (const [seq, stages] of answered) {
    const heard = stages.length === 0 ? 'nothing' : stages.join(', ')
    const jev = stages.includes('jev')
      ? ''
      : seq < latest
        ? ' (no jev: overtaken by a newer seq)'
        : ' (no jev)'
    console.log(`seq ${seq}: ${heard}${jev}`)
  }
})
