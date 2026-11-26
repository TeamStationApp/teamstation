import { expect } from 'chai'
import { describe, it } from 'mocha'

import { lstrings } from '../locales/strings'
import { OFFLINE_BANNER } from '../sync/useOffline'
import { nextReconnect, scoringNotice } from './scoringNotice'

const saved = { pending: 0, offline: false, readOnly: false, problem: null }
const line = (
  input: Partial<Parameters<typeof scoringNotice>[0]>
): ReturnType<typeof scoringNotice> =>
  scoringNotice({
    status: saved,
    phoneOffline: false,
    reconnecting: false,
    ...input
  })

describe('the scoring notice', function () {
  type Input = Parameters<typeof line>[0]
  const rows: Array<[Input, string]> = [
    [{ held: 'Not sent: refused' }, 'Not sent: refused'],
    [{ status: { ...saved, problem: 'refused' } }, 'Not saved: refused'],
    [{ rosterConflict: true }, lstrings.scoring_roster_conflict],
    [{ event: 'Game reset.' }, 'Game reset.'],
    [{ phoneOffline: true }, OFFLINE_BANNER],
    [
      { status: { ...saved, offline: true, pending: 2 } },
      'Offline — 2 plays waiting'
    ],
    [{ reconnecting: true }, 'Saving…']
  ]
  for (const [i, [high, text]] of rows.entries()) {
    for (const [low] of rows.slice(i))
      it(`gives ${text} precedence over ${JSON.stringify(low)}`, function () {
        const input = {
          ...low,
          ...high,
          status: { ...saved, ...low.status, ...high.status }
        }
        expect(line(input)).deep.equals({
          text,
          kind: i === 0 ? 'held' : 'report'
        })
        expect(
          line({ ...input, status: { ...input.status, readOnly: true } })
        ).equals(null)
      })
  }
  it('keeps ordinary saves silent and uses the singular for one queued play', function () {
    expect(line({})).equals(null)
    expect(line({ status: { ...saved, pending: 1 } })).equals(null)
    expect(line({ status: { ...saved, offline: true } })).equals(null)
    expect(
      line({ status: { ...saved, offline: true, pending: 1 } })?.text
    ).equals('Offline — 1 play waiting')
  })
})

describe('the reconnect latch', function () {
  it('turns on offline, holds while busy back online, and clears when idle', function () {
    expect(nextReconnect(false, false, true)).equals(false)
    expect(nextReconnect(false, true, false)).equals(true)
    expect(nextReconnect(true, true, true)).equals(true)
    expect(nextReconnect(true, false, true)).equals(true)
    expect(nextReconnect(true, false, false)).equals(false)
    expect(nextReconnect(false, false, false)).equals(false)
  })
})
