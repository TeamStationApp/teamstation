import { expect } from 'chai'
import { describe, it } from 'mocha'

import { initialsOf } from './initials'

describe('initials', function () {
  it('takes the first letter of the first two words', function () {
    expect(initialsOf('Alta Hawks')).equals('AH')
    expect(initialsOf('North Pines Ravens')).equals('NP')
  })

  it('treats a hyphen as a space, so one person has one answer', function () {
    expect(initialsOf('Miller-Reed')).equals('MR')
  })

  it('manages one word, and none', function () {
    expect(initialsOf('Cyclones')).equals('C')
    expect(initialsOf('')).equals('')
    expect(initialsOf('   ')).equals('')
  })

  it('reads left to right rather than guessing', function () {
    expect(initialsOf('de la Cruz')).equals('DL')
  })
})

describe('initials of an awkward name', function () {
  it('skips a bracket rather than treating it as a letter', function () {
    expect(initialsOf('Badgers (Ripken)')).equals('BR')
    expect(initialsOf('Bay Stars (Mize)')).equals('BS')
  })

  it('manages a name that is all punctuation', function () {
    expect(initialsOf('--- ---')).equals('')
  })
})
