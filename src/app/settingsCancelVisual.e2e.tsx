/** Browser-only visual fixture for the secondary Cancel audit surfaces. */
import React from 'react'
import { createRoot } from 'react-dom/client'

import { TeamStationClient } from '../common/api'
import { asPublicGroup } from '../common/publicGroups'
import { Card, Screen } from './components'
import { DateRangePicker } from './components/DateRangePicker'
import { CalendarPicker, TimePicker } from './components/EventScheduleFields'
import { RolesModal } from './components/RolesModal'
import { StatFilterModal } from './components/StatFilterModal'
import { GameFormScreen } from './screens/GameFormScreen'
import { GroupLinkScreen } from './screens/GroupLinkScreen'
import { GroupLocationPage } from './screens/GroupLocationPage'
import { GroupPeoplePage } from './screens/GroupPeoplePage'
import { PlaceholderTeamForm } from './screens/PlaceholderTeamForm'
import { PromoteExternalScreen } from './screens/PromoteExternalScreen'
import { ThemeProvider } from './theme/ThemeContext'

const query = new URLSearchParams(location.search)
const scene = query.get('case')
const id = query.get('team')!
const client = new TeamStationClient({ baseUrl: '/api/v1' })
const close = (): void => {
  document.body.dataset.canceled = 'true'
}
if (scene?.endsWith('error') === true || scene === 'game-retry') {
  client.group = async () => {
    throw new Error('Fixture offline. Retry.')
  }
}
const frame = (child: React.ReactNode): React.ReactElement => (
  <Screen>
    <Card>{child}</Card>
  </Screen>
)
const source = { kind: 'team' as const, id }
const content =
  scene === 'date-range' ? (
    frame(
      <DateRangePicker
        initial={{ startsOn: '2027-04-01', endsOn: '2027-06-01' }}
        onChoose={() => {}}
        onCancel={close}
      />
    )
  ) : scene === 'stat-filter' ? (
    <StatFilterModal
      options={{ teams: [], seasons: [], years: [] }}
      filter={{}}
      onApply={() => {}}
      onClose={close}
    />
  ) : scene === 'roles' ? (
    <RolesModal
      displayName="Ichiro"
      scopeKind="team"
      scopeName="Winter Wolves"
      held={[]}
      onSave={() => {}}
      onClose={close}
    />
  ) : scene === 'promote' ? (
    <PromoteExternalScreen
      client={client}
      teamId={id}
      onSent={() => {}}
      onCancel={close}
    />
  ) : scene === 'group-link' ? (
    <GroupLinkScreen
      client={client}
      choice={{
        subject: source,
        targetKind: 'league',
        relationship: 'parent',
        direction: 'parents'
      }}
      onSent={() => {}}
      onCancel={close}
    />
  ) : scene === 'game-form' || scene === 'game-retry' ? (
    <GameFormScreen
      client={client}
      mode={{ kind: 'create', source }}
      onSaved={() => {}}
      onCancel={close}
    />
  ) : scene === 'event-date' ? (
    frame(
      <CalendarPicker value="2027-04-10" onChoose={() => {}} onCancel={close} />
    )
  ) : scene === 'event-time' ? (
    frame(<TimePicker value="19:00" onChoose={() => {}} onCancel={close} />)
  ) : scene === 'placeholder' ? (
    frame(
      <PlaceholderTeamForm
        client={client}
        custodian={asPublicGroup({
          kind: 'team',
          id,
          name: 'Winter Wolves',
          imageUrl: null,
          locality: null
        })}
        onUse={() => {}}
        onCancel={close}
      />
    )
  ) : scene === 'location-error' ? (
    <GroupLocationPage client={client} kind="team" id={id} onDone={close} />
  ) : (
    <GroupPeoplePage
      client={client}
      group={source}
      invites={false}
      onDone={close}
    />
  )
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>{content}</ThemeProvider>
)
