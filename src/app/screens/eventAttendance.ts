import type { EventAttendee, RsvpChoice } from '../../common/eventInfo'
import { flagLabel } from '../components/RolesModal'

export function attendanceSections(
  attendees: EventAttendee[]
): Array<{ id: string; title: string; rows: EventAttendee[] }> {
  const direct = attendees.filter(row => row.isTeamParticipant === true)
  const groups: Array<{ id: string; title: string; rows: EventAttendee[] }> = [
    {
      id: 'staff-yes',
      title: 'Staff Going',
      rows: direct.filter(
        row => row.response === 'yes' && (row.staffRoles?.length ?? 0) > 0
      )
    }
  ]
  const responses: Array<{ response: RsvpChoice; id: string }> = [
    { response: 'yes', id: 'yes' },
    { response: 'maybe', id: 'maybe' },
    { response: 'no', id: 'no' },
    { response: null, id: 'noReply' }
  ]
  for (const player of [true, false]) {
    const titles = player
      ? [
          'Players Going',
          'Maybe Players',
          'Players Not Going',
          'No-reply Players'
        ]
      : ['Others Going', 'Maybe Others', 'Others Not Going', 'No-reply Others']
    responses.forEach(({ response, id }, index) =>
      groups.push({
        id: `${player ? 'players' : 'others'}-${id}`,
        title: titles[index],
        rows: direct.filter(
          row => (row.isPlayer === true) === player && row.response === response
        )
      })
    )
  }
  return groups
}

export function attendanceSubtitle(
  row: EventAttendee,
  staffOnly = false
): string {
  const roles = (row.staffRoles ?? []).map(role =>
    role === 'admin' ? 'Admin' : flagLabel(role)
  )
  if (staffOnly) return roles.join(' · ')
  if (row.isPlayer === true) {
    const hands = { left: 'L', right: 'R', switch: 'S' }
    return [
      ...(row.bats == null ? [] : [`B:${hands[row.bats]}`]),
      ...(row.throws == null ? [] : [`T:${hands[row.throws]}`]),
      ...(row.positions ?? [])
    ].join(' • ')
  }
  const guardian =
    (row.guardianOf?.length ?? 0) > 0
      ? `Guardian of ${row.guardianOf!.join(', ')}`
      : ''
  const subtitle = [...roles, guardian].filter(text => text !== '').join(' · ')
  return subtitle === '' ? 'Spectator' : subtitle
}
