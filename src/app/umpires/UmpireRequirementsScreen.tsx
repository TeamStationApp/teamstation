import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

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
import { Wheel } from '../components/Wheel'
import {
  UmpireError,
  UmpireHeading,
  useUmpireStyles,
  useUmpireWork
} from './shared'
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
  const { error, busy, run, live } = useUmpireWork(league)
  const [seasons, setSeasons] = useState<UmpireSeason[]>([])
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
    run(async () => {
      const [ss, ls, ts] = await Promise.all([
        client.umpireRequirements(league),
        client.umpireLevels(league),
        client.umpireTypes(league)
      ])
      if (live()) {
        setSeasons(ss)
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
  return (
    <Screen>
      <View style={s.page}>
        <UmpireHeading>
          {editing
            ? 'Set umpire requirements for the seasons below.'
            : 'Set Umpire Requirements'}
        </UmpireHeading>
        {!editing && (
          <Text style={s.text}>Select seasons to apply umpire needs.</Text>
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
        <ListCard>
          {seasons
            .filter(season => !editing || seasonIds.includes(season.id))
            .map(season => (
              <View key={season.id}>
                <ListRow
                  title={season.name}
                  emblem="S"
                  emblemUri={season.logoUrl}
                  detailContent={
                    <View
                      style={s.row}
                      testID={`season-requirements-${season.id}`}
                    >
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
                    editing ? undefined : (
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
              </View>
            ))}
        </ListCard>
        {!editing && selected.length > 0 && (
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
