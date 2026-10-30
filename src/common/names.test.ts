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

  it('takes another letter when two would read the same', function () {
    const names = shortNames([
      person('1', 'Jordan', 'Pujols'),
      person('2', 'Jordan', 'Palmeiro')
    ])
    expect(names.get('1')).equals('Jordan Pu')
    expect(names.get('2')).equals('Jordan Pa')
  })

  it('takes as many letters as it needs', function () {
    const names = shortNames([
      person('1', 'Jordan', 'Palmeiro'),
      person('2', 'Jordan', 'Palms')
    ])
    // `Palm` is still shared, so it takes one more: `Palme` and `Palms`.
    expect(names.get('1')).equals('Jordan Palme')
    expect(names.get('2')).equals('Jordan Palms')
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
  it('is one person, not a collision with themselves', function () {
    const twice = person('1', 'Henry', 'Hicks')
    const names = shortNames([twice, twice, person('2', 'Casey', 'Mize')])
    expect(names.get('1')).equals('Henry H')
    expect(names.get('2')).equals('Casey M')
  })
})

describe('a short name in two halves', function () {
  it('splits where the short name was built, and keeps a name with no first half whole', function () {
    const jordan = person('a', 'Jordan', 'Palmeiro')
    expect(shortParts(jordan, 'Jordan Pa')).deep.equals({
      first: 'Jordan',
      last: 'Pa'
    })
    expect(
      shortParts({ id: 'b', displayName: 'Ichiro' }, 'Ichiro')
    ).deep.equals({ first: 'Ichiro', last: '' })
    expect(shortParts(person('c', '', 'Suzuki'), 'Suzuki')).deep.equals({
      first: '',
      last: 'Suzuki'
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

  it('lengthens the given name of a first initial and last name', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'initialLast'),
      entry('2', 'Amy', 'Lee', 'initialLast')
    ])
    expect(names.get('1')).equals('Al Lee')
    expect(names.get('2')).equals('Am Lee')
  })

  it('lengthens initials by the given name, then the surname', function () {
    const given = formatNames([
      entry('1', 'Alex', 'Lee', 'initials'),
      entry('2', 'Amy', 'Lopez', 'initials')
    ])
    expect(given.get('1')).equals('Al L')
    expect(given.get('2')).equals('Am L')
    const surname = formatNames([
      entry('1', 'Al', 'Lee', 'initials'),
      entry('2', 'Al', 'Lopez', 'initials')
    ])
    expect(surname.get('1')).equals('Al Le')
    expect(surname.get('2')).equals('Al Lo')
  })

  it('leaves two identical full names identical', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'full'),
      entry('2', 'Alex', 'Lee', 'full')
    ])
    expect(names.get('1')).equals('Alex Lee')
    expect(names.get('2')).equals('Alex Lee')
  })

  it('breaks a collision across formats', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'initials'),
      entry('2', 'Amy', 'Lopez', 'initialLast'),
      entry('3', 'A', 'L', 'firstLastInitial')
    ])
    expect(names.get('1')).equals('Al L')
    expect(names.get('3')).equals('A L')
    expect(names.get('2')).equals('A Lopez')
  })

  it('breaks a collision on opposite teams of one box score', function () {
    const names = formatNames([
      entry('1', 'Jordan', 'Pujols', 'firstLastInitial'),
      entry('2', 'Jordan', 'Palmeiro', 'firstLastInitial'),
      entry('3', 'Casey', 'Mize', 'full')
    ])
    expect(names.get('1')).equals('Jordan Pu')
    expect(names.get('2')).equals('Jordan Pa')
    expect(names.get('3')).equals('Casey Mize')
  })

  it('writes somebody listed in two formats in the more restrictive', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'full'),
      entry('1', 'Alex', 'Lee', 'initials')
    ])
    expect(names.get('1')).equals('A L')
  })

  it('goes on when a lengthened name lands on another', function () {
    const names = formatNames([
      entry('1', 'Alex', 'Lee', 'initials'),
      entry('2', 'Amy', 'Lin', 'initials'),
      entry('3', 'Al', 'Lu', 'firstLastInitial')
    ])
    expect(new Set(names.values()).size).equals(3)
  })

  it('ends, with nobody left identical, whatever the mix', function () {
    const names = formatNames([
      entry('1', 'Ann', 'Le', 'firstLastInitial'),
      entry('2', 'Ann', 'Leonard', 'firstLastInitial'),
      entry('3', 'Ann', 'L', 'firstLastInitial'),
      entry('4', 'Ann', 'Leo', 'full')
    ])
    expect(names.size).equals(4)
    const mixed = formatNames([
      entry('1', 'Alan', 'Lindsey', 'initials'),
      entry('2', 'Alan', 'Lopez', 'initials'),
      entry('3', 'Alan', 'Lin', 'firstLastInitial'),
      entry('4', 'Alan', 'Long', 'firstLastInitial')
    ])
    expect(new Set(mixed.values()).size).equals(4)
  })

  it('gives a model no surname for somebody with no first name', function () {
    const names = formatNames([entry('1', '', 'Pujols', 'firstLastInitial')], {
      lengthen: false
    })
    expect(names.get('1')).equals('P')
  })

  it('adds no letter to a list going to a model', function () {
    const names = formatNames(
      [
        entry('1', 'Alex', 'Lee', 'firstLastInitial'),
        entry('2', 'Alex', 'Leigh', 'firstLastInitial'),
        entry('3', 'Al', 'Lim', 'initials'),
        entry('4', 'Amy', 'Lopez', 'initials')
      ],
      { lengthen: false }
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
