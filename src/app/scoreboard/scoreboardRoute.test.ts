import { expect } from 'chai'
import { describe, it } from 'mocha'

import { scoreboardPageFor, socketUrlFor } from './scoreboardRoute'

describe('scoreboard page addresses', function () {
  it('reads the sample page', function () {
    expect(scoreboardPageFor('/scoreboard-sample', '')).deep.equals({
      kind: 'sample'
    })
  })

  it('reads a live board, loud or quiet', function () {
    expect(scoreboardPageFor('/scoreboard/g1', '')).deep.equals({
      kind: 'live',
      gameId: 'g1',
      quiet: false
    })
    expect(scoreboardPageFor('/scoreboard/g1', '?quiet=1')).deep.equals({
      kind: 'live',
      gameId: 'g1',
      quiet: true
    })
    expect(scoreboardPageFor('/scoreboard/g1/', 'quiet=0')).deep.equals({
      kind: 'live',
      gameId: 'g1',
      quiet: false
    })
  })

  it('leaves every other address to the app', function () {
    expect(scoreboardPageFor('/scoreboard', '')).equals(undefined)
    expect(scoreboardPageFor('/games/g1', '')).equals(undefined)
    expect(scoreboardPageFor('/scoreboard/g1/extra', '')).equals(undefined)
    expect(scoreboardPageFor('/', '')).equals(undefined)
  })
})

describe('scoreboard socket address', function () {
  it('is wss beside a relative API on an https page', function () {
    expect(
      socketUrlFor({ protocol: 'https:', host: 'host' }, '/api/v1', 'g1')
    ).equals('wss://host/api/v1/scoreboard/g1/socket')
  })

  it('is ws on the start.web API base, whatever the page', function () {
    expect(
      socketUrlFor(
        { protocol: 'http:', host: '127.0.0.1:8080' },
        'http://127.0.0.1:9100/api/v1',
        'g1'
      )
    ).equals('ws://127.0.0.1:9100/api/v1/scoreboard/g1/socket')
    expect(
      socketUrlFor(undefined, 'https://app.teamstation.app/api/v1/', 'g1')
    ).equals('wss://app.teamstation.app/api/v1/scoreboard/g1/socket')
  })

  it('names the dashboard socket and encodes the game', function () {
    expect(
      socketUrlFor(
        { protocol: 'http:', host: 'localhost' },
        'api/v1',
        'a b',
        'dashboard'
      )
    ).equals('ws://localhost/api/v1/scoreboard/a%20b/dashboard')
  })

  it('refuses a relative API with no page to resolve it against', function () {
    expect(() => socketUrlFor(undefined, '/api/v1', 'g1')).throws(
      'No origin to resolve /api/v1 against'
    )
  })
})
