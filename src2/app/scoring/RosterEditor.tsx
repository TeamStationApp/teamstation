import React, { useState } from 'react'
import { Text, TextInput, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { addDevelopmentPlayer } from './developmentSession'
import { RosterDrag, RosterDragGroup } from './RosterDrag'
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
  const [draft, setDraft] = useState(() => copyState(state.session))
  const [side, setSide] = useState<Side>(battingSide(state.session))
  const [defense, setDefense] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<number>()
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
      order.splice(Math.min(index, order.length), 0, id)
    })
  }
  const remove = (id: number): void => {
    edit(next => {
      const list = next.liveData.boxscore.teams[side]
      list.battingOrder = list.battingOrder.filter(player => player !== id)
    })
  }
  const validation = applyRosterDraft(state, draft, nextBatter).error
  return (
    <RosterDragGroup>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['away', 'home'] as const).map(value => (
            <ScoringButton
              key={value}
              label={value === 'home' ? 'Home Team' : 'Away Team'}
              color={
                side === value ? theme.scoringInstructionBackground : undefined
              }
              onPress={() => {
                setSide(value)
                setSelected(undefined)
              }}
            />
          ))}
        </View>
        <Text
          style={{
            color: theme.primaryTextColor,
            fontFamily: theme.regularTextFont,
            textAlign: 'center',
            fontSize: 20
          }}
        >
          {draft.gameData.teams[side].name}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <ScoringButton
            label="Set Lineup"
            onPress={() => {
              setDefense(false)
              setSelected(undefined)
            }}
          />
          <ScoringButton
            label="Set Defense"
            onPress={() => {
              setDefense(true)
              setSelected(undefined)
            }}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1, gap: 8 }}>
            <Text
              style={{
                color: theme.primaryTextColor,
                fontFamily: theme.regularTextFont,
                fontWeight: '700'
              }}
            >
              Roster
            </Text>
            <RosterDrag
              targetId="roster"
              onDropPlayer={defense ? undefined : remove}
            >
              {team.players.map(id => (
                <RosterDrag
                  key={id}
                  playerId={id}
                  disabled={assigned.includes(id)}
                >
                  <View
                    style={{
                      padding: 6,
                      gap: 4,
                      borderBottomWidth: 1,
                      borderColor: theme.defaultBorderColor
                    }}
                  >
                    <Text
                      style={{
                        color: theme.primaryTextColor,
                        fontFamily: theme.regularTextFont
                      }}
                    >
                      {names[id].fullName}
                    </Text>
                    <ScoringButton
                      text={defense ? 'Select' : 'Add to Lineup'}
                      label={
                        defense
                          ? `Select ${names[id].fullName}`
                          : `Add ${names[id].fullName} to Lineup`
                      }
                      disabled={assigned.includes(id)}
                      onPress={() => {
                        if (defense) setSelected(id)
                        else place(id, team.battingOrder.length)
                      }}
                    />
                  </View>
                </RosterDrag>
              ))}
            </RosterDrag>
            {adding && (
              <TextInput
                accessibilityLabel="New player name"
                value={name}
                onChangeText={setName}
                placeholder="Player name"
                style={{
                  color: theme.primaryTextColor,
                  fontFamily: theme.regularTextFont,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: theme.inputBorderColor
                }}
              />
            )}
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
          <View style={{ flex: 1, gap: 8 }}>
            <Text
              style={{
                color: theme.primaryTextColor,
                fontFamily: theme.regularTextFont,
                fontWeight: '700'
              }}
            >
              {defense ? 'Defense' : 'Lineup'}
            </Text>
            {defense ? (
              POSITIONS.map(position => {
                const id = team.defense[position]
                const assign = (player: number): void => {
                  if (
                    !team.players.includes(player) ||
                    assigned.includes(player)
                  )
                    return
                  edit(next => {
                    next.liveData.boxscore.teams[side].defense[position] =
                      player
                  })
                  setSelected(undefined)
                }
                return (
                  <RosterDrag
                    key={position}
                    targetId={`defense-${position}`}
                    onDropPlayer={assign}
                  >
                    <View
                      style={{
                        gap: 4,
                        padding: 6,
                        borderWidth: 1,
                        borderColor: theme.defaultBorderColor
                      }}
                    >
                      <View
                        style={{
                          flexDirection: 'row',
                          gap: 8,
                          alignItems: 'center'
                        }}
                      >
                        <Text
                          style={{
                            color: theme.primaryTextColor,
                            width: 36,
                            borderWidth: 1,
                            borderColor: theme.inputBorderColor,
                            padding: 4
                          }}
                        >
                          {position}
                        </Text>
                        <Text
                          style={{
                            color: theme.primaryTextColor,
                            fontFamily: theme.regularTextFont,
                            flex: 1
                          }}
                        >
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
                      {selected != null && (
                        <ScoringButton
                          label={`Assign ${names[selected].fullName} to ${position}`}
                          onPress={() => {
                            assign(selected)
                          }}
                        />
                      )}
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
                    targetId={`lineup-${index}`}
                    onDropPlayer={player => {
                      place(player, index)
                    }}
                  >
                    <View
                      style={{
                        gap: 4,
                        padding: 6,
                        borderWidth: 1,
                        borderColor: theme.defaultBorderColor
                      }}
                    >
                      <Text
                        style={{
                          color: theme.primaryTextColor,
                          fontFamily: theme.regularTextFont
                        }}
                      >
                        {index + 1}. {names[id].fullName}
                      </Text>
                      <View
                        style={{
                          flexDirection: 'row',
                          flexWrap: 'wrap',
                          gap: 4
                        }}
                      >
                        <ScoringButton
                          text="↑"
                          label={`Move ${names[id].fullName} Up`}
                          disabled={index === 0}
                          onPress={() => {
                            place(id, index - 1)
                          }}
                        />
                        <ScoringButton
                          text="↓"
                          label={`Move ${names[id].fullName} Down`}
                          disabled={index === team.battingOrder.length - 1}
                          onPress={() => {
                            place(id, index + 1)
                          }}
                        />
                        <ScoringButton
                          text="×"
                          label={`Remove ${names[id].fullName}`}
                          onPress={() => {
                            remove(id)
                          }}
                        />
                      </View>
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
                    style={{ color: theme.secondaryTextColor, padding: 20 }}
                  >
                    Drop at end of lineup
                  </Text>
                </RosterDrag>
              </>
            )}
          </View>
        </View>
        {state.phase === 'awaitingBatter' && (
          <View style={{ gap: 6 }}>
            <Text
              style={{
                color: theme.primaryTextColor,
                fontFamily: theme.regularTextFont
              }}
            >
              Choose Next Batter
            </Text>
            {draft.liveData.boxscore.teams[battingSide(draft)].battingOrder.map(
              id => (
                <ScoringButton
                  key={id}
                  label={`Next batter ${names[id].fullName}`}
                  disabled={baseIds(draft).includes(id)}
                  color={
                    nextBatter === id
                      ? theme.scoringInstructionBackground
                      : undefined
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
        <ScoringButton
          label="Save Rosters"
          disabled={validation != null}
          onPress={() => {
            onSave(draft, nextBatter)
          }}
        />
      </View>
    </RosterDragGroup>
  )
}
