import { expect } from 'chai'
import { describe, it } from 'mocha'

import { initialsOf } from './initials'

describe('initials', function () {
  it('takes the first letter of the first two words', function () {
    expect(initialsOf('AAA Hawks')).equals('AH')
    expect(initialsOf('North Park Rangers')).equals('NP')
  })

  it('treats a hyphen as a space, so one person has one answer', function () {
    expect(initialsOf('Miller-Reed')).equals('MR')
  })

  it('manages one word, and none', function () {
    expect(initialsOf('Tsunamis')).equals('T')
    expect(initialsOf('')).equals('')
    expect(initialsOf('   ')).equals('')
  })

  it('reads left to right rather than guessing', function () {
    expect(initialsOf('de la Cruz')).equals('DL')
  })
})

describe('initials of an awkward name', function () {
  it('skips a bracket rather than treating it as a letter', function () {
    expect(initialsOf('Bandits (Ruden)')).equals('BR')
    expect(initialsOf('Black Sox (Boren)')).equals('BS')
  })

  it('manages a name that is all punctuation', function () {
    expect(initialsOf('--- ---')).equals('')
  })
})
