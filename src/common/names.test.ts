import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  DELETED_NAME,
  fullName,
  shortName,
  shortNames,
  shortParts
} from './names'

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
})
