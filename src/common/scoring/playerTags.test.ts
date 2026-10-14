import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  EXCLUDED_PAIRS,
  fieldingIds,
  idOfTag,
  idOfWrittenTag,
  PAIRS,
  positionSaid,
  TAGGED_IDS,
  taggedIds,
  taggedNames,
  tagOf,
  withNames,
  writtenTag
} from './playerTags'
import { POSITIONS } from './state'

describe('player tags', function () {
  it('gives every id a game can hold a tag of two letters and a digit, and reads it back', function () {
    // Far more than both rosters and every player added at the field.
    expect(TAGGED_IDS).greaterThan(4000)
    const seen = new Set<string>()
    for (let id = 0; id < TAGGED_IDS; id++) {
      const tag = tagOf(id)
      expect(tag).match(/^[A-Z]{2}[0-9]$/)
      expect(tag.endsWith(String(id % 10)), tag).equals(true)
      expect(idOfTag(tag)).equals(id)
      seen.add(tag)
    }
    expect(seen.size).equals(TAGGED_IDS)
  })

  it('never makes a position, a base, a baseball abbreviation, a word or a digit look-alike', function () {
    const required = [
      ...['SS', 'CF', 'LF', 'RF', 'PH', 'PR', 'DH', 'HR', 'RB', 'BB', 'IP'],
      ...['ER', 'KO', 'OF', 'IF', 'UT', 'PO', 'SB', 'CS', 'WP', 'PB', 'HB'],
      ...['FC', 'DP', 'TP', 'SF', 'SH', 'AB', 'BA', 'OB', 'PA', 'GO', 'FO'],
      ...['LD', 'GB', 'FB']
    ]
    expect(EXCLUDED_PAIRS).to.include.members(required)
    const used = new Set<string>()
    for (let id = 0; id < TAGGED_IDS; id++) used.add(tagOf(id).slice(0, 2))
    expect([...used].sort()).deep.equals([...PAIRS].sort())
    for (const pair of PAIRS) {
      expect(EXCLUDED_PAIRS, pair).not.include(pair)
      // I and O read as 1 and 0; a doubled letter reads as one.
      expect(pair, pair).not.match(/[IO]/)
      expect(pair[0], pair).not.equals(pair[1])
    }
    expect(new Set(PAIRS).size).equals(PAIRS.length)
  })

  it('gives the players of one game letters of their own, far apart for neighbouring ids', function () {
    const pairs = Array.from({ length: PAIRS.length }, (_, id) =>
      tagOf(id).slice(0, 2)
    )
    expect(new Set(pairs).size).equals(PAIRS.length)
    for (let id = 1; id < 60; id++)
      expect(tagOf(id)[0], `${id - 1} and ${id}`).not.equals(tagOf(id - 1)[0])
  })

  it('has no tag for an id out of range', function () {
    for (const id of [-1, 1.5, Number.NaN, TAGGED_IDS])
      expect(() => tagOf(id), String(id)).to.throw(RangeError)
  })

  it('reads a tag in either case, and nothing else as one', function () {
    const tag = tagOf(27)
    expect(idOfTag(` ${tag.toLowerCase()} `)).equals(27)
    for (const said of ['27', '7', 'SS', 'SS5', tag.slice(0, 2), `${tag}1`, ''])
      expect(idOfTag(said), said).equals(undefined)
    // An excluded pair with a digit is no tag either.
    expect(idOfTag('SS5')).equals(undefined)
  })

  it('reads the one tag of a player copied as the game writes him', function () {
    expect(idOfWrittenTag(tagOf(14))).equals(14)
    expect(idOfWrittenTag(`SS Mike T. #5 ${writtenTag(14)}`)).equals(14)
    expect(idOfWrittenTag(`${writtenTag(14)} and ${writtenTag(15)}`)).equals(
      undefined
    )
    expect(idOfWrittenTag('Mike T. #5')).equals(undefined)
  })

  it('finds the players a written game gives a tag', function () {
    expect(writtenTag(3)).equals(`(tag ${tagOf(3)})`)
    const game = `Batter: Ian K. #4 ${writtenTag(4)}. On second: Joe B. #9 ${writtenTag(3)}. Hosts (tag SS5) and (tag ${tagOf(7).toLowerCase()})`
    expect([...taggedIds(game)].sort((a, b) => a - b)).deep.equals([3, 4])
  })

  it('finds the name a written game gives each tag', function () {
    const game = `Batter: Ian K. #4 ${writtenTag(4)}. Pitcher: Max S. ${writtenTag(8)}.\nOn first: nobody. On second: Joe B. #9 ${writtenTag(3)}.\nFielders: P Max S. ${writtenTag(8)}, SS Noah D. #5 ${writtenTag(14)}, 3B Liam O. #6 ${writtenTag(15)}. Hosts (tag SS5)`
    expect([...taggedNames(game)]).deep.equals([
      [tagOf(4), 'Ian K.'],
      [tagOf(8), 'Max S.'],
      [tagOf(3), 'Joe B.'],
      [tagOf(14), 'Noah D.'],
      [tagOf(15), 'Liam O.']
    ])
  })

  it('finds the fielder a written game lists at each position, and no one else', function () {
    const game = [
      `Batter: Ian K. #4 ${writtenTag(4)}. Pitcher: Max S. ${writtenTag(8)}.`,
      `On first: nobody. On second: Joe B. #9 ${writtenTag(3)}.`,
      `Fielders: ${POSITIONS.map((position, index) =>
        position === 'CF'
          ? 'CF nobody'
          : `${position} Host ${index}. #${index + 1} ${writtenTag(10 + index)}`
      ).join(', ')}.`,
      'ROSTERS',
      `  Ian K. #4 — bats 1st, plays CF ${writtenTag(4)}`
    ].join('\n')
    expect([...fieldingIds(game)]).deep.equals(
      POSITIONS.flatMap((position, index) =>
        position === 'CF' ? [] : [[position, 10 + index]]
      )
    )
    // A game with no fielders, or none with a tag.
    expect(fieldingIds('Batter: nobody.').size).equals(0)
    expect(fieldingIds('Fielders: P nobody, SS (tag SS5).').size).equals(0)
  })

  it('finds a fielder whose name contains a comma', function () {
    const game = `Fielders: 3B Lee, Jr. #5 ${writtenTag(15)}, SS Noah D. #2 ${writtenTag(14)}.`
    expect(fieldingIds(game).get('3B')).equals(15)
    expect(fieldingIds(game).get('SS')).equals(14)
  })

  it('reads a position a model wrote for a fielder, as the game writes it or as a scorer says it', function () {
    for (const position of POSITIONS) {
      expect(positionSaid(position)).equals(position)
      expect(positionSaid(` ${position.toLowerCase()} `)).equals(position)
    }
    const spoken: Array<[string, string]> = [
      ['pitcher', 'P'],
      ['the catcher', 'C'],
      ['First Baseman', '1B'],
      ['first base', '1B'],
      ['the second baseman', '2B'],
      ['second-base', '2B'],
      ['shortstop', 'SS'],
      ['short stop', 'SS'],
      ['third baseman', '3B'],
      ['third base', '3B'],
      ['the left fielder', 'LF'],
      ['left-field', 'LF'],
      ['center fielder', 'CF'],
      ['center field', 'CF'],
      ['The Right Fielder', 'RF'],
      ['right field', 'RF'],
      ['RF.', 'RF'],
      ['the right fielder.', 'RF'],
      ['left', 'LF'],
      ['center', 'CF'],
      ['right', 'RF'],
      ['leftfielder', 'LF'],
      ['centerfielder', 'CF'],
      ['rightfielder', 'RF'],
      ['3rd baseman', '3B'],
      ['3rd base', '3B'],
      ['3rd', '3B'],
      ['thirdbaseman', '3B'],
      ['1st baseman', '1B'],
      ['2nd', '2B'],
      // Before his name, as the game writes it, with no tag.
      ['LF Max S.', 'LF'],
      ['1B  Ian K. #4', '1B']
    ]
    for (const [said, position] of spoken)
      expect(positionSaid(said), said).equals(position)
    for (const said of [
      'DH',
      'outfield',
      'the',
      '7',
      '',
      tagOf(3),
      'LFX Max',
      'lf Max S.',
      'Chase'
    ])
      expect(positionSaid(said), said).equals(undefined)
  })

  describe('text for the scorer', function () {
    const names = new Map([
      [tagOf(1), 'Altuve J.'],
      [tagOf(2), 'Bregman A.']
    ])
    const named = (text: string): string => withNames(text, names)

    it('names the player of a bare tag', function () {
      expect(named(`Yes, ${tagOf(1)} steals second`)).equals(
        'Yes, Altuve J. steals second'
      )
      // In any case, as a model once wrote "Rd1".
      const mixed = tagOf(1)[0] + tagOf(1).slice(1).toLowerCase()
      expect(named(`${mixed} (the runner on first) steals`)).equals(
        'Altuve J. (the runner on first) steals'
      )
      // Not in capitals and of nobody: a word, left as it is.
      expect(named(`${tagOf(7).toLowerCase()} runs`)).equals(
        `${tagOf(7).toLowerCase()} runs`
      )
    })

    it('names the player of a bracketed tag', function () {
      expect(named(`Did ${writtenTag(1)} steal?`)).equals(
        'Did Altuve J. steal?'
      )
      expect(named(`Runner (${tagOf(2)}) or [${tagOf(1)}]`)).equals(
        'Runner Bregman A. or Altuve J.'
      )
      expect(named(`Who? (tag ${tagOf(2).toLowerCase()})`)).equals(
        'Who? Bregman A.'
      )
    })

    it('never doubles a name written beside its tag', function () {
      for (const text of [
        `Altuve J. ${writtenTag(1)} steals`,
        `Altuve J. (${tagOf(1)}) steals`,
        `Altuve J. ${tagOf(1)} steals`,
        `Altuve J. #27 ${writtenTag(1)} steals`,
        `Altuve J. (#27) [${tagOf(1)}] steals`,
        `altuve j. ${tagOf(1)} steals`,
        `${tagOf(1)} (Altuve J.) steals`,
        `${tagOf(1)} Altuve J. steals`
      ])
        expect(named(text), text).match(
          /^(?:Altuve J\.|altuve j\.)(?: (?:\(#27\)|#27))? steals$/
        )
    })

    it('takes out a tag of nobody in the game, and an old app’s id', function () {
      expect(named(`Yes, ${tagOf(7)} steals second`)).equals(
        'Yes, steals second'
      )
      expect(named(`Which one, ${writtenTag(7)} or (id 16)?`)).equals(
        'Which one, or?'
      )
      expect(named(`[${tagOf(7)}]`)).equals('')
      expect(withNames(`Yes, ${tagOf(1)} steals`, new Map())).equals(
        'Yes, steals'
      )
    })

    it('names every player of several tags, and leaves what only looks like one', function () {
      expect(
        named(
          `Double steal: ${tagOf(2)} to third, ${tagOf(1)} to second, ${writtenTag(7)} stays`
        )
      ).equals('Double steal: Bregman A. to third, Altuve J. to second, stays')
      // Not a tag: an excluded pair, a word and a position.
      expect(named('RF1 and SS2, then 1B3 or AB4')).equals(
        'RF1 and SS2, then 1B3 or AB4'
      )
      expect(named('Ball four, no tags here.')).equals(
        'Ball four, no tags here.'
      )
    })
  })
})
