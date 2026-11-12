import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  DELETED_NAME,
  formatName,
  formatNames,
  type FormattedPerson,
  fullName,
  shortName,
  shortNames,
  shortParts
} from './names'
import {
  PLAYER_NAME_PRIVACY,
  type PlayerNamePrivacy
} from './playerNamePrivacy'

const person = (
  id: string,
  firstName: string,
  lastName: string
): {
  id: string
  firstName: string
  lastName: string
  displayName: string
} => ({
  id,
  firstName,
  lastName,
  displayName: `${firstName} ${lastName}`.trim()
})

describe('how a name is written', function () {
  it('is the first name and the last initial', function () {
    expect(shortName(person('1', 'Jordan', 'Pujols'))).equals('Jordan P')
  })

  it('keeps a one-letter surname whole', function () {
    expect(shortName(person('1', 'Jordan', 'P'))).equals('Jordan P')
  })

  it('manages a person with only one name', function () {
    expect(shortName(person('1', 'Casey', ''))).equals('Casey')
    expect(shortName(person('1', '', 'Mize'))).equals('Mize')
  })

  it('splits a display name when the halves are missing', function () {
    expect(shortName({ id: '1', displayName: 'Childe Harold Janvrin' })).equals(
      'Childe J'
    )
  })

  it('keeps a deleted account whole, read by its name alone', function () {
    expect(shortName({ id: '1', displayName: DELETED_NAME })).equals(
      'Deleted user'
    )
    expect(
      shortNames([
        { id: '1', displayName: DELETED_NAME },
        { id: '2', displayName: 'Deleted user ' }
      ])
    ).deep.equals(
      new Map([
        ['1', 'Deleted user'],
        ['2', 'Deleted user']
      ])
    )
  })

  it('leaves an empty name empty rather than inventing one', function () {
    expect(shortName({ id: '1', displayName: '' })).equals('')
  })
})

describe('a whole name', function () {
  it('is both halves, or whichever one there is', function () {
    expect(fullName(person('1', 'Jordan', 'Pujols'))).equals('Jordan Pujols')
    expect(fullName(person('1', 'Casey', ''))).equals('Casey')
    expect(fullName(person('1', '', 'Mize'))).equals('Mize')
  })

  it('is the display name for somebody with no halves', function () {
    expect(
      fullName({ id: '1', displayName: ' Childe Harold Janvrin ' })
    ).equals('Childe Harold Janvrin')
  })
})

describe('a list of names', function () {
  it('leaves names that do not collide alone', function () {
    const names = shortNames([
      person('1', 'Jordan', 'Pujols'),
      person('2', 'Casey', 'Mize')
    ])
    expect(names.get('1')).equals('Jordan P')
    expect(names.get('2')).equals('Casey M')
  })

  it('writes two names that share a short form the same', function () {
    const names = shortNames([
      person('1', 'Josh', 'Smith'),
      person('2', 'Josh', 'Staumont')
    ])
    expect(names.get('1')).equals('Josh S')
    expect(names.get('2')).equals('Josh S')
  })

  it('does not invent a difference between two of the same name', function () {
    const names = shortNames([
      person('1', 'Jordan', 'Pujols'),
      person('2', 'Jordan', 'Pujols')
    ])
    expect(names.get('1')).equals('Jordan P')
    expect(names.get('2')).equals('Jordan P')
  })
})

describe('the same person listed twice', function () {
  it('is written once, as one person', function () {
    const twice = person('1', 'Henry', 'Hicks')
    const names = shortNames([twice, twice, person('2', 'Casey', 'Mize')])
    expect(names.get('1')).equals('Henry H')
    expect(names.get('2')).equals('Casey M')
  })
})

describe('a short name in two halves', function () {
  it('splits where the short name was built, and keeps a name with no first half whole', function () {
    const jordan = person('a', 'Jordan', 'Palmeiro')
    expect(shortParts(jordan, 'Jordan P')).deep.equals({
      first: 'Jordan',
      last: 'P'
    })
    expect(
      shortParts({ id: 'b', displayName: 'Ichiro' }, 'Ichiro')
    ).deep.equals({ first: 'Ichiro', last: '' })
    expect(shortParts(person('c', '', 'Suzuki'), 'Suzuki')).deep.equals({
      first: '',
      last: 'Suzuki'
    })
  })

  it('splits a row label that shares its short form with another, as the row reads it', function () {
    const names = shortNames([
      person('a', 'Josh', 'Smith'),
      person('b', 'Josh', 'Staumont')
    ])
    const josh = person('b', 'Josh', 'Staumont')
    expect(shortParts(josh, names.get('b')!)).deep.equals({
      first: 'Josh',
      last: 'S'
    })
  })

  it('splits a label whose format abbreviated the first name', function () {
    expect(shortParts(person('a', 'Alex', 'Lee'), 'A L')).deep.equals({
      first: 'A',
      last: 'L'
    })
    expect(shortParts(person('a', 'Alex', 'Lee'), 'A Lee')).deep.equals({
      first: 'A',
      last: 'Lee'
    })
  })
})

