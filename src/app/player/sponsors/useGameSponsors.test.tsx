import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { TeamStationClient } from '../../../common/api'
import { defaultSponsorSettings } from '../../../common/nodeSettings'
import type { GameSponsors } from '../../../common/sponsors/types'
import { fakeClock, fakeSockets } from '../../../test/fakeScoreboardSocket'
import { urlOf } from '../../../test/overlayFixtures'
import {
  BOARD_POLL_MS,
  NOTICE_DEBOUNCE_MS
} from '../scoreboardOverlay/useBoardTimeline'
import {
  type GameSponsorsHandle,
  type GameSponsorsOptions,
  useGameSponsors
} from './useGameSponsors'

let root: Root | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function render(element: React.ReactElement): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(element)
  })
}

/** Lets the fake server's answers land. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

const SPONSORED: GameSponsors = {
  leagueId: 'lea_al',
  logo: { url: 'https://cdn.example.test/logo.png', width: 480, height: 120 },
  reels: [],
  overlay: {
    logo: defaultSponsorSettings.logo,
    reel: defaultSponsorSettings.reel
  }
}

/** A server that answers each game's sponsorship, and counts the asks. */
function sponsorServer(): {
  fetch: typeof fetch
  asked: string[]
  answers: Map<string, GameSponsors>
  failing: Set<string>
} {
  const asked: string[] = []
  const answers = new Map<string, GameSponsors>()
  const failing = new Set<string>()
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(urlOf(input), 'http://localhost')
    const match = /\/games\/([^/]+)\/sponsors$/.exec(url.pathname)
    const gameId = match == null ? '' : decodeURIComponent(match[1])
    asked.push(gameId)
    if (failing.has(gameId) || !answers.has(gameId))
      return new Response(JSON.stringify({ error: 'nope', message: 'nope' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })
    return new Response(JSON.stringify(answers.get(gameId)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { fetch: fetchImpl, asked, answers, failing }
}

function Probe(props: {
  client: TeamStationClient
  gameId: string | null
  live: boolean
  options?: GameSponsorsOptions
  out: { current: GameSponsorsHandle | null }
}): null {
  props.out.current = useGameSponsors(
    props.client,
    props.gameId,
    props.live,
    props.options
  )
  return null
}

function setup(token: string | null = 'tok'): {
  server: ReturnType<typeof sponsorServer>
  client: TeamStationClient
  clock: ReturnType<typeof fakeClock>
  sockets: ReturnType<typeof fakeSockets>
  out: { current: GameSponsorsHandle | null }
  options: GameSponsorsOptions
} {
  const server = sponsorServer()
  server.answers.set('g1', SPONSORED)
  server.answers.set('g2', { ...SPONSORED, leagueId: 'lea_nl' })
  const clock = fakeClock()
  const sockets = fakeSockets()
  return {
    server,
    client: new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: server.fetch,
      token: token ?? undefined
    }),
    clock,
    sockets,
    out: { current: null },
    options: {
      WebSocketImpl: sockets.Impl,
      schedule: clock.schedule,
      origin: { protocol: 'http:', host: 'localhost' }
    }
  }
}

/** U18: the sponsorship a game's players draw, read and kept up to date. */
describe('U18 useGameSponsors', function () {
  it('reads once a game, and again for another game', async function () {
    const { server, client, out, options } = setup()
    await render(
      <Probe
        client={client}
        gameId="g1"
        live={false}
        options={options}
        out={out}
      />
    )
    await flush()
    expect(out.current?.sponsors).deep.equals(SPONSORED)
    await render(
      <Probe
        client={client}
        gameId="g1"
        live={false}
        options={options}
        out={out}
      />
    )
    await flush()
    expect(server.asked).deep.equals(['g1'])
    await render(
      <Probe
        client={client}
        gameId="g2"
        live={false}
        options={options}
        out={out}
      />
    )
    await flush()
    expect(out.current?.sponsors?.leagueId).equals('lea_nl')
    expect(server.asked).deep.equals(['g1', 'g2'])
  })

  it('reads nothing with no game, opens no socket for a recording, and reads by the cookie on the web', async function () {
    const { server, client, out, options, sockets } = setup()
    await render(
      <Probe client={client} gameId={null} live options={options} out={out} />
    )
    await flush()
    expect(server.asked).deep.equals([])
    await render(
      <Probe
        client={client}
        gameId="g1"
        live={false}
        options={options}
        out={out}
      />
    )
    await flush()
    expect(sockets.sockets).to.have.length(0)
    // A browser's session is its cookie: no token, and still read.
    const web = setup(null)
    await render(
      <Probe
        client={web.client}
        gameId="g1"
        live={false}
        options={web.options}
        out={web.out}
      />
    )
    await flush()
    expect(web.server.asked).deep.equals(['g1'])
    expect(web.out.current?.sponsors).deep.equals(SPONSORED)
  })

  it('reads again on its own socket’s change notices while live, gathered for 250 ms', async function () {
    const { server, client, clock, sockets, out, options } = setup()
    await render(
      <Probe client={client} gameId="g1" live options={options} out={out} />
    )
    await flush()
    const socket = sockets.latest()
    expect(socket.url).equals(
      'ws://localhost/api/v1/scoreboard/g1/socket?timeline=1'
    )
    expect(socket.headers).deep.equals({ Authorization: 'Bearer tok' })
    await act(async () => {
      socket.open()
    })
    expect(server.asked).deep.equals(['g1'])
    server.answers.set('g1', { ...SPONSORED, logo: null })
    await act(async () => {
      socket.receive({ type: 'changed' })
      socket.receive({ type: 'changed' })
      socket.receive({ type: 'somethingElse' })
      socket.receive('not json')
      clock.advance(NOTICE_DEBOUNCE_MS - 1)
    })
    await flush()
    expect(server.asked).deep.equals(['g1'])
    await act(async () => {
      socket.receive({ type: 'changed' })
      clock.advance(NOTICE_DEBOUNCE_MS)
    })
    await flush()
    expect(server.asked).deep.equals(['g1', 'g1'])
    expect(out.current?.sponsors?.logo).equals(null)
    // Open, it does not poll.
    await act(async () => {
      clock.advance(BOARD_POLL_MS)
    })
    await flush()
    expect(server.asked).deep.equals(['g1', 'g1'])
  })

  it('polls every 10 s while its socket is down, and for the rest of the game after a 4403', async function () {
    const { server, client, clock, sockets, out, options } = setup()
    await render(
      <Probe client={client} gameId="g1" live options={options} out={out} />
    )
    await flush()
    // Never opened: down from the start.
    await act(async () => {
      clock.advance(BOARD_POLL_MS)
    })
    await flush()
    expect(server.asked).deep.equals(['g1', 'g1'])
    await act(async () => {
      sockets.latest().open()
      sockets.latest().drop(1006)
      clock.advance(BOARD_POLL_MS)
    })
    await flush()
    expect(server.asked).deep.equals(['g1', 'g1', 'g1'])
    // Reopened after its 3 s retry, then refused for good.
    const before = sockets.sockets.length
    await act(async () => {
      sockets.latest().open()
      sockets.latest().drop(4403)
    })
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        clock.advance(BOARD_POLL_MS)
      })
      await flush()
    }
    expect(server.asked).to.have.length(6)
    expect(sockets.sockets.length).equals(before)
  })

  it('draws nothing when the first read fails, and keeps what it has when a later one does', async function () {
    const { server, client, out, options } = setup()
    server.failing.add('g1')
    await render(
      <Probe
        client={client}
        gameId="g1"
        live={false}
        options={options}
        out={out}
      />
    )
    await flush()
    expect(out.current?.sponsors).equals(null)
    server.failing.delete('g1')
    await act(async () => {
      out.current?.refetch()
    })
    await flush()
    expect(out.current?.sponsors).deep.equals(SPONSORED)
    server.failing.add('g1')
    await act(async () => {
      out.current?.refetch()
    })
    await flush()
    expect(out.current?.sponsors).deep.equals(SPONSORED)
  })

  it('opens no socket and no poll for the TV, which asks again with its own refresh', async function () {
    const { server, client, clock, sockets, out, options } = setup()
    await render(
      <Probe
        client={client}
        gameId="g1"
        live
        options={{ ...options, socket: false }}
        out={out}
      />
    )
    await flush()
    await act(async () => {
      clock.advance(BOARD_POLL_MS * 3)
    })
    await flush()
    expect(sockets.sockets).to.have.length(0)
    expect(server.asked).deep.equals(['g1'])
    server.answers.set('g1', { ...SPONSORED, leagueId: 'lea_refreshed' })
    await act(async () => {
      out.current?.refetch()
    })
    await flush()
    expect(server.asked).deep.equals(['g1', 'g1'])
    expect(out.current?.sponsors?.leagueId).equals('lea_refreshed')
  })

  it('stops reading, polling and listening once it is gone', async function () {
    const { server, client, clock, sockets, out, options } = setup()
    await render(
      <Probe client={client} gameId="g1" live options={options} out={out} />
    )
    await flush()
    const socket = sockets.latest()
    const refetch = out.current!.refetch
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    refetch()
    await act(async () => {
      clock.advance(BOARD_POLL_MS * 2)
    })
    await flush()
    expect(server.asked).deep.equals(['g1'])
    expect(socket.closedWith).equals(1000)
  })
})
