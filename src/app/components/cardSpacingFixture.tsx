import React, { useCallback, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import {
  asTeamSummary,
  asUserMatch,
  type TeamStationClient
} from '../../common/api'
import { HomeScreen } from '../screens/HomeScreen'
import { ScopedThemeProvider, useTheme } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { tsDark } from '../theme/tsDark'
import { Button } from './Button'
import { Card, CardContent } from './Card'
import { ChildCard } from './ChildCard'
import { CreationCard } from './CreationCard'
import { GameHeroCard } from './GameHeroCard'
import { ListCard } from './ListCard'
import { ListRow } from './ListRow'
import { RoleRows } from './RoleRows'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}
type ViewRef = React.ComponentRef<typeof View>

async function measure(view: ViewRef): Promise<Rect> {
  return await new Promise(resolve => {
    view.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height })
    })
  })
}

/** Measures the actual layout on native and web, rather than inspecting styles. */
function Probe({
  label,
  subtitle,
  section = false,
  report
}: {
  label: string
  subtitle?: string
  section?: boolean
  report: (label: string, result: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const outside = useRef<ViewRef>(null)
  const content = useRef<ViewRef>(null)
  const check = (): void => {
    requestAnimationFrame(() => {
      if (outside.current == null || content.current == null) return
      Promise.all([measure(outside.current), measure(content.current)])
        .then(([row, body]) => {
          const expected = theme.rem(theme.cardContentInsetRem)
          const distances = [
            body.y - row.y,
            row.y + row.height - body.y - body.height,
            row.x + row.width - body.x - body.width
          ]
          if (section) distances.push(body.x - row.x)
          const passed = distances.every(
            value => Math.abs(value - expected) < 1
          )
          report(
            label,
            passed ? 'passed' : distances.map(n => n.toFixed(1)).join('/')
          )
        })
        .catch(() => {
          report(label, 'measurement failed')
        })
    })
  }
  const marker = (
    <View
      ref={content}
      collapsable={false}
      onLayout={check}
      style={{
        height: theme.rem(4),
        width: section ? '100%' : theme.rem(3),
        backgroundColor: theme.containerBackgroundColor
      }}
    >
      <Text style={{ fontSize: theme.rem(1), color: theme.primaryTextColor }}>
        {label}
      </Text>
    </View>
  )
  return (
    <View ref={outside} collapsable={false} onLayout={check}>
      {section ? (
        <CardContent>{marker}</CardContent>
      ) : (
        <ListRow title={label} subtitle={subtitle} end={marker} />
      )}
    </View>
  )
}

const homeClient = {
  teams: async () =>
    [
      'Comets',
      'Harbor Owls',
      'Copper Foxes',
      'Meadow Stars',
      'Clouds',
      'Kites'
    ].map((name, index) =>
      asTeamSummary({
        id: `tem_spacing_${index}`,
        name,
        shortName: null,
        logoPath: null,
        logoUrl: null,
        record: { w: 3, l: 2, t: 0, seasonName: 'Example Season' }
      })
    ),
  guardedPlayers: async () => [
    asUserMatch({
      userId: 1,
      shortName: 'Babe Ruth',
      avatarUrl: null,
      externalIds: []
    })
  ],
  seasons: async () => [],
  recentGame: async () => null,
  liveNow: async () => []
} as unknown as TeamStationClient

/** Synthetic data only. This entry is never imported by the production app. */
export function CardSpacingFixture(): React.ReactElement {
  const [page, setPage] = useState('Home')
  const [dark, setDark] = useState(false)
  const [large, setLarge] = useState(false)
  const [pressed, setPressed] = useState('')
  const [results, setResults] = useState<Record<string, string>>({})
  const report = useCallback((label: string, result: string) => {
    setResults(previous =>
      previous[label] === result ? previous : { ...previous, [label]: result }
    )
  }, [])
  const base = dark ? tsDark : tsBallpark
  const theme = { ...base, rem: (n: number) => n * (large ? 24 : 16) }
  const textStyle = { color: theme.primaryTextColor, fontSize: theme.rem(1) }
  const contentStyle = { padding: 16, gap: 16 }
  const go = (label: string): void => {
    setPressed(label)
  }
  return (
    <ScopedThemeProvider theme={theme}>
      <View
        style={{
          flex: 1,
          paddingTop: 48,
          paddingBottom: 24,
          backgroundColor: theme.backgroundColor
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 4,
            paddingHorizontal: 8
          }}
        >
          {['Home', 'Geometry', 'Cards', 'Dark', 'Large'].map(label => (
            <Pressable
              key={label}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={() => {
                setResults({})
                if (label === 'Dark') setDark(value => !value)
                else if (label === 'Large') setLarge(value => !value)
                else setPage(label)
              }}
              style={{
                padding: 8,
                backgroundColor: theme.containerBackgroundColor
              }}
            >
              <Text style={{ ...textStyle, fontSize: 14 }}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <Text accessibilityLiveRegion="polite" style={textStyle}>
          {dark ? 'Dark' : 'Light'} / {large ? 'Large' : 'Normal'} / {pressed}
        </Text>
        {page === 'Home' ? (
          <HomeScreen
            client={homeClient}
            onOpenPlayer={(_, name) => {
              go(name)
            }}
            onOpenTeam={team => {
              go(team.name)
            }}
            onOpenSeason={() => {
              go('Season')
            }}
            onOpenGame={() => {
              go('Game')
            }}
          />
        ) : (
          <ScrollView
            key={`${page}-${dark}-${large}`}
            contentContainerStyle={contentStyle}
          >
            {page === 'Geometry' ? (
              <>
                <Text style={textStyle}>
                  {['single', 'first', 'middle', 'last', 'section'].every(
                    label => results[label] === 'passed'
                  )
                    ? 'Geometry passed: five regions'
                    : `Geometry pending: ${JSON.stringify(results)}`}
                </Text>
                <ListCard>
                  <Probe label="single" report={report} />
                </ListCard>
                <ListCard>
                  <Probe label="first" report={report} />
                  <Probe
                    label="middle"
                    subtitle="A second line"
                    report={report}
                  />
                  <Probe
                    label="last"
                    subtitle="Another second line"
                    report={report}
                  />
                </ListCard>
                <ListCard>
                  <Probe label="section" section report={report} />
                </ListCard>
                <Button
                  label="Verify again"
                  onPress={() => {
                    setPage('Home')
                  }}
                />
              </>
            ) : (
              <>
                <Card>
                  <Text style={textStyle}>Empty state</Text>
                </Card>
                <ChildCard
                  title="Comets"
                  subtitle="Example season"
                  footer="Example locality"
                  imageUrl={null}
                  onPress={() => {
                    go('Child')
                  }}
                  actions={[
                    {
                      label: 'Inspect child',
                      onPress: () => {
                        go('Menu')
                      }
                    }
                  ]}
                />
                <CreationCard
                  title="Create a team"
                  description="An example creation card with several lines of explanatory text."
                  icon={{
                    uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
                  }}
                  onPress={() => {
                    go('Create')
                  }}
                />
                <ListCard>
                  <CardContent>
                    <Text style={textStyle}>Form introduction</Text>
                  </CardContent>
                  <ListRow
                    title="Mixed row"
                    emblem="MR"
                    onPress={() => {
                      go('Mixed')
                    }}
                  />
                  <CardContent>
                    <Button
                      label="Form action"
                      onPress={() => {
                        go('Action')
                      }}
                    />
                  </CardContent>
                </ListCard>
                <GameHeroCard
                  awayName="Comets"
                  homeName="Copper Foxes"
                  awayScore={3}
                  homeScore={2}
                  status="Final"
                  date="Example date"
                  compact
                />
                <RoleRows
                  section={{
                    level: 'team',
                    roles: [],
                    member: true,
                    follower: false,
                    editable: true,
                    groups: []
                  }}
                  canHoldRoles
                  viewer={{ manages: true, admin: true }}
                  onAdd={() => {
                    go('Add role')
                  }}
                  onRemove={() => {
                    go('Remove role')
                  }}
                />
              </>
            )}
          </ScrollView>
        )}
      </View>
    </ScopedThemeProvider>
  )
}
