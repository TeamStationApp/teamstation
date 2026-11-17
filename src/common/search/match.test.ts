import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  compareMatches,
  fieldsOf,
  fold,
  lexicographicTop,
  type Matchable,
  matchScore,
  scoreMatch,
  wordsOf
} from './match'

const team = (
  id: string,
  name: string,
  place?: Array<string | null | undefined>
): Matchable => (place == null ? { id, name } : { id, name, place })

describe('fold', function () {
  it('lowercases and strips accents', function () {
    expect(fold('José Ramírez')).equals('jose ramirez')
    expect(fold('ÉLLY')).equals('elly')
    expect(fold('')).equals('')
  })

  it('folds letters with no combining mark as unaccent does', function () {
    expect(fold('Søren Łukasz Strauß')).equals('soren lukasz strauss')
    expect(fold('ØŁẞĐÆŒÞÐ')).equals('olssdaeoethd')
    expect(fold('øłßđæœþð')).equals('olssdaeoethd')
    expect(wordsOf('Tromsø IL')).deep.equals(['tromso', 'il'])
  })

  it('folds every apostrophe unaccent rewrites to a straight one', function () {
    for (const mark of ['’', '‘', '‛', '′', '＇', 'ʹ', 'ʻ', 'ʼ', 'ʽ', 'ˈ'])
      expect(fold(`O${mark}Brien`), mark).equals("o'brien")
  })
})

describe('wordsOf', function () {
  it('splits folded text on whitespace and punctuation', function () {
    expect(wordsOf('  San Diego,  CA ')).deep.equals(['san', 'diego', 'ca'])
    expect(wordsOf('Demo-City / North.Side')).deep.equals([
      'demo',
      'city',
      'north',
      'side'
    ])
  })

  it('keeps apostrophes inside a word', function () {
    expect(wordsOf("O'Neil Báez")).deep.equals(["o'neil", 'baez'])
    expect(wordsOf('D’Arnaud')).deep.equals(["d'arnaud"])
    expect(wordsOf('O‛Brien')).deep.equals(["o'brien"])
  })

  it('finds no words in blank text', function () {
    expect(wordsOf('  ,. ')).deep.equals([])
  })
})

describe('matchScore', function () {
  it('scores perfect, prefix and substring matches', function () {
    const score = matchScore(['hawks', 'dem', 'ity'], {
      name: ['demo', 'hawks'],
      place: ['demo', 'city']
    })
    expect(score.words).deep.equals(['perfect', 'prefix', 'substring'])
    expect(score.matched).equals(3)
    expect(score.points).equals(6)
    // 'hawks' and 'dem' cover 8 of the name's 9 characters; 'ity' is a place.
    expect(score.coverage).closeTo(8 / 9, 1e-9)
  })

  it('gives each field word to one typed word only', function () {
    const score = matchScore(['demo', 'demo'], { name: ['demo', 'hawks'] })
    expect(score.words).deep.equals(['perfect', null])
    expect(score.matched).equals(1)
  })

  it('takes the best unused word, not the first', function () {
    const score = matchScore(['hawk'], { name: ['blackhawks', 'hawk'] })
    expect(score.words).deep.equals(['perfect'])
    expect(score.coverage).closeTo(4 / 14, 1e-9)
  })

  it('prefers a name word over a place word of the same kind', function () {
    const score = matchScore(['demo'], { name: ['demo'], place: ['demo'] })
    expect(score.coverage).equals(1)
  })

  it('counts no coverage for a place match or an empty name', function () {
    expect(
      matchScore(['city'], { name: ['demo'], place: ['city'] }).coverage
    ).equals(0)
    expect(matchScore(['city'], { name: [], place: ['city'] }).coverage).equals(
      0
    )
  })

  it('matches nothing for unrelated words or none typed', function () {
    const none = matchScore(['zzz'], { name: ['demo'] })
    expect(none).deep.equals({
      matched: 0,
      points: 0,
      coverage: 0,
      words: [null]
    })
    expect(matchScore([], { name: ['demo'] }).matched).equals(0)
  })
})

