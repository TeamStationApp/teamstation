import React, { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type { RosterEntry } from '../../common/api'
import { rosterError } from '../../common/scoring/rules'
import { setupOf } from '../../common/scoring/state'
import { Button } from '../components/Button'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { withRosterDetails } from './currentSetup'
import { DefensiveField } from './DefensiveField'
import { EditRosterList } from './EditRosterList'
import { addPlaceholderPlayers } from './placeholderPlayers'
import {
  addPlayerDraft,
  draftOfLocalPlayer,
  editLocalPlayerDraft
} from './playerDraft'
import { PlayerEntrySheet } from './PlayerEntrySheet'
import { RosterDrag, RosterDragGroup, RosterScrollArea } from './RosterDrag'
import { byJersey } from './rosterOrder'
import { RosterRemoveButton } from './RosterRemoveButton'
import { RosterSelector } from './RosterSelector'
import { copyState } from './scoringMachine'
import { ScoringPlayerCard, scoringPlayerCardStyle } from './ScoringPlayerCard'
import { editRosterRows } from './scoringRosterEdit'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringError, ScoringSheetHeight } from './ScoringSheet'
import type {
  Position,
  ScoringSessionState,
  ScoringState,
  Side
} from './scoringTypes'

export type RosterMode = 'editRoster' | 'lineup' | 'defense'
export interface RosterEditorDraft {
  draft: ScoringSessionState
  side: Side
  mode: RosterMode
  scrollOffsets?: Partial<Record<Side, number>>
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
/** The complete field takes priority when a wrapping error leaves less list room. */
export function defenseRosterMinimum(
  areaHeight: number,
  dense: boolean
): number {
  const preferred = dense ? 64 : 88
  return areaHeight <= 0
    ? preferred
    : Math.min(preferred, Math.max(0, areaHeight - 60 - (dense ? 2 : 8)))
}
export function RosterEditor({
  state,
  initialDraft,
  defaultSide,
  rosters,
  onDraftChange,
  onEditPlayer,
  rosterLoading,
  rosterError: editError,
  onRetryRoster,
  canEditTeams,
  onCancel,
  onSave
}: {
  state: ScoringState
  onCancel?: () => void
  initialDraft?: RosterEditorDraft
  defaultSide?: Side
  /** Current labels only; roster edits retain the game's saved player details. */
  rosters?: Readonly<Record<string, readonly RosterEntry[]>>
  onDraftChange?: (draft: RosterEditorDraft) => void
  onEditPlayer?: (userId: number, name: string, teamId: string) => void
  rosterLoading?: boolean
  rosterError?: string
  onRetryRoster?: () => void
  canEditTeams?: Readonly<Record<string, boolean>>
  onSave: (draft: ScoringSessionState, nextBatter?: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const { height, width } = useWindowDimensions()
  const measuredHeight = useContext(ScoringSheetHeight)
  const availableHeight =
    measuredHeight != null && measuredHeight > 0 ? measuredHeight : height
  const [draft, setDraft] = useState(() =>
    copyState(initialDraft?.draft ?? state.session)
  )
  const [side, setSide] = useState<Side>(
    initialDraft?.side ?? defaultSide ?? battingSide(state.session)
  )
  const sideChosen = useRef(initialDraft != null || rosterLoading !== true)
  useEffect(() => {
    if (sideChosen.current || rosterLoading === true) return
    sideChosen.current = true
    if (defaultSide != null) setSide(defaultSide)
  }, [defaultSide, rosterLoading])
  const [mode, setMode] = useState<RosterMode>(initialDraft?.mode ?? 'lineup')
  const [scrollOffsets, setScrollOffsets] = useState(
    initialDraft?.scrollOffsets ?? {}
  )
  const defense = mode === 'defense'
  const dense = availableHeight > 0 && availableHeight < (defense ? 440 : 330)
  const narrowDefense = dense && defense && width < 600
  const inlineValidation = dense && defense && !narrowDefense
  const [areaHeight, setAreaHeight] = useState(0)
  const rosterMinimum = defense ? defenseRosterMinimum(areaHeight, dense) : 0
  const [adding, setAdding] = useState(false)
  const [editingLocal, setEditingLocal] = useState<number>()
  const [nextBatter, setNextBatter] = useState<number | undefined>(
    initialDraft?.nextBatter
  )
  useEffect(() => {
    onDraftChange?.({ draft, side, mode, nextBatter, scrollOffsets })
  }, [draft, side, mode, nextBatter, scrollOffsets, onDraftChange])
  const edit = (change: (next: ScoringSessionState) => void): void => {
    setDraft(previous => {
      const next = copyState(previous)
      change(next)
      return next
    })
  }
  const team = draft.liveData.boxscore.teams[side]
  // Game-only players belong to this game's setup, including the opponent's
  // placeholders. Their edits use scoring permission, like Create Player.
  const canEditLocal = rosterLoading !== true && state.readOnly !== true
  const names = useMemo(
    () =>
      rosters == null
        ? draft.gameData.players
        : withRosterDetails(draft, rosters).gameData.players,
    [draft, rosters]
  )
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
  const row = scoringPlayerCardStyle(theme)
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        gap: dense && defense ? 2 : dense ? 4 : 8
      }}
    >
      <ScrollView
        testID="Roster editor top"
        // Browser chrome can leave much less room than the screen height.
        // Instructions remain reachable by scrolling this compact header.
        style={{
          flexGrow: 0,
          maxHeight: dense ? (defense ? 28 : 48) : height < 500 ? 113 : 230
        }}
        contentContainerStyle={{ gap: 4, marginTop: dense && defense ? -6 : 0 }}
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
                sideChosen.current = true
                setSide(index === 0 ? 'away' : 'home')
              }}
            />
          </View>
          <View style={{ flex: dense ? 1 : undefined, minWidth: 0 }}>
            <RosterSelector
              fitContent={!narrowDefense}
              compact={narrowDefense}
              labels={[
                lstrings.scoring_edit_roster,
                'Set Lineup',
                'Set Defense'
              ]}
              accessibilityLabels={['Edit Roster', 'Set Lineup', 'Set Defense']}
              value={mode === 'editRoster' ? 0 : defense ? 2 : 1}
              onChange={index => {
                setMode(
                  index === 0
                    ? 'editRoster'
                    : index === 2
                      ? 'defense'
                      : 'lineup'
                )
              }}
            />
          </View>
        </View>
        <Text numberOfLines={defense ? 1 : undefined} style={text}>
          {mode === 'editRoster'
            ? lstrings.scoring_edit_roster_instruction
            : defense
              ? 'Drag player into position. On touch, hold briefly first.'
              : 'Tap to add to lineup. Hold briefly, then drag to reorder.'}
        </Text>
        {state.phase === 'awaitingBatter' && (
          <View style={{ gap: 6 }}>
            <Text style={text}>Choose Next Batter</Text>
            {draft.liveData.boxscore.teams[battingSide(draft)].battingOrder.map(
              id => (
                <ScoringPlayerCard
                  key={id}
                  label={`Next batter ${names[id].fullName}`}
                  disabled={baseIds(draft).includes(id)}
                  selected={nextBatter === id}
                  name={names[id].fullName}
                  onPress={() => {
                    setNextBatter(id)
                  }}
                />
              )
            )}
          </View>
        )}
      </ScrollView>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          display: mode === 'editRoster' ? 'flex' : 'none'
        }}
      >
        <EditRosterList
          key={side}
          visible={mode === 'editRoster'}
          initialScrollOffset={scrollOffsets[side]}
          onScrollOffset={offset => {
            setScrollOffsets(held =>
              held[side] === offset ? held : { ...held, [side]: offset }
            )
          }}
          rows={editRosterRows(
            rosters?.[draft.gameData.teams[side].id] ?? [],
            draft,
            side
          )}
          loading={rosterLoading}
          error={editError}
          onRetry={onRetryRoster}
          onEditLocal={
            canEditLocal
              ? id => {
                  setEditingLocal(id)
                }
              : undefined
          }
          onEdit={
            onEditPlayer == null ||
            (canEditTeams != null &&
              !canEditTeams[draft.gameData.teams[side].id]) ||
            rosterLoading === true
              ? undefined
              : (userId, name) => {
                  onEditPlayer(userId, name, draft.gameData.teams[side].id)
                }
          }
        />
      </View>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          display: mode === 'editRoster' ? 'none' : 'flex'
        }}
      >
        <RosterDragGroup key={`${side}:${mode}`}>
          <View
            onLayout={event => {
              setAreaHeight(event.nativeEvent.layout.height)
            }}
            style={{
              flex: 1,
              minHeight: 0,
              flexDirection: defense ? 'column' : 'row',
              gap: dense && defense ? 2 : 8
            }}
          >
            {defense && (
              <DefensiveField
                defense={team.defense}
                compact={height < 500}
                display={display}
                onPlace={(player, position) => {
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
                onClear={(position: Position) => {
                  edit(next => {
                    next.liveData.boxscore.teams[side].defense[position] = null
                  })
                }}
              />
            )}
            <View
              style={{
                flex: 1,
                minHeight: rosterMinimum,
                gap: 6
              }}
            >
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
                      .map(id => {
                        const card = (
                          <RosterDrag
                            key={id}
                            playerId={id}
                            immediateMouseDrag={defense}
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
                        )
                        return defense ? (
                          <View key={id} style={{ width: '47%' }}>
                            {card}
                          </View>
                        ) : (
                          card
                        )
                      })}
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
                          place(
                            player,
                            index + (edge === 'after' ? 1 : 0),
                            true
                          )
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
      </View>
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
      {editingLocal != null && state.readOnly !== true && (
        <PlayerEntrySheet
          key={`edit:${side}:${editingLocal}`}
          initialDraft={draftOfLocalPlayer(
            draft.gameData.players[editingLocal]
          )}
          onClose={() => {
            setEditingLocal(undefined)
          }}
          onAdd={player => {
            edit(next => {
              editLocalPlayerDraft(next, side, editingLocal, player)
            })
          }}
        />
      )}
      <View testID="Roster footer" style={{ gap: dense && defense ? 2 : 6 }}>
        {!inlineValidation && <ScoringError message={validation} />}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Button
              color={theme.scoringMenuActiveBackground}
              textColor={theme.scoringMenuActiveText}
              compact
              style={dense && defense ? { minHeight: 28 } : undefined}
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
              style={dense && defense ? { minHeight: 28 } : undefined}
              accessibilityLabel="Save Rosters"
              label="Save Rosters"
              disabled={validation != null}
              onPress={() => {
                onSave(draft, nextBatter)
              }}
            />
          </View>
        </View>
        <View
          style={{
            flexDirection: inlineValidation ? 'row' : 'column',
            alignItems: inlineValidation ? 'center' : undefined
          }}
        >
          {inlineValidation && (
            <View style={{ flex: 1, minWidth: 0 }}>
              {validation != null && (
                <Text
                  accessibilityRole="alert"
                  numberOfLines={1}
                  style={{ color: theme.dangerColor, fontSize: 11 }}
                >
                  {validation}
                </Text>
              )}
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={() => {
              onCancel?.()
            }}
            style={{
              minHeight: dense ? (defense ? 28 : 36) : 44,
              minWidth: inlineValidation ? 80 : undefined,
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
          {inlineValidation && <View style={{ flex: 1 }} />}
        </View>
      </View>
    </View>
  )
}
