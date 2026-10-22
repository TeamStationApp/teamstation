import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Text, View } from 'react-native'

import { LeaguePage } from '../app/screens/LeaguePage'
import { ParentOrganizations } from '../app/screens/ParentOrganizations'
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
const season = group('demo_season', 'season', 'Demo Spring')
const hawks = group('demo_hawks', 'team', 'Demo Hawks')
const kept = {
  ...group('demo_kept', 'team', 'Willow Woods Westward Wanderers'),
  external: true
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
          <LeaguePage
            client={client}
            detail={detail}
            initialTab="teams"
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
          <View testID="reference-parent" style={{ display: 'none' }}>
            <ParentOrganizations
              client={client}
              teamId={hawks.id}
              teamName={hawks.name}
              parents={[league]}
              onLeft={() => {}}
            />
          </View>
        </View>
      </ScopedThemeProvider>
    </ThemeProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
