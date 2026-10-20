import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { EventAttendee } from '../../common/eventInfo'
import { userIdOfGumbo } from '../../common/userId'
import { attendanceSections, attendanceSubtitle } from './eventAttendance'

const person = (
  userId: number,
  fields: Partial<EventAttendee> = {}
): EventAttendee => ({
  userId: userIdOfGumbo(userId),
  name: 'Babe R',
  avatarUrl: null,
  response: null,
  canReply: false,
  isTeamParticipant: true,
  ...fields
})
describe('direct attendance sections and profiles', () => {
  it('features staff going and excludes players from all Others, including staff players', () => {
    const sections = attendanceSections([
      person(1, { staffRoles: ['coach'], response: 'yes' }),
      person(2, { isPlayer: true, staffRoles: ['assistant'], response: 'yes' }),
      person(3, { isPlayer: true, response: 'maybe' }),
      person(4, { response: 'no' }),
      person(5),
      person(6, { isTeamParticipant: false, response: 'yes' })
    ])
    expect(sections.map(section => section.title)).deep.equals([
      'Staff Going',
      'Players Going',
      'Maybe Players',
      'Players Not Going',
      'No-reply Players',
      'Others Going',
      'Maybe Others',
      'Others Not Going',
      'No-reply Others'
    ])
    expect(
      sections.map(section => section.rows.map(row => row.userId))
    ).deep.equals([
      [userIdOfGumbo(1), userIdOfGumbo(2)],
      [userIdOfGumbo(2)],
      [userIdOfGumbo(3)],
      [],
      [],
      [userIdOfGumbo(1)],
      [],
      [userIdOfGumbo(4)],
      [userIdOfGumbo(5)]
    ])
  })
  it('labels actual roles, both hands/positions and abbreviated guardian relationships', () => {
    expect(
      attendanceSubtitle(
        person(1, {
          staffRoles: ['admin', 'coach', 'assistant', 'scorekeeper']
        }),
        true
      )
    ).equals('Admin · Coach · Assistant · Scorekeeper')
    expect(
      attendanceSubtitle(
        person(1, {
          isPlayer: true,
          bats: 'switch',
          throws: 'left',
          positions: ['SS', 'CF']
        })
      )
    ).equals('B:S • T:L • SS • CF')
    expect(attendanceSubtitle(person(1, { isPlayer: true }))).equals('')
    expect(
      attendanceSubtitle(
        person(1, {
          isPlayer: true,
          bats: 'right',
          positions: ['SS', 'C', 'P']
        })
      )
    ).equals('B:R • SS • C • P')
    expect(
      attendanceSubtitle(person(1, { isPlayer: true, throws: 'right' }))
    ).equals('T:R')
    expect(
      attendanceSubtitle(
        person(1, { guardianOf: ['Mike T'], staffRoles: ['coach'] })
      )
    ).equals('Coach · Guardian of Mike T')
    expect(attendanceSubtitle(person(1))).equals('Spectator')
  })
})
