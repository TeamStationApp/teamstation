import React, { useContext, useEffect, useState } from 'react'
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { rosterError } from '../../common/scoring/rules'
import { setupOf } from '../../common/scoring/state'
import { Button } from '../components/Button'
import { useTheme } from '../theme/ThemeContext'
import { DefensiveField } from './DefensiveField'
import { addPlaceholderPlayers } from './placeholderPlayers'
import { addPlayerDraft } from './playerDraft'
import { PlayerEntrySheet } from './PlayerEntrySheet'
import { RosterDrag, RosterDragGroup, RosterScrollArea } from './RosterDrag'
import { byJersey } from './rosterOrder'
import { RosterRemoveButton } from './RosterRemoveButton'
import { RosterSelector } from './RosterSelector'
import { copyState } from './scoringMachine'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringButton, ScoringError, ScoringSheetHeight } from './ScoringSheet'
import type {
  Position,
  ScoringSessionState,
  ScoringState,
  Side
} from './scoringTypes'

export interface RosterEditorDraft {
  draft: ScoringSessionState
  side: Side
  defense: boolean
  nextBatter?: number
}
/**
 * A roster, lineup or defence card's name, on one line. A phone scales text
 * by the reader's text size (the iPhone 13 Pro on the bench reads 12% larger
 * than the web), which wrapped "1. #27 Trey H" after "Trey" in a column
 * 159 points wide; the phone shrinks the line to fit instead, down to three
 * quarters. The web keeps its wrap, as a browser cannot shrink to fit.
 */
export const rosterNameProps = (
  os: string
): {
  numberOfLines?: number
  adjustsFontSizeToFit?: boolean
  minimumFontScale?: number
} =>
  os === 'web'
    ? {}
    : { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.75 }
