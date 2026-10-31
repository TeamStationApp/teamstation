import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'

import { BlackoutRangeList } from '../app/components/BlackoutDatesEditor'
import { LeaguePage } from '../app/screens/LeaguePage'
import { ManagePlayers } from '../app/screens/ManagePlayers'
import { ParentOrganizations } from '../app/screens/ParentOrganizations'
import { ParticipationList } from '../app/screens/ParticipationList'
import { ScheduleSeasonScreen } from '../app/screens/ScheduleSeasonScreen'
import { SeasonPresentation } from '../app/screens/SeasonPresentation'
import { VenueScreen } from '../app/screens/VenueScreen'
import { ScopedThemeProvider, ThemeProvider } from '../app/theme/ThemeContext'
import { tsBallpark } from '../app/theme/tsBallpark'
import { tsDark } from '../app/theme/tsDark'
import { TeamStationClient } from '../common/api'
import {
  asGroupDetail,
  asPublicGroup,
  type PublicGroup
} from '../common/publicGroups'

const query = new URLSearchParams(location.search)
const base = query.has('dark') ? tsDark : tsBallpark
const theme = {
  ...base,
  rem: (value: number) => value * (query.has('large') ? 24 : 16)
}
const group = (
  id: string,
  kind: 'team' | 'league' | 'season',
  name: string
): PublicGroup =>
  asPublicGroup({ id, kind, name, imageUrl: null, locality: null })
const league = group('demo_league', 'league', 'Demo League')
const season = group(
  'demo_season',
  'season',
  query.has('longLink')
    ? '2027 Spring Regular Season Majors Division'
    : 'Demo Spring'
)
const hawks = group('demo_hawks', 'team', 'Demo Hawks')
const kept = {
  ...group('demo_kept', 'team', 'Willow Woods Westward Wanderers'),
  external: true
}

const asPeople = (rows: Array<[number, string, string[]]>): never =>
  rows.map(([userId, displayName, emails]) => ({
    userId,
    displayName,
    emails,
    teams: [{ id: hawks.id, isPlayer: true }]
  })) as never

/** Every other screen with a shared list card, on a stubbed client. */
function otherScreen(api: TeamStationClient): React.ReactElement | undefined {
  if (query.has('parents'))
    return (
      <ParentOrganizations
        client={api}
        teamId={hawks.id}
        teamName={hawks.name}
        parents={[league]}
        onLeft={() => {}}
      />
    )
  if (query.has('players')) {
    api.roster = async () => []
    return (
      <ManagePlayers
        client={api}
        teamId={hawks.id}
        teamName={hawks.name}
        people={asPeople([
          [101, 'Mookie Betts', ['player@example.test']],
          [102, 'Aaron Judge', []]
        ])}
        onChanged={() => {}}
      />
    )
  }
  if (query.has('seasonTeams'))
    return (
      <SeasonPresentation
        client={api}
        season={{
          id: season.id,
          leagueId: league.id,
          name: season.name,
          year: 2027,
          term: null,
          ageGroup: null,
          teams: 2,
          games: 0,
          videos: 0,
          logoUrl: null
        }}
        publicDetail={asGroupDetail({
          group: season,
          nonMemberView: true,
          parents: [league],
          children: [hawks, kept],
          keptTeams: [],
          competingTeams: [hawks, kept],
          teamSeasons: [],
          canManage: false,
          canViewPrivate: false,
          canManagePeople: false,
          canSeePeople: false,
          participatingSeasons: [],
          staff: [],
          games: []
        })}
        initialTab="teams"
        onOpenGame={() => {}}
        onOpenTeam={() => {}}
      />
    )
  if (query.has('participations'))
    return (
      <ParticipationList
        client={api}
        owner={{ kind: 'team', id: hawks.id, name: hawks.name }}
        groups={[season]}
        onLeft={() => {}}
      />
    )
  if (query.has('blackout'))
    return (
      <BlackoutRangeList
        dates={['2027-05-01', '2027-05-02', '2027-06-14']}
        onRemove={() => {}}
      />
    )
  if (query.has('venue')) {
    api.venue = (async () => ({
      id: 'demo_venue',
      placeId: 'example-park',
      name: 'Example Park',
      address: '1 Example Way, Demo City',
      timezone: 'America/New_York',
      sizeSwitchMinutes: 0,
      defaultHours: [],
      defaultBlackouts: [],
      photoUrl: null,
      photoLargeUrl: null,
      owners: [{ claimId: 'claim_a', leagueId: league.id, name: league.name }],
      claims: [
        {
          id: 'claim_b',
          leagueId: 'demo_other',
          leagueName: 'Demo Other League',
          kind: 'coOwner',
          status: 'pending',
          requestedAt: '2027-04-01T00:00:00.000Z',
          approvesAt: '2027-04-08T12:00:00.000Z'
        }
      ],
      fields: [
        {
          id: 'field_a',
          name: 'Field 1',
          sizes: ['50/70'],
          hours: [],
          blackouts: []
        }
      ],
      rights: {
        canEdit: true,
        claimLeagues: [],
        canClaim: false,
        canRequest: false,
        claimBlocked: null,
        leaveClaimIds: ['claim_a'],
        canRemoveOwners: false,
        decidableClaimIds: ['claim_b']
      },
      map: { latitude: 40.02, longitude: -75.22 }
    })) as never
    return (
      <VenueScreen
        client={api}
        venueId="demo_venue"
        onOpenField={() => {}}
        onClaimed={() => {}}
      />
    )
  }
  if (query.has('schedule')) {
    const setupSeason = {
      id: season.id,
      name: season.name,
      year: 2027,
      timezone: 'America/New_York',
      participants: 1,
      exhibitionTeams: 0,
      teams: [{ id: hawks.id, name: hawks.name, exhibition: false }],
      saved: false,
      settings: {
        fieldSize: '50/70',
        gameMinutes: 90,
        bufferMinutes: 10,
        regularGames: 4,
        exhibitionGames: 0,
        doubleheaders: 'ifNecessary',
        startsOn: '2027-03-01',
        endsOn: '2027-07-31',
        blackouts: [],
        windows: [
          {
            from: '2027-03-01',
            hours: [{ weekday: 2, start: '17:30', end: '21:00' }]
          }
        ]
      }
    }
    api.scheduleSetup = (async () => ({
      leagueId: league.id,
      seasonIds: [],
      fieldIds: [],
      addedFieldIds: [],
      seasons: [setupSeason],
      fields: []
    })) as never
    return (
      <ScheduleSeasonScreen
        client={api}
        leagueId={league.id}
        seasonId={season.id}
      />
    )
  }
}

