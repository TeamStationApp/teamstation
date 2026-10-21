import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { UmpireLevel, UmpireSeason } from '../../common/umpires'
import { Button, ListCard, ListRow, Screen } from '../components'
import { Badge } from '../components/Badge'
import { PickerDialog } from '../components/PickerDialog'
import { Wheel } from '../components/Wheel'
import {
  UmpireCheck,
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
  const [plate, setPlate] = useState(true)
  const [fieldCount, setFieldCount] = useState(1)
  const [picker, setPicker] = useState<'level' | 'field'>()
  useEffect(() => {
    run(async () => {
      const [ss, ls] = await Promise.all([
        client.umpireRequirements(league),
        client.umpireLevels(league)
      ])
      if (live()) {
        setSeasons(ss)
        setLevels(ls)
        setLevelId(ls[0]?.id ?? '')
      }
    })
  }, [client, league, live, run])
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
            <Text style={s.text}>Umpire level</Text>
            <Button
              label={levels.find(l => l.id === levelId)?.name ?? 'Choose level'}
              accessibilityLabel="Umpire level"
              color="#1565C0"
              onPress={() => {
                setPicker('level')
              }}
            />
            {levels.length === 0 && (
              <Text style={s.hint}>Create an umpire level first.</Text>
            )}
            <UmpireCheck
              label="Plate umpire"
              checked={plate}
              onPress={() => {
                setPlate(!plate)
              }}
            />
            <Button
              label={`Field umpires: ${fieldCount}`}
              accessibilityLabel="Field umpires"
              color="#1565C0"
              onPress={() => {
                setPicker('field')
              }}
            />
            <Button
              label="Apply umpire requirements to the below seasons"
              disabled={busy || levelId === '' || seasonIds.length === 0}
              onPress={() => {
                run(async () => {
                  await client.setUmpireRequirements(league, {
                    seasonIds,
                    levelId,
                    plate,
                    fieldCount
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
                  end={
                    editing ? undefined : (
                      <UmpireCheck
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
                <View
                  style={[s.row, { paddingHorizontal: 16, paddingBottom: 12 }]}
                >
                  {season.requirement == null ? (
                    <Text style={s.hint}>No requirements</Text>
                  ) : (
                    <>
                      <Badge label={season.requirement.levelName} />
                      {season.requirement.plate && <Badge label="plate ump" />}
                      {season.requirement.fieldCount > 0 && (
                        <Badge
                          label={`${season.requirement.fieldCount} field ump${season.requirement.fieldCount === 1 ? '' : 's'}`}
                        />
                      )}
                    </>
                  )}
                </View>
              </View>
            ))}
        </ListCard>
        {!editing && selected.length > 0 && (
          <Button
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
              setPicker(undefined)
            }}
          >
            <Wheel
              label={picker === 'level' ? 'Umpire level' : 'Field umpires'}
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
                  : fieldCount
              }
              format={n =>
                picker === 'level' ? (levels[n]?.name ?? '') : String(n)
              }
              width={220}
              onChange={n => {
                if (picker === 'level') setLevelId(levels[n].id)
                else setFieldCount(n)
              }}
            />
            <Button
              label="Done"
              onPress={() => {
                setPicker(undefined)
              }}
            />
          </PickerDialog>
        )}
        <UmpireError error={error} />
      </View>
    </Screen>
  )
}