describe('a public format', function () {
  const alex = person('1', 'Alex', 'Lee')

  it('writes each format', function () {
    expect(formatName(alex, 'firstLastInitial')).equals('Alex L')
    expect(formatName(alex, 'initialLast')).equals('A Lee')
    expect(formatName(alex, 'initials')).equals('A L')
    expect(formatName(alex, 'full')).equals('Alex Lee')
  })

  it('keeps a one-letter surname and leaves a missing half out', function () {
    const short = person('1', 'Alex', 'L')
    expect(formatName(short, 'firstLastInitial')).equals('Alex L')
    expect(formatName(short, 'initialLast')).equals('A L')
    const given = person('2', 'Casey', '')
    expect(formatName(given, 'initialLast')).equals('C')
    expect(formatName(given, 'initials')).equals('C')
    expect(formatName(given, 'full')).equals('Casey')
    const family = person('3', '', 'Mize')
    expect(formatName(family, 'initialLast')).equals('Mize')
    expect(formatName(family, 'initials')).equals('M')
  })

  it('leaves an empty name empty', function () {
    for (const format of PLAYER_NAME_PRIVACY)
      expect(formatName({ id: '1', displayName: '' }, format)).equals('')
  })

  it('keeps a deleted account whole in every format', function () {
    const gone = { id: '1', firstName: DELETED_NAME, displayName: DELETED_NAME }
    const unnamed = { id: '2', displayName: DELETED_NAME }
    for (const format of PLAYER_NAME_PRIVACY) {
      expect(formatName(gone, format)).equals(DELETED_NAME)
      expect(formatName(unnamed, format)).equals(DELETED_NAME)
    }
  })

  it('splits a name stored only as a display name', function () {
    const mary = { id: '1', displayName: 'Mary Ann Lee' }
    expect(formatName(mary, 'firstLastInitial')).equals('Mary L')
    expect(formatName(mary, 'initialLast')).equals('M Lee')
    expect(formatName(mary, 'initials')).equals('M L')
    expect(formatName(mary, 'full')).equals('Mary Ann Lee')
  })
})

describe('a list in public formats', function () {
  const entry = (
    id: string,
    first: string,
    last: string,
    format: PlayerNamePrivacy
  ): FormattedPerson => ({ person: person(id, first, last), format })

  it('answers what shortNames does when all are the built-in format', function () {
    const people = [
      person('1', 'Jordan', 'Pujols'),
      person('2', 'Jordan', 'Palmeiro'),
      person('3', 'Jordan', 'Palms'),
      person('4', 'Casey', 'Mize'),
      person('5', 'Casey', 'Mize')
    ]
    expect(
      formatNames(
        people.map(one => ({ person: one, format: 'firstLastInitial' }))
      )
    ).deep.equals(shortNames(people))
  })

  it('writes two names that share a short form the same in every abbreviating format', function () {
    const josh = (format: PlayerNamePrivacy): Map<string | number, string> =>
      formatNames([
        entry('1', 'Josh', 'Smith', format),
        entry('2', 'Josh', 'Staumont', format)
      ])
    expect([...josh('firstLastInitial').values()]).deep.equals([
      'Josh S',
      'Josh S'
    ])
    expect([...josh('initials').values()]).deep.equals(['J S', 'J S'])
    expect([...josh('full').values()]).deep.equals([
      'Josh Smith',
      'Josh Staumont'
    ])
    const smith = formatNames([
      entry('1', 'Lee', 'Smith', 'initialLast'),
      entry('2', 'Lonnie', 'Smith', 'initialLast')
    ])
    expect([...smith.values()]).deep.equals(['L Smith', 'L Smith'])
  })

  it('leaves two identical full names identical', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'full'),
      entry('2', 'Alex', 'Lee', 'full')
    ])
    expect(names.get('1')).equals('Alex Lee')
    expect(names.get('2')).equals('Alex Lee')
  })

  it('writes each name in its own format, across formats, alone', function () {
    const names = formatNames([
      entry('1', 'Lee', 'Smith', 'initials'),
      entry('2', 'Lonnie', 'Smith', 'initialLast'),
      entry('3', 'L', 'S', 'firstLastInitial'),
      entry('4', 'Josh', 'Smith', 'firstLastInitial'),
      entry('5', 'Josh', 'Staumont', 'full')
    ])
    expect(Object.fromEntries(names)).deep.equals({
      1: 'L S',
      2: 'L Smith',
      3: 'L S',
      4: 'Josh S',
      5: 'Josh Staumont'
    })
  })

  it('writes somebody listed in two formats in the more restrictive', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'full'),
      entry('1', 'Alex', 'Lee', 'initials')
    ])
    expect(names.get('1')).equals('A L')
  })

  it('keeps the most restrictive format of somebody listed twice beside a twin', function () {
    const names = formatNames([
      entry('1', 'Josh', 'Smith', 'full'),
      entry('2', 'Josh', 'Staumont', 'firstLastInitial'),
      entry('1', 'Josh', 'Smith', 'firstLastInitial')
    ])
    expect(names.size).equals(2)
    expect(names.get('1')).equals('Josh S')
    expect(names.get('2')).equals('Josh S')
  })

  it('gives a model no surname for somebody with no first name', function () {
    const names = formatNames([entry('1', '', 'Pujols', 'firstLastInitial')], {
      spoken: true
    })
    expect(names.get('1')).equals('P')
    expect(
      formatNames([entry('1', '', 'Pujols', 'firstLastInitial')]).get('1')
    ).equals('Pujols')
  })

  it('gives a model each name in its format, twins alike', function () {
    const names = formatNames(
      [
        entry('1', 'Alex', 'Lee', 'firstLastInitial'),
        entry('2', 'Alex', 'Leigh', 'firstLastInitial'),
        entry('3', 'Al', 'Lim', 'initials'),
        entry('4', 'Amy', 'Lopez', 'initials')
      ],
      { spoken: true }
    )
    expect(names.get('1')).equals('Alex L')
    expect(names.get('2')).equals('Alex L')
    expect(names.get('3')).equals('A L')
    expect(names.get('4')).equals('A L')
  })

  it('does not invent a difference nothing can show', function () {
    const names = formatNames([
      entry('1', 'Al', 'Lee', 'initials'),
      entry('2', 'Al', 'Lee', 'initials')
    ])
    expect(names.get('1')).equals('A L')
    expect(names.get('2')).equals('A L')
  })
})
