import { expect } from 'chai'
import { describe, it } from 'mocha'

import { shortName, shortNames } from './names'

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
    expect(shortName(person('1', 'Jensen', 'Puey'))).equals('Jensen P')
  })

  it('keeps a one-letter surname whole', function () {
    expect(shortName(person('1', 'Jensen', 'P'))).equals('Jensen P')
  })

  it('manages a person with only one name', function () {
    expect(shortName(person('1', 'Wesley', ''))).equals('Wesley')
    expect(shortName(person('1', '', 'Boren'))).equals('Boren')
  })

  it('splits a display name when the halves are missing', function () {
    expect(shortName({ id: '1', displayName: 'Mateo Aguilar Nunnink' })).equals(
      'Mateo N'
    )
  })

  it('leaves an empty name empty rather than inventing one', function () {
    expect(shortName({ id: '1', displayName: '' })).equals('')
  })
})

describe('a list of names', function () {
  it('leaves names that do not collide alone', function () {
    const names = shortNames([
      person('1', 'Jensen', 'Puey'),
      person('2', 'Wesley', 'Boren')
    ])
    expect(names.get('1')).equals('Jensen P')
    expect(names.get('2')).equals('Wesley B')
  })

  it('takes another letter when two would read the same', function () {
    const names = shortNames([
      person('1', 'Jensen', 'Puey'),
      person('2', 'Jensen', 'Parker')
    ])
    expect(names.get('1')).equals('Jensen Pu')
    expect(names.get('2')).equals('Jensen Pa')
  })

  it('takes as many letters as it needs', function () {
    const names = shortNames([
      person('1', 'Jensen', 'Parker'),
      person('2', 'Jensen', 'Parks')
    ])
    // `Park` is still shared, so it takes one more: `Parke` and `Parks`.
    expect(names.get('1')).equals('Jensen Parke')
    expect(names.get('2')).equals('Jensen Parks')
  })

  it('does not invent a difference between two of the same name', function () {
    const names = shortNames([
      person('1', 'Jensen', 'Puey'),
      person('2', 'Jensen', 'Puey')
    ])
    expect(names.get('1')).equals('Jensen P')
    expect(names.get('2')).equals('Jensen P')
  })
})
