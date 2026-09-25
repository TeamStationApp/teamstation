import React, { useContext, useState } from 'react'
import { Pressable, Text, useWindowDimensions, View } from 'react-native'

import { rosterError } from '../../common/scoring/rules'
import { setupOf } from '../../common/scoring/state'
import { Button } from '../components/Button'
import { useTheme } from '../theme/ThemeContext'
import { addPlaceholderPlayers } from './placeholderPlayers'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import { addPlayerDraft } from './playerDraft'
import { PlayerEntrySheet } from './PlayerEntrySheet'
import { RosterDrag, RosterDragGroup, RosterScrollArea } from './RosterDrag'
import { RosterRemoveButton } from './RosterRemoveButton'
import { RosterSelector } from './RosterSelector'
import { copyState } from './scoringMachine'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringButton, ScoringError, ScoringSheetHeight } from './ScoringSheet'
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
  const contentHeight = useContext(ScoringSheetHeight)
  const [draft, setDraft] = useState(() => copyState(state.session))
  const [side, setSide] = useState<Side>(battingSide(state.session))
  const [defense, setDefense] = useState(false)
  const [adding, setAdding] = useState(false)
  const [placeholders, setPlaceholders] = useState(false)
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
  const display = (id: number): string =>
    `${names[id].jersey === '' ? '' : `#${names[id].jersey} `}${names[id].fullName}`
  const assigned = defense ? Object.values(team.defense) : team.battingOrder
  const place = (id: number, index: number, boundary = false): void => {
    if (!team.players.includes(id)) return
    edit(next => {
      const order = next.liveData.boxscore.teams[side].battingOrder
      const old = order.indexOf(id)
      if (old >= 0) order.splice(old, 1)
      order.splice(
        Math.max(
          0,
          Math.min(
            index - (boundary && old >= 0 && old < index ? 1 : 0),
            order.length
          )
        ),
        0,
        id
      )
    })
  }
  const remove = (id: number): void => {
    edit(next => {
      const list = next.liveData.boxscore.teams[side]
      list.battingOrder = list.battingOrder.filter(player => player !== id)
    })
  }
  const validation = rosterError(state.session, setupOf(draft), nextBatter)
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
    shadowColor: theme.buttonShadowColor,
    shadowOpacity: 1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
    borderRadius: 6,
    backgroundColor: theme.scoringSelectorIdle
  }
  const listHeight = Math.max(120, (contentHeight ?? height - 80) - 356)
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
          ? 'Hold a player briefly, then drag into a defensive position.'
          : 'Tap to add to lineup. Hold briefly, then drag to reorder.'}
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
                        {display(id)}
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
                        <View
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            backgroundColor: '#fff',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          <Text
                            style={{
                              ...text,
                              color: '#19251a',
                              textAlign: 'center'
                            }}
                          >
                            {position}
                          </Text>
                        </View>
                        <Text style={{ ...text, flex: 1 }}>
                          {id == null ? 'Unassigned' : display(id)}
                        </Text>
                        <RosterRemoveButton
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
                      insertion="row"
                      onDropPlayer={(player, edge) => {
                        place(player, index + (edge === 'after' ? 1 : 0), true)
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
                          {index + 1}. {display(id)}
                        </Text>
                        <RosterRemoveButton
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
                    insertion="end"
                    onDropPlayer={id => {
                      place(id, team.battingOrder.length, true)
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
        <PlayerEntrySheet
          onClose={() => {
            setAdding(false)
          }}
          onAdd={player => {
            edit(next => {
              addPlayerDraft(next, side, player)
            })
          }}
        />
      )}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Button
            color={theme.scoringMenuActiveBackground}
            textColor={theme.scoringMenuActiveText}
            compact
            accessibilityLabel="Create Player"
            label="Add Player"
            onPress={() => {
              setAdding(true)
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            color={theme.scoringMenuActiveBackground}
            textColor={theme.scoringMenuActiveText}
            compact
            accessibilityLabel="Save Rosters"
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
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add Placeholder Players"
        onPress={() => {
          setPlaceholders(true)
        }}
        style={{
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Text
          style={{
            ...text,
            color: theme.successColor,
            fontFamily: theme.semiBoldTextFont
          }}
        >
          Add Placeholder Players
        </Text>
      </Pressable>
      {placeholders && (
        <PlaceholderPlayersSheet
          onClose={() => {
            setPlaceholders(false)
          }}
          onAdd={count => {
            edit(next => {
              addPlaceholderPlayers(next, side, count)
            })
          }}
        />
      )}
    </View>
  )
}
