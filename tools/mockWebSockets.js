/**
 * Tiny mock of the gamestation server's WebSocket endpoints, used by the
 * visual-regression screenshot harness in tools/screenshotWeb.js.
 *
 * The web client (src/client/Scoreboard.tsx and src/client/Dashboard.tsx)
 * connects to:
 *   ws://localhost:8008/sockets/api/v1/scoreboard/<eventId>
 *   ws://localhost:8008/sockets/api/v1/dashboard/<eventId>
 *
 * We push a single deterministic payload on connect for each so the
 * baseline + post-upgrade screenshots can be diffed pixel-for-pixel.
 *
 * Run standalone:  node tools/mockWebSockets.js
 * Or imported:     require('./mockWebSockets').start({ port: 8008 })
 */
const WebSocket = require('ws')

const FIXED_SCORE_STATE = {
  inGame: true,
  pitcherName: 'M. Rivera',
  batterName: 'J. Smith',
  batterNumber: 27,
  batterNumHits: 2,
  batterAtBats: 4,
  numPitches: 3,
  balls: 2,
  strikes: 1,
  outs: 1,
  base1: false,
  base2: true,
  base3: false,
  inning: 7,
  half: 'top',
  homeTeam: 'Cyclones',
  awayTeam: 'North Pines Hawks',
  homeScore: 9,
  awayScore: 23,
  pitchSpeed: 51
}

const FIXED_OVERRIDES = {
  overrideCountEnabled: false,
  overrideBasesEnabled: false,
  overrideTeamEnabled: false,
  overrideScoreEnabled: false,
  overrideInningEnabled: false
}

function start({ port = 8008 } = {}) {
  const wss = new WebSocket.Server({ port, host: '0.0.0.0' })

  wss.on('listening', () => {
    console.log(`[mockWebSockets] listening on ws://0.0.0.0:${port}`)
  })

  wss.on('connection', (socket, req) => {
    const url = req.url || '/'
    const scoreboardMatch = url.match(
      /\/sockets\/api\/v1\/scoreboard\/([^/?]+)/
    )
    const dashboardMatch = url.match(/\/sockets\/api\/v1\/dashboard\/([^/?]+)/)

    if (scoreboardMatch) {
      const eventId = decodeURIComponent(scoreboardMatch[1])
      console.log(`[mockWebSockets] scoreboard connect eventId=${eventId}`)
      // Scoreboard expects a raw ScoreState, not a wrapped message.
      socket.send(JSON.stringify(FIXED_SCORE_STATE))
    } else if (dashboardMatch) {
      const eventId = decodeURIComponent(dashboardMatch[1])
      console.log(`[mockWebSockets] dashboard connect eventId=${eventId}`)
      socket.send(
        JSON.stringify({ type: 'autoState', data: FIXED_SCORE_STATE })
      )
      socket.send(
        JSON.stringify({ type: 'overrideUpdate', data: FIXED_OVERRIDES })
      )
    } else {
      console.log(`[mockWebSockets] unknown url ${url} - closing`)
      socket.close()
    }
  })

  wss.on('error', err => {
    console.error('[mockWebSockets] server error', err)
  })

  return wss
}

module.exports = { start, FIXED_SCORE_STATE, FIXED_OVERRIDES }

if (require.main === module) {
  start({ port: Number(process.env.MOCK_PORT || 8008) })
}
