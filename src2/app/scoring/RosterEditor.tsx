import React, { useState } from 'react'
import { Text, TextInput, useWindowDimensions, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { addDevelopmentPlayer } from './developmentSession'
import { RosterDrag, RosterDragGroup, RosterScrollArea } from './RosterDrag'
import { RosterSelector } from './RosterSelector'
import { applyRosterDraft } from './scoringEdits'
import { copyState } from './scoringMachine'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringButton, ScoringError } from './ScoringSheet'
import {
  POSITIONS,
  type ScoringSessionState,
  type ScoringState,
  type Side
} from './scoringTypes'

export function RosterEditor({
  state,
  onSave
}: {
  state: ScoringState
  onSave: (draft: ScoringSessionState, nextBatter?: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const { height } = useWindowDimensions()
  const [draft, setDraft] = useState(() => copyState(state.session))
  const [side, setSide] = useState<Side>(battingSide(state.session))
  const [defense, setDefense] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [nextBatter, setNextBatter] = useState<number>()
  const edit = (change: (next: ScoringSessionState) => void): void => {
    setDraft(previous => {
      const next = copyState(previous)
      change(next)
      return next
    })
  }
  const team = draft.liveData.boxscore.teams[side]
  const names = draft.gameData.players
  const assigned = defense ? Object.values(team.defense) : team.battingOrder
  const place = (id: number, index: number): void => {
    if (!team.players.includes(id)) return
    edit(next => {
      const order = next.liveData.boxscore.teams[side].battingOrder
      const old = order.indexOf(id)
      if (old >= 0) order.splice(old, 1)
      order.splice(Math.max(0, Math.min(index, order.length)), 0, id)
    })
  }
  const remove = (id: number): void => {
    edit(next => {
      const list = next.liveData.boxscore.teams[side]
      list.battingOrder = list.battingOrder.filter(player => player !== id)
    })
  }
  const validation = applyRosterDraft(state, draft, nextBatter).error
  const text = {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: 14
  }
  const row = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: 48,
    gap: 6,
    paddingHorizontal: 6,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    borderRadius: 6,
    backgroundColor: theme.backgroundColor
  }
  const listHeight = Math.max(120, Math.min(420, height * 0.92 - 330))
  return (
    <View style={{ gap: 12 }}>
      <RosterSelector
        labels={['Away Team', 'Home Team']}
        value={side === 'away' ? 0 : 1}
        onChange={index => {
          setSide(index === 0 ? 'away' : 'home')
        }}
      />
      <Text style={{ ...text, textAlign: 'center', fontSize: 20 }}>
        {draft.gameData.teams[side].name}
      </Text>
      <RosterSelector
        labels={['Set Lineup', 'Set Defense']}
        value={defense ? 1 : 0}
        onChange={index => {
          setDefense(index === 1)
        }}
      />
      <Text style={text}>
        {defense
          ? 'Tap and drag players into their defensive positions.'
          : 'Tap players to add them to the lineup, or drag them into position.'}
      </Text>
      <RosterDragGroup key={`${side}:${defense}`}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ ...text, fontWeight: '700' }}>Roster</Text>
            <RosterScrollArea name="Roster players" height={listHeight}>
              <RosterDrag
                targetId="roster"
                onDropPlayer={defense ? undefined : remove}
              >
                {team.players.map(id => (
                  <RosterDrag
                    key={id}
                    playerId={id}
                    label={
                      defense
                        ? names[id].fullName
                        : `Add ${names[id].fullName} to Lineup`
                    }
                    disabled={assigned.includes(id)}
                    onTap={
                      defense
                        ? undefined
                        : () => {
                            if (!assigned.includes(id))
                              place(id, team.battingOrder.length)
                          }
                    }
                  >
                    <View style={row}>
                      <Text selectable={false} style={{ ...text, flex: 1 }}>
                        {names[id].fullName}
                      </Text>
                    </View>
                  </RosterDrag>
                ))}
                {!defense && (
                  <Text
                    style={{
                      ...text,
                      color: theme.secondaryTextColor,
                      padding: 12
                    }}
                  >
                    Drop here to remove
                  </Text>
                )}
              </RosterDrag>
            </RosterScrollArea>
          </View>
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ ...text, fontWeight: '700' }}>
              {defense ? 'Defense' : 'Lineup'}
            </Text>
            <RosterScrollArea
              name={defense ? 'Defensive positions' : 'Batting lineup'}
              height={listHeight}
            >
              {defense ? (
                POSITIONS.map(position => {
                  const id = team.defense[position]
                  return (
                    <RosterDrag
                      key={position}
                      targetId={`defense-${position}`}
                      onDropPlayer={player => {
                        if (
                          !team.players.includes(player) ||
                          assigned.includes(player)
                        )
                          return
                        edit(next => {
                          next.liveData.boxscore.teams[side].defense[position] =
                            player
                        })
                      }}
                    >
                      <View style={row}>
                        <Text
                          style={{
                            ...text,
                            borderWidth: 1,
                            borderColor: theme.defaultBorderColor,
                            padding: 4,
                            minWidth: 30
                          }}
                        >
                          {position}
                        </Text>
                        <Text style={{ ...text, flex: 1 }}>
                          {id == null ? 'Unassigned' : names[id].fullName}
                        </Text>
                        <ScoringButton
                          text="×"
                          label={`Clear ${position}`}
                          disabled={id == null}
                          onPress={() => {
                            edit(next => {
                              next.liveData.boxscore.teams[side].defense[
                                position
                              ] = null
                            })
                          }}
                        />
                      </View>
                    </RosterDrag>
                  )
                })
              ) : (
                <>
                  {team.battingOrder.map((id, index) => (
                    <RosterDrag
                      key={id}
                      playerId={id}
                      label={`Reorder ${names[id].fullName}`}
                      targetId={`lineup-${index}`}
                      onDropPlayer={player => {
                        place(player, index)
                      }}
                      onReorder={delta => {
                        place(id, index + delta)
                      }}
                    >
                      <View style={row}>
                        <Text
                          selectable={false}
                          accessibilityLabel={`Drag ${names[id].fullName}`}
                          style={{ ...text, fontSize: 24 }}
                        >
                          ≡
                        </Text>
                        <Text selectable={false} style={{ ...text, flex: 1 }}>
                          {index + 1}. {names[id].fullName}
                        </Text>
                        <ScoringButton
                          text="×"
                          label={`Remove ${names[id].fullName}`}
                          onPress={() => {
                            remove(id)
                          }}
                        />
                      </View>
                    </RosterDrag>
                  ))}
                  <RosterDrag
                    targetId="lineup-end"
                    onDropPlayer={id => {
                      place(id, team.battingOrder.length)
                    }}
                  >
                    <Text
                      style={{
                        ...text,
                        color: theme.secondaryTextColor,
                        padding: 18
                      }}
                    >
                      Drop at end of lineup
                    </Text>
                  </RosterDrag>
                </>
              )}
            </RosterScrollArea>
          </View>
        </View>
      </RosterDragGroup>
      {adding && (
        <TextInput
          accessibilityLabel="New player name"
          value={name}
          onChangeText={setName}
          placeholder="Player name"
          style={{
            ...text,
            padding: 12,
            borderWidth: 1,
            borderColor: theme.inputBorderColor
          }}
        />
      )}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <ScoringButton
            label={adding ? 'Create Player' : 'Add Player'}
            disabled={adding && name.trim().length === 0}
            onPress={() => {
              if (!adding) setAdding(true)
              else {
                edit(next => {
                  addDevelopmentPlayer(next, side, name)
                })
                setName('')
                setAdding(false)
              }
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <ScoringButton
            label="Save Rosters"
            disabled={validation != null}
            onPress={() => {
              onSave(draft, nextBatter)
            }}
          />
        </View>
      </View>
      {state.phase === 'awaitingBatter' && (
        <View style={{ gap: 6 }}>
          <Text style={text}>Choose Next Batter</Text>
          {draft.liveData.boxscore.teams[battingSide(draft)].battingOrder.map(
            id => (
              <ScoringButton
                key={id}
                label={`Next batter ${names[id].fullName}`}
                disabled={baseIds(draft).includes(id)}
                color={
                  nextBatter === id
                    ? theme.scoringMenuActiveBackground
                    : theme.scoringSelectorIdle
                }
                onPress={() => {
                  setNextBatter(id)
                }}
              />
            )
          )}
        </View>
      )}
      <ScoringError message={validation} />
    </View>
  )
}
