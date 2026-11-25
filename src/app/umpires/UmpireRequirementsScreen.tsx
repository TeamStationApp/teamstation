import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'

import type { TeamStationClient } from '../../common/api'
import type {
  UmpireLevel,
  UmpireSeason,
  UmpireType,
  UmpireTypeCount
} from '../../common/umpires'
import {
  Button,
  Checkbox,
  ListCard,
  ListRow,
  Screen,
  TextWidthButton
} from '../components'
import { Badge } from '../components/Badge'
import { PickerDialog } from '../components/PickerDialog'
import { useSceneReveals } from '../components/sceneShown'
import { useMotionPreference } from '../components/useMotionPreference'
import { Wheel } from '../components/Wheel'
import { lstrings, sprintf } from '../locales/strings'
import { RosterDrag, RosterDragGroup, RosterGrip } from '../scoring/RosterDrag'
import { useTheme } from '../theme/ThemeContext'
import {
  UmpireError,
  UmpireHeading,
  useUmpireStyles,
  useUmpireWork
} from './shared'

/** The grip column's width once it has slid in. */
const GRIP_WIDTH = 36

/**
 * `list` with the season at `from` put at insertion point `to`, counted in
 * the list as it stands (0 before the first, `length` after the last).
 */
export function moveSeason<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list
  const next = list.slice()
  const [season] = next.splice(from, 1)
  const at = Math.max(0, Math.min(next.length, to > from ? to - 1 : to))
  next.splice(at, 0, season)
  return next
}

/**
 * A season's drag handle, left of its icon in reorder mode. It slides in
 * from no width and fades in, or is simply there under Reduce Motion.
 */
function SeasonGrip({
  label,
  color,
  reduced
}: {
  label: string
  color: string
  reduced: boolean
}): React.ReactElement {
  const shown = useSharedValue(reduced ? 1 : 0)
  useEffect(() => {
    shown.value = reduced ? 1 : withTiming(1, { duration: 200 })
  }, [reduced, shown])
  const style = useAnimatedStyle(() => ({
    width: GRIP_WIDTH * shown.value,
    opacity: shown.value
  }))
  return (
    <Animated.View
      style={[
        {
          alignSelf: 'stretch',
          justifyContent: 'center',
          overflow: 'hidden',
          paddingLeft: 16,
          paddingVertical: 10
        },
        style
      ]}
    >
      <RosterGrip label={label} color={color} />
    </Animated.View>
  )
}