describe('fieldsOf', function () {
  it('folds the name and every place part, skipping missing ones', function () {
    expect(
      fieldsOf(team('t', 'Démo Hawks', ['San Diego', null, undefined, 'US']))
    ).deep.equals({ name: ['demo', 'hawks'], place: ['san', 'diego', 'us'] })
    expect(fieldsOf(team('t', 'Hawks'))).deep.equals({
      name: ['hawks'],
      place: []
    })
  })
})

describe('scoreMatch', function () {
  it('is null when no typed word matched', function () {
    expect(scoreMatch(team('t', 'Hawks'), ['zzz'])).equals(null)
    expect(scoreMatch(team('t', 'Hawks'), ['haw'])?.score.matched).equals(1)
  })
})

describe('compareMatches and lexicographicTop', function () {
  const top = (candidates: Matchable[], text: string, n = 10): string[] =>
    lexicographicTop(candidates, wordsOf(text), n).map(
      each => each.candidate.id
    )

  it('ranks more typed words matched first', function () {
    expect(
      top([team('a', 'Demo Hawks'), team('b', 'Demo City Hawks')], 'demo city')
    ).deep.equals(['b', 'a'])
  })

  it('then ranks better kinds of match', function () {
    expect(
      top([team('a', 'Ademo'), team('b', 'Demos'), team('c', 'Demo')], 'demo')
    ).deep.equals(['c', 'b', 'a'])
  })

  it('then ranks the name the query covers more fully', function () {
    expect(
      top(
        [team('hawks', 'San Diego Hawks'), team('city', 'San Diego')],
        'san diego'
      )
    ).deep.equals(['city', 'hawks'])
  })

  it('then a shorter name, then the name, then the id', function () {
    // Equal coverage: both matched only by place.
    expect(
      top(
        [
          team('a', 'Longer Name', ['Demo City']),
          team('b', 'Short', ['Demo City'])
        ],
        'demo'
      )
    ).deep.equals(['b', 'a'])
    expect(
      top([team('a', 'Bbbb', ['Demo']), team('b', 'Aaaa', ['Demo'])], 'demo')
    ).deep.equals(['b', 'a'])
    expect(top([team('b', 'Demo'), team('a', 'Demo')], 'demo')).deep.equals([
      'a',
      'b'
    ])
    // Folded alike, told apart by the raw name.
    expect(top([team('a', 'Démo'), team('b', 'Demo')], 'demo')).deep.equals([
      'b',
      'a'
    ])
  })

  it('is a consistent comparator', function () {
    const a = scoreMatch(team('a', 'Demo'), ['demo'])!
    expect(compareMatches(a, a)).equals(0)
  })

  it('finds accented names by folded words', function () {
    expect(top([team('p', 'José Ramírez')], 'jose')).deep.equals(['p'])
  })

  it('finds a curly apostrophe by a straight one, and the other way', function () {
    expect(top([team('c', 'Demo O’Brien')], "o'brien")).deep.equals(['c'])
    expect(top([team('s', "Demo O'Brien")], 'o’brien')).deep.equals(['s'])
    expect(top([team('m', 'Demo Oʼbrien')], 'o‘brien')).deep.equals(['m'])
  })

  it('never returns a candidate no word matched', function () {
    expect(
      top([team('a', 'Demo Hawks'), team('b', 'Other')], 'hawks')
    ).deep.equals(['a'])
    expect(top([team('a', 'Demo')], '')).deep.equals([])
  })

  it('takes the first n', function () {
    const many = Array.from({ length: 25 }, (_, i) =>
      team(`t${String(i).padStart(2, '0')}`, 'Demo')
    )
    expect(top(many, 'demo', 20)).lengthOf(20)
    expect(top(many, 'demo', 20)[0]).equals('t00')
    expect(top(many, 'demo', 0)).deep.equals([])
    expect(top(many, 'demo', -1)).deep.equals([])
  })
})