export function RosterEditor({
  state,
  initialDraft,
  onDraftChange,
  onCancel,
  onSave
}: {
  state: ScoringState
  onCancel?: () => void
  initialDraft?: RosterEditorDraft
  onDraftChange?: (draft: RosterEditorDraft) => void
  onSave: (draft: ScoringSessionState, nextBatter?: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const { height } = useWindowDimensions()
  const availableHeight = useContext(ScoringSheetHeight) ?? height
  const dense = availableHeight < 330
  const [draft, setDraft] = useState(() =>
    copyState(initialDraft?.draft ?? state.session)
  )
  const [side, setSide] = useState<Side>(
    initialDraft?.side ?? battingSide(state.session)
  )
  const [defense, setDefense] = useState(initialDraft?.defense ?? false)
  const [adding, setAdding] = useState(false)
  const [nextBatter, setNextBatter] = useState<number | undefined>(
    initialDraft?.nextBatter
  )
  useEffect(() => {
    onDraftChange?.({ draft, side, defense, nextBatter })
  }, [draft, side, defense, nextBatter, onDraftChange])
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
  const nameProps = rosterNameProps(Platform.OS)
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
  return (
    <View style={{ flex: 1, minHeight: 0, gap: dense ? 4 : 8 }}>
      <ScrollView
        testID="Roster editor top"
        // Browser chrome can leave much less room than the screen height.
        // Instructions remain reachable by scrolling this compact header.
        style={{
          flexGrow: 0,
          maxHeight: dense ? 48 : height < 500 ? 113 : 230
        }}
        contentContainerStyle={{ gap: 4 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: dense ? 'row' : 'column', gap: 4 }}>
          <View style={{ flex: dense ? 1 : undefined, minWidth: 0 }}>
            <RosterSelector
              labels={[
                draft.gameData.teams.away.name,
                draft.gameData.teams.home.name
              ]}
              captions={dense ? undefined : ['Away', 'Home']}
              compact={height < 500}
              accessibilityLabels={['Away Team', 'Home Team']}
              value={side === 'away' ? 0 : 1}
              onChange={index => {
                setSide(index === 0 ? 'away' : 'home')
              }}
            />
          </View>
          <View style={{ flex: dense ? 1 : undefined, minWidth: 0 }}>
            <RosterSelector
              fitContent
              labels={['Set Lineup', 'Set Defense']}
              value={defense ? 1 : 0}
              onChange={index => {
                setDefense(index === 1)
              }}
            />
          </View>
        </View>
        <Text numberOfLines={defense ? 1 : undefined} style={text}>
          {defense
            ? 'Drag player into defensive position'
            : 'Tap to add to lineup. Hold briefly, then drag to reorder.'}
        </Text>
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
      </ScrollView>
      <RosterDragGroup key={`${side}:${defense}`}>
        <View
          style={{
            flex: 1,
            minHeight: 0,
            flexDirection: defense ? 'column' : 'row',
            gap: 8
          }}
        >
          {defense && (
            <DefensiveField
              defense={team.defense}
              compact={height < 500}
              display={display}
              onPlace={(player, position) => {
                if (!team.players.includes(player) || assigned.includes(player))
                  return
                edit(next => {
                  next.liveData.boxscore.teams[side].defense[position] = player
                })
              }}
              onClear={(position: Position) => {
                edit(next => {
                  next.liveData.boxscore.teams[side].defense[position] = null
                })
              }}
            />
          )}
          <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
            {!dense && (
              <Text style={{ ...text, fontWeight: '700' }}>Roster</Text>
            )}
            <RosterScrollArea name="Roster players">
              <RosterDrag
                targetId="roster"
                onDropPlayer={defense ? undefined : remove}
              >
                <View
                  testID={defense ? 'Defense roster grid' : undefined}
                  style={
                    defense
                      ? { flexDirection: 'row', flexWrap: 'wrap', gap: 16 }
                      : { gap: 16 }
                  }
                >
                  {byJersey(team.players, names)
                    .filter(id => !assigned.includes(id))
                    .map(id => (
                      <View
                        key={id}
                        style={defense ? { width: '47%' } : undefined}
                      >
                        <RosterDrag
                          playerId={id}
                          label={
                            defense
                              ? names[id].fullName
                              : `Add ${names[id].fullName} to Lineup`
                          }
                          onTap={
                            defense
                              ? undefined
                              : () => {
                                  place(id, team.battingOrder.length)
                                }
                          }
                        >
                          <View style={row}>
                            <Text
                              selectable={false}
                              {...nameProps}
                              style={{ ...text, flex: 1 }}
                            >
                              {display(id)}
                            </Text>
                          </View>
                        </RosterDrag>
                      </View>
                    ))}
                </View>
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
          {!defense && (
            <View style={{ flex: 1, minHeight: 0, gap: 6 }}>
              {!dense && (
                <Text style={{ ...text, fontWeight: '700' }}>Lineup</Text>
              )}
              <RosterScrollArea name="Batting lineup">
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
                        <Text
                          selectable={false}
                          {...nameProps}
                          style={{ ...text, flex: 1 }}
                        >
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
              </RosterScrollArea>
            </View>
          )}
        </View>
      </RosterDragGroup>
      {adding && (
        <PlayerEntrySheet
          onClose={() => {
            setAdding(false)
          }}
          onAddPlaceholders={count => {
            edit(next => {
              addPlaceholderPlayers(next, side, count)
            })
          }}
          onAdd={player => {
            edit(next => {
              addPlayerDraft(next, side, player)
            })
          }}
        />
      )}
      <View testID="Roster footer" style={{ gap: 6 }}>
        <ScoringError message={validation} />
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          onPress={() => {
            onCancel?.()
          }}
          style={{
            minHeight: dense ? 36 : 44,
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Text
            style={{
              ...text,
              color: theme.dangerColor,
              fontFamily: theme.semiBoldTextFont
            }}
          >
            Cancel
          </Text>
        </Pressable>
      </View>
    </View>
  )
}
