import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'

import { TeamStationClient } from '../../common/api'
import { mount, settle, unmount } from '../../test/gameFormDom'
import { CachingClient } from './cachingClient'
import type { OutboxListener, OutboxSummary } from './outbox'
import {
  type HeldControl,
  type HeldEdit,
  heldEdits,
  useHeldNames,
  useHeldTeamControl
} from './useOffline'

/** A phone's client with a queue the test sets, and no file or network. */
function phone(summary: OutboxSummary): {
  client: CachingClient
  calls: string[]
  set: (next: OutboxSummary) => void
} {
  const calls: string[] = []
  const listeners = new Set<OutboxListener>()
  let current = summary
  const client = Object.create(CachingClient.prototype) as CachingClient
  Object.assign(client, {
    subscribeOutbox: (listener: OutboxListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    outboxSummary: async () => current,
    discardTeam: async (id: string) => {
      calls.push(`discard ${id}`)
      return true
    },
    retryTeam: async (id: string) => {
      calls.push(`retry ${id}`)
    },
    heldNames: async (edits: Array<{ kind: string; id: string }>) => {
      calls.push(`names ${edits.map(e => `${e.kind}:${e.id}`).join(',')}`)
      return Object.fromEntries(
        edits.map(e => [`${e.kind}:${e.id}`, `Name of ${e.id}`])
      )
    }
  })
  return {
    client,
    calls,
    set: next => {
      current = next
      for (const listener of listeners) listener(next)
    }
  }
}

const summary = (teams: OutboxSummary['teams'] = {}): OutboxSummary => ({
  count: Object.keys(teams).length,
  chains: {},
  games: {},
  teams
})

describe("a held team's control and the holds' names", () => {
  afterEach(async () => {
    await unmount()
  })

  it("gives a held team's text, and its discard and retry, on the phone only", async () => {
    const { client, calls, set } = phone(
      summary({ t1: { state: 'dead', message: 'Only staff' } })
    )
    let seen: HeldControl | undefined
    let web: HeldControl | undefined
    const webClient = new TeamStationClient({ baseUrl: 'http://x/api/v1' })
    const Probe = (): null => {
      seen = useHeldTeamControl(client, 't1')
      web = useHeldTeamControl(webClient, 't1')
      return null
    }
    await mount(<Probe />)
    expect(web).equals(undefined)
    expect(seen?.state).equals('dead')
    expect(seen?.text).equals(
      'A player added on this phone was not saved: Only staff'
    )
    expect(await seen!.discard()).equals(true)
    await seen!.retry!()
    expect(calls).deep.equals(['discard t1', 'retry t1'])
    await act(async () => {
      set(summary())
    })
    expect(seen).equals(undefined)
  })

  it('reads the names again only when the set of holds changes, and none on the web', async () => {
    const { client, calls } = phone(summary())
    let names: Record<string, string> = {}
    let webNames: Record<string, string> = { stale: 'x' }
    let setEdits: (edits: HeldEdit[]) => void = () => undefined
    const webClient = new TeamStationClient({ baseUrl: 'http://x/api/v1' })
    const one = heldEdits({
      count: 1,
      chains: {},
      games: { g1: { state: 'dead', message: null } },
      teams: {}
    })
    const Probe = (): null => {
      const [edits, set] = React.useState<HeldEdit[]>(one)
      setEdits = set
      names = useHeldNames(client, edits)
      webNames = useHeldNames(webClient, edits)
      return null
    }
    await mount(<Probe />)
    expect(names).deep.equals({ 'game:g1': 'Name of g1' })
    expect(webNames).deep.equals({})
    // The same holds in a new array: nothing is read again.
    await act(async () => {
      setEdits([...one])
    })
    await settle(0)
    expect(calls).deep.equals(['names game:g1'])
    // Another hold: read again.
    await act(async () => {
      setEdits([
        ...one,
        { kind: 'team', id: 't1', held: { state: 'dead', message: null } }
      ])
    })
    await settle(0)
    expect(calls).deep.equals(['names game:g1', 'names game:g1,team:t1'])
    expect(names).deep.equals({
      'game:g1': 'Name of g1',
      'team:t1': 'Name of t1'
    })
    // Nothing held: no names, and nothing read.
    await act(async () => {
      setEdits([])
    })
    expect(names).deep.equals({})
    expect(calls).has.length(2)
  })
})
