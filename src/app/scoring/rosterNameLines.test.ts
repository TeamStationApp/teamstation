import { expect } from 'chai'
import { describe, it } from 'mocha'

import { rosterNameLines } from './rosterNameLines'

describe('roster card name lines', function () {
  it('splits the jersey, the first name and the last name', function () {
    expect(
      rosterNameLines({
        jersey: '27',
        fullName: 'Trea Turner',
        firstName: 'Trea',
        lastName: 'Turner'
      })
    ).deep.equals({ first: '#27 Trea', last: 'Turner' })
  })

  it('keeps a two-word first name together', function () {
    expect(
      rosterNameLines({
        jersey: '3',
        fullName: 'Ke Bryan Hayes',
        firstName: 'Ke Bryan',
        lastName: 'Hayes'
      })
    ).deep.equals({ first: '#3 Ke Bryan', last: 'Hayes' })
  })

  it('keeps a multi-word or hyphenated last name whole', function () {
    expect(
      rosterNameLines({
        jersey: '1',
        fullName: 'Elly De La Cruz',
        firstName: 'Elly',
        lastName: 'De La Cruz'
      })
    ).deep.equals({ first: '#1 Elly', last: 'De La Cruz' })
    expect(
      rosterNameLines({
        jersey: '4',
        fullName: 'Christian Encarnacion-Strand',
        lastName: 'Encarnacion-Strand'
      })
    ).deep.equals({ first: '#4 Christian', last: 'Encarnacion-Strand' })
  })

  it('splits a label with no last name at its last space', function () {
    expect(
      rosterNameLines({ jersey: '27', fullName: 'Trea T.', lastName: '' })
    ).deep.equals({ first: '#27 Trea', last: 'T.' })
    // A last name the label does not end with is not used.
    expect(
      rosterNameLines({ jersey: '', fullName: 'Trea T.', lastName: 'Turner' })
    ).deep.equals({ first: 'Trea', last: 'T.' })
  })

  it('has no last name for a one-word name', function () {
    expect(rosterNameLines({ jersey: '9', fullName: 'Ohtani' })).deep.equals({
      first: '#9 Ohtani',
      last: ''
    })
    // A name that is only its last name has nothing before it to split off.
    expect(
      rosterNameLines({ jersey: '', fullName: 'Judge', lastName: 'Judge' })
    ).deep.equals({ first: 'Judge', last: '' })
  })

  it('leads with the lineup slot, and leaves out an empty jersey', function () {
    expect(
      rosterNameLines(
        { jersey: '', fullName: 'Mookie Betts', lastName: 'Betts' },
        '1.'
      )
    ).deep.equals({ first: '1. Mookie', last: 'Betts' })
    expect(
      rosterNameLines(
        { jersey: '50', fullName: 'Mookie Betts', lastName: 'Betts' },
        '2.'
      )
    ).deep.equals({ first: '2. #50 Mookie', last: 'Betts' })
  })

  it('trims the name, the jersey and the last name, and folds inner spaces', function () {
    expect(
      rosterNameLines({
        jersey: ' 7 ',
        fullName: '  Cliff   Lee ',
        lastName: ' Lee '
      })
    ).deep.equals({ first: '#7 Cliff', last: 'Lee' })
  })
})