function Fixture(): React.ReactElement {
  const [status, setStatus] = useState('Ready; writes 0')
  const [removed, setRemoved] = useState(false)
  const [client] = useState(() => {
    let writes = 0
    const api = new TeamStationClient({ baseUrl: '/api/v1' })
    api.parentPreview = async actions => ({
      actions,
      effects: actions,
      expected: {},
      explanation: ['Remove Demo League as parent of Demo Hawks']
    })
    api.changeParents = async preview => {
      if (
        preview.actions.length !== 1 ||
        preview.actions[0].child.id !== hawks.id
      )
        throw new Error('Unexpected relationship')
      setStatus(`Removed Demo Hawks; writes ${++writes}`)
    }
    return api
  })
  const [other] = useState(() => otherScreen(client))
  const detail = asGroupDetail({
    group: league,
    nonMemberView: false,
    parents: [],
    children: query.has('empty') ? [] : [season, ...(removed ? [] : [hawks])],
    keptTeams: query.has('empty') ? [] : [kept],
    teamSeasons: [{ teamId: hawks.id, seasonIds: [season.id] }],
    canManage: !query.has('readonly'),
    canViewPrivate: true,
    canManagePeople: false,
    canSeePeople: false,
    participatingSeasons: [],
    competingTeams: [],
    staff: [],
    games: []
  })
  return (
    <ThemeProvider>
      <ScopedThemeProvider theme={theme}>
        <View style={{ flex: 1, backgroundColor: theme.backgroundColor }}>
          <Text
            accessibilityRole="status"
            style={{ color: theme.primaryTextColor }}
          >
            {status}
          </Text>
          {other ?? (
            <LeaguePage
              client={client}
              detail={detail}
              initialTab={query.has('seasons') ? 'seasons' : 'teams'}
              onOpen={ref => {
                setStatus(`Opened ${ref.kind} ${ref.id}; writes 0`)
              }}
              onCreate={() => {
                setStatus('Create; writes 0')
              }}
              onSettings={() => {}}
              onLink={() => {
                setStatus('Add; writes 0')
              }}
              onChanged={() => {
                setRemoved(true)
              }}
            />
          )}
          {other == null && (
            <View testID="reference-parent" style={{ display: 'none' }}>
              <ParentOrganizations
                client={client}
                teamId={hawks.id}
                teamName={hawks.name}
                parents={[league]}
                onLeft={() => {}}
              />
            </View>
          )}
        </View>
      </ScopedThemeProvider>
    </ThemeProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
