import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { disabledFor, STREAMING, streamingKnown } from './streaming'

describe('streaming scripts', function () {
  it('are disabled from the sweep unless E2E_STREAMING=1 asks for them', function () {
    const file = 'src/app/player/liveOutage.e2e.ts'
    expect(disabledFor(file, {})).includes('streaming')
    expect(disabledFor(file, { E2E_STREAMING: '1' })).equals(null)
    expect(disabledFor('src/app/scoring/scoring.e2e.ts', {})).equals(null)
  })

  it('name only scripts the suite lists', function () {
    const { modules } = JSON.parse(
      readFileSync(join(__dirname, '../legacy.json'), 'utf8')
    ) as { modules: Record<string, string> }
    expect(STREAMING.filter(file => modules[file] == null)).deep.equals([])
  })

  describe('values from the streaming fixture world', function () {
    const fixture = {
      accounts: {
        coach: { email: 'coach@example.test', userId: 'usr_coach' },
        viewer: { email: 'viewer@example.test', userId: 'usr_viewer' },
        player: { email: 'player@example.test', userId: 'usr_player' }
      },
      ids: {
        homeTeam: 'tem_home',
        game: 'gam_empty',
        gameWithVideos: 'gam_two'
      }
    }
    const all = [
      'TS_STREAM_EMAIL',
      'TS_STREAM_VIEWER_EMAIL',
      'TS_STREAM_GAME',
      'TS_STREAM_WALKUP_PLAYER'
    ]

    it('gives who films, who watches, the empty game and the walk-up player', function () {
      expect(
        streamingKnown('src/app/stream/anglesEdgeStates.e2e.ts', all, fixture)
      ).deep.equals({
        TS_STREAM_EMAIL: 'coach@example.test',
        TS_STREAM_VIEWER_EMAIL: 'viewer@example.test',
        TS_STREAM_GAME: 'gam_empty',
        TS_STREAM_WALKUP_PLAYER: 'tem_home/usr_player'
      })
    })

    it('gives the game with two videos to the scripts that need angle pills', function () {
      for (const file of [
        'src/app/stream/bridgeSmoke.e2e.ts',
        'src/app/stream/streamSettings.e2e.ts'
      ]) {
        expect(streamingKnown(file, ['TS_STREAM_GAME'], fixture)).deep.equals({
          TS_STREAM_GAME: 'gam_two'
        })
      }
    })

    it('answers only the names a script uses, and nothing the world lacks', function () {
      expect(
        streamingKnown(
          'src/app/stream/radarPairing.e2e.ts',
          ['TS_STREAM_EMAIL'],
          fixture
        )
      ).deep.equals({ TS_STREAM_EMAIL: 'coach@example.test' })
      expect(
        streamingKnown('src/app/stream/radarPairing.e2e.ts', all, {
          accounts: {},
          ids: {}
        })
      ).deep.equals({})
    })
  })
})