export function UmpireRequirementsScreen({
  client,
  league,
  seasonIds,
  onNext,
  onApplied
}: {
  client: TeamStationClient
  league: string
  seasonIds?: string[]
  onNext: (ids: string[]) => void
  onApplied: () => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const theme = useTheme()
  const reduced = useMotionPreference()
  const { error, busy, run, live } = useUmpireWork(league)
  const [seasons, setSeasons] = useState<UmpireSeason[]>([])
  // Reorder mode's working copy of the season order, or none outside it.
  const [order, setOrder] = useState<UmpireSeason[]>()
  const [levels, setLevels] = useState<UmpireLevel[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [levelId, setLevelId] = useState('')
  const [types, setTypes] = useState<UmpireType[]>([])
  const [counts, setCounts] = useState<UmpireTypeCount[]>([])
  const [picker, setPicker] = useState<
    'level' | { typeId: string; count: 'required' | 'optional' }
  >()
  const pickerGeneration = useRef(0)
  const pickerRevision = pickerGeneration.current
  const changePicker = (next: typeof picker): void => {
    // A wheel can deliver a queued scroll after its modal closes.
    pickerGeneration.current++
    setPicker(next)
  }
  const countTitle = (id: string, kind: 'required' | 'optional'): string =>
    `${kind === 'required' ? 'Required' : 'Optional'} ${types.find(t => t.id === id)?.name ?? ''}`
  const firstSeasonId = seasonIds?.[0]
  // The edit, pushed over the list, is applied to its seasons.
  const reveals = useSceneReveals()
  useEffect(() => {
    // The seasons ticked went to the edit: not the next one's.
    if (reveals > 0) setSelected([])
    run(async () => {
      const [ss, ls, ts] = await Promise.all([
        client.umpireRequirements(league),
        client.umpireLevels(league),
        client.umpireTypes(league)
      ])
      if (live()) {
        setSeasons(ss)
        // A list read again leaves reorder mode with the order read.
        setOrder(undefined)
        setLevels(ls)
        setTypes(ts)
        const existing = ss.find(s => s.id === firstSeasonId)?.requirement
        setLevelId(existing?.levelId ?? ls[0]?.id ?? '')
        setCounts(
          ts.map(
            t =>
              existing?.types.find(c => c.typeId === t.id) ?? {
                typeId: t.id,
                required: 1,
                optional: 0
              }
          )
        )
      }
    })
  }, [client, league, live, run, firstSeasonId, reveals])
  const editing = seasonIds != null
  const reordering = order != null
  const sortable = !editing && seasons.length >= 2
  const shownSeasons =
    order ?? seasons.filter(season => !editing || seasonIds.includes(season.id))
  const seasonRow = (season: UmpireSeason, index: number): React.ReactNode => {
    const row = (
      <ListRow
        title={season.name}
        group={{
          kind: 'season',
          id: season.id,
          leagueId: season.leagueId,
          name: season.name,
          uri: season.logoUrl,
          leagueUri: season.leaguePictureUrl
        }}
        detailContent={
          <View style={s.row} testID={`season-requirements-${season.id}`}>
            {season.requirement == null ? (
              <Text style={s.hint}>No requirements</Text>
            ) : (
              <>
                <Badge wrap label={season.requirement.levelName} />
                {season.requirement.types.map(c => (
                  <Badge
                    key={c.typeId}
                    wrap
                    label={`${types.find(t => t.id === c.typeId)?.name ?? 'Type'}: ${c.required} required, ${c.optional} optional`}
                  />
                ))}
              </>
            )}
          </View>
        }
        end={
          editing || reordering ? undefined : (
            <Checkbox
              hideLabel
              label={`Select ${season.name}`}
              checked={selected.includes(season.id)}
              onPress={() => {
                setSelected(ids =>
                  ids.includes(season.id)
                    ? ids.filter(id => id !== season.id)
                    : [...ids, season.id]
                )
              }}
            />
          )
        }
      />
    )
    if (!reordering) return <View key={season.id}>{row}</View>
    return (
      <RosterDrag
        key={season.id}
        playerId={index + 1}
        targetId={`season-${index}`}
        label={sprintf(lstrings.umpire_season_priority_move_named, season.name)}
        roleDescription={lstrings.umpire_season_priority_row}
        insertionLabel={lstrings.umpire_season_priority_insertion}
        insertion="row"
        immediate
        immediateMouseDrag
        onDropPlayer={(id, edge) => {
          setOrder(held =>
            held == null
              ? held
              : moveSeason(held, id - 1, index + (edge === 'after' ? 1 : 0))
          )
        }}
        onReorder={delta => {
          setOrder(held =>
            held == null
              ? held
              : moveSeason(
                  held,
                  index,
                  delta > 0 ? index + delta + 1 : index + delta
                )
          )
        }}
      >
        <View
          testID={`season-priority-row-${season.id}`}
          style={{
            flexDirection: 'row',
            backgroundColor: theme.cardBackgroundColor
          }}
        >
          <SeasonGrip
            label={sprintf(
              lstrings.umpire_season_priority_drag_named,
              season.name
            )}
            color={theme.secondaryTextColor}
            reduced={reduced}
          />
          <View style={{ flex: 1, minWidth: 0 }}>{row}</View>
        </View>
      </RosterDrag>
    )
  }
  const list = (
    <ListCard testID="season-priority-list">
      {shownSeasons.map(seasonRow)}
    </ListCard>
  )
  return (
    <Screen>
      <View style={s.page}>
        <UmpireHeading>
          {editing
            ? 'Set umpire requirements for the seasons below.'
            : 'Set Umpire Requirements'}
        </UmpireHeading>
        {!editing && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.rem(0.5)
            }}
          >
            <Text style={[s.text, { flex: 1 }]}>
              Select seasons to apply umpire needs.
            </Text>
            {sortable && (
              <Button
                kind="text"
                compact
                label={
                  reordering
                    ? lstrings.umpire_season_priority_cancel
                    : lstrings.umpire_season_priority_sort
                }
                accessibilityLabel={
                  reordering
                    ? lstrings.umpire_season_priority_cancel_named
                    : lstrings.umpire_season_priority_sort_named
                }
                textColor={reordering ? theme.dangerColor : '#1565C0'}
                disabled={busy}
                testID="season-priority-sort"
                onPress={() => {
                  setOrder(reordering ? undefined : seasons)
                }}
              />
            )}
          </View>
        )}
        {editing && (
          <>
            <ListCard>
              <ListRow
                title="Required umpire level"
                disabled={busy || levels.length === 0}
                end={
                  <Text style={[s.text, { color: '#1565C0' }]}>
                    {levels.find(l => l.id === levelId)?.name ?? 'Choose level'}
                  </Text>
                }
                onPress={() => {
                  changePicker('level')
                }}
              />
              {types.flatMap(t =>
                (['required', 'optional'] as const).map(kind => (
                  <ListRow
                    key={`${t.id}:${kind}`}
                    title={countTitle(t.id, kind)}
                    disabled={busy}
                    end={
                      <Text style={[s.text, { color: '#1565C0' }]}>
                        {counts.find(c => c.typeId === t.id)?.[kind] ?? 0}
                      </Text>
                    }
                    onPress={() => {
                      changePicker({ typeId: t.id, count: kind })
                    }}
                  />
                ))
              )}
            </ListCard>
            {(levels.length === 0 || types.length === 0) && (
              <Text style={s.hint}>Create an umpire level and type first.</Text>
            )}
            <TextWidthButton
              label="Apply umpire requirements to the below seasons"
              disabled={
                busy ||
                levelId === '' ||
                types.length === 0 ||
                seasonIds.length === 0
              }
              onPress={() => {
                run(async () => {
                  await client.setUmpireRequirements(league, {
                    seasonIds,
                    levelId,
                    types: counts
                  })
                  if (live()) onApplied()
                })
              }}
            />
          </>
        )}
        {reordering ? <RosterDragGroup>{list}</RosterDragGroup> : list}
        {reordering && (
          <Button
            label={lstrings.umpire_season_priority_save}
            accessibilityLabel={lstrings.umpire_season_priority_save_named}
            disabled={busy}
            testID="season-priority-save"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => {
              const ids = order.map(season => season.id)
              run(async () => {
                const saved = await client.setUmpireSeasonPriority(league, ids)
                if (live()) {
                  setSeasons(saved)
                  setOrder(undefined)
                }
              })
            }}
          />
        )}
        {!editing && !reordering && selected.length > 0 && (
          <TextWidthButton
            label="Next"
            color="#1565C0"
            onPress={() => {
              onNext(selected)
            }}
          />
        )}
        {picker != null && (
          <PickerDialog
            onClose={() => {
              changePicker(undefined)
            }}
          >
            <Wheel
              label={
                picker === 'level'
                  ? 'Required umpire level'
                  : countTitle(picker.typeId, picker.count)
              }
              options={
                picker === 'level'
                  ? levels.map((_, i) => i)
                  : [0, 1, 2, 3, 4, 5, 6]
              }
              value={
                picker === 'level'
                  ? Math.max(
                      0,
                      levels.findIndex(l => l.id === levelId)
                    )
                  : (counts.find(c => c.typeId === picker.typeId)?.[
                      picker.count
                    ] ?? 0)
              }
              format={n =>
                picker === 'level' ? (levels[n]?.name ?? '') : String(n)
              }
              width={220}
              onChange={n => {
                if (pickerGeneration.current !== pickerRevision) return
                if (picker === 'level') setLevelId(levels[n].id)
                else
                  setCounts(held =>
                    held.map(c =>
                      c.typeId === picker.typeId
                        ? { ...c, [picker.count]: n }
                        : c
                    )
                  )
              }}
            />
            <Button
              label="Done"
              onPress={() => {
                changePicker(undefined)
              }}
            />
          </PickerDialog>
        )}
        <UmpireError error={error} />
      </View>
    </Screen>
  )
}
