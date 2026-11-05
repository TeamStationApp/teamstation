import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { umpirePositionName } from '../../common/umpires'
import type { UmpireGameRow, UmpireSchedule } from '../../common/umpireSchedule'
import { Button, ListCard, ListRow } from '../components'
import { UmpireError, useUmpireStyles, useUmpireWork } from './shared'
import { UmpireDialog } from './UmpireDialog'
export function UmpireSignup({
  client,
  game,
  slot,
  schedule,
  onClose,
  onSaved
}: {
  client: TeamStationClient
  game: UmpireGameRow
  slot: string
  schedule: Pick<UmpireSchedule, 'viewerId' | 'settings' | 'creditTeams'>
  onClose: () => void
  onSaved: () => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const { error, busy, run, live } = useUmpireWork(`${game.id}:${slot}`)
  const choices = game.choices[slot] ?? []
  const eligible = choices.filter(p => p.reason == null)
  const [userId, setUserId] = useState(
    eligible.find(p => p.userId === schedule.viewerId)?.userId ??
      eligible[0]?.userId
  )
  const [teamId, setTeamId] = useState<string>()
  const needsTeam = schedule.settings.credits && schedule.creditTeams.length > 1
  return (
    <UmpireDialog
      title={(() => {
        const position = game.positions.find(p => p.slot === slot)
        return position == null
          ? 'Umpire'
          : umpirePositionName(position, game.positions) +
              (position.required ? '' : ' (optional)')
      })()}
      onClose={onClose}
    >
      <Text style={s.text}>{game.date}</Text>
      <Text style={s.text}>{game.venue}</Text>
      <Text style={s.hint}>{game.notes}</Text>
      {choices.map(p => (
        <Pressable
          key={p.userId}
          accessibilityRole={p.reason == null ? 'radio' : 'text'}
          accessibilityLabel={`${p.name}${p.reason == null ? '' : ', ' + p.reason}`}
          aria-checked={p.reason == null ? p.userId === userId : undefined}
          disabled={p.reason != null || busy}
          onPress={() => {
            setUserId(p.userId)
          }}
          style={[
            s.check,
            {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              opacity: p.reason == null ? 1 : 0.5
            }
          ]}
        >
          <View style={{ flex: 1 }}>
            <Text style={s.text}>{p.name}</Text>
            {p.reason != null && <Text style={s.hint}>{p.reason}</Text>}
          </View>
          {p.reason == null && (
            <Text style={s.text}>{p.userId === userId ? '◉' : '○'}</Text>
          )}
        </Pressable>
      ))}
      {choices.length === 0 && (
        <Text style={s.hint}>No eligible people are available.</Text>
      )}
      {needsTeam && (
        <View>
          <Text style={s.text}>Team to receive credit</Text>
          <ListCard>
            {schedule.creditTeams.map(t => (
              <ListRow
                key={t.id}
                title={t.name}
                selected={t.id === teamId}
                onPress={() => {
                  setTeamId(t.id)
                }}
              />
            ))}
          </ListCard>
        </View>
      )}
      <UmpireError error={error} />
      <Button
        label="Confirm"
        busy={busy}
        disabled={userId == null || (needsTeam && teamId == null)}
        onPress={() => {
          run(async () => {
            if (userId == null) return
            await client.assignUmpire(game.id, {
              slot,
              userId,
              ...(needsTeam ? { creditTeamId: teamId } : {})
            })
            if (live()) onSaved()
          })
        }}
      />
    </UmpireDialog>
  )
}
