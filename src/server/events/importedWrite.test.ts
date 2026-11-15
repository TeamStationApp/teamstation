import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGumboPlay } from '../../common/gumboPlay'
import {
  importedRecords,
  importedSetup
} from '../../common/scoring/importedRecord'
import {
  storedForm,
  withNames,
  withoutNames
} from '../../common/scoring/storedNames'
import { storedConvertedPlay } from './importedWrite'

/**
 * A converted play as it is stored: its record by team and naming nobody,
 * its words kept where no sentence reproduces them, and the same after any
 * later store or named read.
 */

type Json = Record<string, unknown>

const TEAMS = {
  away: { id: 'team-away', name: '', logoUrl: null },
  home: { id: 'team-home', name: '', logoUrl: null }
}

const raw = JSON.parse(
  readFileSync('src/common/scoring/fixtures/imported/inventedGame.json', 'utf8')
) as Json[]

const NAMES = new Map<number, string>(
  Array.from({ length: 11 }, (_, i) => [1000 + i, `Person ${i}`])
)
const nameOf = (id: number): string | undefined => NAMES.get(id)

function converted(play: Json): Json {
  const plays = raw.map(item => asGumboPlay(item))
  const out = importedRecords(
    { plays, currentPlay: null },
    {
      gamePk: 'gam_x',
      teams: TEAMS,
      setup: importedSetup(plays, { away: [], home: [] }, TEAMS)
    }
  )
  const index = (play.about as { atBatIndex: number }).atBatIndex
  const record = out.records.get(index)
  if (record == null) throw new Error('No record')
  return storedConvertedPlay(play, record, TEAMS, nameOf)
}

describe('a converted play as it is stored', function () {
  it('holds its record by team, naming nobody', function () {
    const stored = converted(raw[1])
    const record = stored.teamStation as Json
    expect(record.version).to.be.oneOf([3, 4])
    const text = JSON.stringify(record)
    expect(text).not.match(/"fullName":"[^"]/)
    expect(text).include('team-away')
  })

  it('keeps a person’s own words no sentence reproduces, and never rewords them', function () {
    const typed = structuredClone(raw[1])
    const events = typed.playEvents as Json[]
    const at = events.findIndex(event => event.isPitch !== true)
    events[at] = {
      ...events[at],
      details: {
        ...(events[at].details as Json),
        description: 'The scorer’s own note, which no sentence says'
      }
    }
    const stored = converted(typed)
    const kept = (stored.playEvents as Json[])[at]
    expect((kept.details as Json).description).equals(
      'The scorer’s own note, which no sentence says'
    )
    expect(kept.said ?? null).equals(null)
    // A later store, with no source, and a named read and save leave it.
    expect(storedForm(stored).document).deep.equals(stored)
    expect(withoutNames(withNames(stored, nameOf))).deep.equals(stored)
  })

  it('is the same after a second store of every play', function () {
    for (const play of raw) {
      const stored = converted(play)
      expect(storedForm(stored).document).deep.equals(stored)
      expect(withoutNames(withNames(stored, nameOf))).deep.equals(stored)
    }
  })
})
