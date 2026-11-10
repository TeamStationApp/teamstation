import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  type GestureResponderEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewProps
} from 'react-native'

import type { LineupPlayer } from '../../../common/api'
import {
  addInning,
  alignPlan,
  clearPlan,
  DEFAULT_PLAN_INNINGS,
  type GamePlan,
  MAX_PLAN_INNINGS,
  type PlanCell,
  planHasPositions,
  removeInning
} from '../../../common/gamePlan'
import {
  type PlanHistory,
  type PlanSameDay,
  planWarnings
} from '../../../common/planWarnings'
import type { PlayingTimeRules } from '../../../common/playingTimeRules'
import { useConfirmedAction } from '../../components/useConfirmedAction'
import { lstrings, sprintf } from '../../locales/strings'
import { HelpSheet } from '../HelpSheet'
import { RosterDrag, RosterDragGroup } from '../RosterDrag'
import {
  measureRosterView,
  RosterClipContext,
  useRosterGesture
} from '../RosterDragContext'
import { useScoringSheetTheme } from '../scoringSheetTheme'
import { NativePlanCell, WebPlanCell } from './PlanCell'
import { PlanFieldPicker } from './PlanFieldPicker'
import {
  type AssignDrag,
  moveAssignDrag,
  type PickerTarget,
  type PlanCellAddress,
  type PlanPoint,
  releaseAssignDrag,
  startAssignDrag
} from './planGesture'
import {
  PLAN_COLUMN_WIDTH,
  PLAN_HEADER_HEIGHT,
  PLAN_PICKER_HEIGHT,
  PLAN_PICKER_WIDTH,
  PLAN_PLAYER_WIDTH,
  PLAN_ROW_HEIGHT,
  PLAN_SLOT_WIDTH,
  planPickerTop
} from './planLayout'
import { PlanWarnings } from './PlanWarnings'

/**
 * What the plan's warnings are judged by: the rules, the season's history
 * and the day's other games from `GET /games/:gameId/plans`, and from the
 * game the screen holds, whether it is final and the innings it reached.
 */
export interface PlanContext {
  rules: PlayingTimeRules | null
  history: PlanHistory
  sameDay: PlanSameDay
  status: 'scheduled' | 'inProgress' | 'final'
  playedInnings?: number
}

/** A batter of the plan's side, in batting order. */
export interface PlanBatter {
  /** His id in the game. */
  id: number
  /** Who he is, which his plan row is matched by. */
  player: LineupPlayer
  /** His name as the side shows it, and his jersey number or ''. */
  name: string
  jersey: string
}

/** A plan row's player: "Ruth #7", the name first; "Ruth" with no number. */
export const planBatterLabel = ({ name, jersey }: PlanBatter): string =>
  jersey === '' ? name : `${name} #${jersey}`

/** The vertical scroll the row drag auto-scrolls. */
const SCROLL_NAME = 'Plan sheet'

/**
 * The coach's game plan: a row of a blue Help and a red Clear, then a sheet
 * of the lineup in batting order, one two-character column per inning, then
 * the playing-time warnings. The player column stays put while the innings
 * scroll sideways. A cell is set by typing (web) or from the field picker;
 * a player is dragged up or down to change the batting order, and his row's
 * innings move with him. A plan is on while any cell holds a position, so
 * every change carries that as `enabled`. The innings added past the first
 * six have red numbers, which delete their inning once confirmed.
 */
export function PlanTab(props: {
  plan: GamePlan
  batters: readonly PlanBatter[]
  context: PlanContext
  onChange: (plan: GamePlan) => void
  /** A player dropped on a row: the Lineup tab's own move. */
  onDrop: (id: number, index: number, edge?: 'before' | 'after') => void
  /** A player moved by the keyboard, a row at a time. */
  onReorder: (id: number, delta: number) => void
  /**
   * After the first pitch, as on the Lineup tab, a drop swaps two batters,
   * so a row shows no insertion edge.
   */
  locked?: boolean
  /**
   * On a phone, the picker's close while it is open, and undefined once it
   * shuts: the screen around the sheet takes a tap outside it to close it,
   * as the sheet's own backdrop does.
   */
  onPicker?: (close: (() => void) | undefined) => void
  /** The platform, which decides the cells: the app's own but for tests. */
  os?: string
}): React.ReactElement {
  return (
    <RosterDragGroup>
      <PlanSheet {...props} os={props.os ?? Platform.OS} />
    </RosterDragGroup>
  )
}

const pointOf = (event: GestureResponderEvent): PlanPoint => ({
  x: event.nativeEvent.pageX,
  y: event.nativeEvent.pageY
})

function PlanSheet({
  plan,
  batters,
  context,
  onChange,
  onDrop,
  onReorder,
  locked = false,
  onPicker,
  os
}: {
  plan: GamePlan
  batters: readonly PlanBatter[]
  context: PlanContext
  onChange: (plan: GamePlan) => void
  onDrop: (id: number, index: number, edge?: 'before' | 'after') => void
  onReorder: (id: number, delta: number) => void
  locked?: boolean
  onPicker?: (close: (() => void) | undefined) => void
  os: string
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const surface = theme.scoringSurface
  const web = os === 'web'
  const engine = useRosterGesture()
  const players = useMemo(() => batters.map(batter => batter.player), [batters])
  const aligned = useMemo(() => alignPlan(plan, players), [plan, players])
  // Live: every cell and every move of a player is judged again at once.
  const warnings = useMemo(
    () =>
      planWarnings({
        plan: aligned,
        rules: context.rules,
        playedInnings: context.playedInnings,
        final: context.status === 'final',
        history: context.history,
        sameDay: context.sameDay
      }),
    [aligned, context]
  )
  // Every change says whether the plan is now on: whether it holds a
  // position.
  const emit = (next: GamePlan): void => {
    onChange({ ...next, enabled: planHasPositions(next) })
  }
  const current = useRef({ aligned, onChange: emit })
  current.current = { aligned, onChange: emit }
  const setCell = (at: PlanCellAddress, value: PlanCell): void => {
    const { aligned: shown, onChange: change } = current.current
    change({
      ...shown,
      rows: shown.rows.map((row, index) =>
        index !== at.row
          ? row
          : {
              ...row,
              cells: row.cells.map((cell, inning) =>
                inning === at.inning ? value : cell
              )
            }
      )
    })
  }

  /**
   * A position chosen from the picker, by a tap, a hold or a drag alike:
   * the cell's own value again takes it off, to the bench.
   */
  const pick = (at: PlanCellAddress, value: PlanCell): void => {
    const own = current.current.aligned.rows[at.row].cells[at.inning]
    setCell(at, value === own ? '' : value)
  }

  const [picking, setPicking] = useState<PlanCellAddress>()
  const [drag, setDrag] = useState<AssignDrag>()
  const dragging = useRef<AssignDrag | undefined>(undefined)
  const rootOwns = useRef(false)
  const targets = useRef<PickerTarget[]>([])
  const measureTargets = useRef<(() => Promise<PickerTarget[]>) | null>(null)
  /** The targets where they are now, kept for the next move. */
  const remeasure = async (): Promise<PickerTarget[]> => {
    const found = (await measureTargets.current?.()) ?? targets.current
    targets.current = found
    return found
  }
  const [held, setHeld] = useState(false)
  const [touching, setTouching] = useState(false)
  const [lifted, setLifted] = useState<number>()
  const [refusal, setRefusal] = useState<string>()
  useEffect(() => {
    const listen = (): void => {
      setLifted(
        engine.preview?.cardRect != null ? engine.active?.id : undefined
      )
    }
    engine.heldListeners.add(setHeld)
    engine.listeners.add(listen)
    return () => {
      engine.heldListeners.delete(setHeld)
      engine.listeners.delete(listen)
    }
  }, [engine])

  // The sheet's own vertical scroll, which a row drag scrolls at its edges.
  const port = useRef<React.ComponentRef<typeof View>>(null)
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const offset = useRef(0)
  const content = useRef(0)
  const [area, setArea] = useState({ width: 0, height: 0 })
  const visible = useRef(0)
  visible.current = area.height
  const [scrollY, setScrollY] = useState(0)
  const [sheetTop, setSheetTop] = useState(0)
  const measure = useRef(
    async () => await measureRosterView(port.current)
  ).current
  useEffect(() => {
    engine.scrolls.set(SCROLL_NAME, {
      measure,
      offset: () => offset.current,
      scroll: delta => {
        offset.current = Math.max(
          0,
          Math.min(content.current - visible.current, offset.current + delta)
        )
        scroller.current?.scrollTo({ y: offset.current, animated: false })
      }
    })
    return () => {
      engine.scrolls.delete(SCROLL_NAME)
    }
  }, [engine, measure])

  // The web closes the picker when focus leaves both the cells and it.
  const sheetNode = useRef<React.ComponentRef<typeof View>>(null)
  const pickerNode = useRef<React.ComponentRef<typeof View>>(null)
  const closeUnlessFocused = (): void => {
    setTimeout(() => {
      const active = document.activeElement
      const inside = (node: unknown): boolean =>
        active != null &&
        (node as { contains?: (other: Node) => boolean } | null)?.contains?.(
          active
        ) === true
      if (inside(pickerNode.current)) return
      if (inside(sheetNode.current) && active?.tagName === 'INPUT') return
      setPicking(undefined)
    }, 0)
  }

  // A web click anywhere but the picker and the cells closes the picker,
  // changing nothing, even where the click takes no focus from the cell.
  useEffect(() => {
    if (!web || picking == null) return
    const press = (event: Event): void => {
      const target = event.target as Node | null
      const holds = (node: unknown): boolean =>
        target != null &&
        (node as { contains?: (other: Node) => boolean } | null)?.contains?.(
          target
        ) === true
      if (holds(pickerNode.current)) return
      if (holds(sheetNode.current) && (target as Element).tagName === 'INPUT')
        return
      setPicking(undefined)
    }
    document.addEventListener('pointerdown', press, true)
    return () => {
      document.removeEventListener('pointerdown', press, true)
    }
  }, [web, picking])

  // A phone's hold-and-drag: once the hold has opened the picker, the root
  // takes the finger's moves, wherever it goes, until it lets go.
  const endDrag = (): void => {
    dragging.current = undefined
    rootOwns.current = false
    setDrag(undefined)
  }
  const assignResponder: ViewProps = {
    onMoveShouldSetResponderCapture: () => dragging.current != null,
    onResponderGrant: () => {
      rootOwns.current = true
    },
    onResponderMove: event => {
      if (dragging.current == null) return
      const next = moveAssignDrag(
        dragging.current,
        pointOf(event),
        targets.current
      )
      dragging.current = next
      setDrag(next)
      remeasure().catch(() => undefined)
    },
    onResponderRelease: event => {
      const finished = dragging.current
      const point = pointOf(event)
      endDrag()
      if (finished == null) return
      remeasure()
        .then(found => {
          const { write, close } = releaseAssignDrag(finished, point, found)
          if (write != null) pick(finished.cell, write)
          if (close) setPicking(undefined)
        })
        .catch(() => undefined)
    },
    onResponderTerminationRequest: () => false,
    onResponderTerminate: endDrag
  }
  // A hold on one of the picker's targets: a drag from there, over it at
  // once, so its enlarged box shows. Let go where it held, with no move the
  // root took, it is written.
  const holdTarget = (target: PlanCell, point: PlanPoint): void => {
    if (picking == null) return
    const start = startAssignDrag(picking, point, target)
    dragging.current = start
    rootOwns.current = false
    setDrag(start)
  }
  const releaseTarget = (): void => {
    setTimeout(() => {
      const held = dragging.current
      if (rootOwns.current || held == null) return
      endDrag()
      if (held.over == null) return
      pick(held.cell, held.over)
      setPicking(undefined)
    }, 0)
  }

  const header = {
    color: surface.mutedText,
    fontFamily: theme.semiBoldTextFont,
    fontSize: 12,
    letterSpacing: 0.6
  }
  const rule = {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: surface.divider
  }
  const chosen = picking == null ? undefined : aligned.rows[picking.row]
  const open = picking != null && chosen != null
  const told = useRef(onPicker)
  told.current = onPicker
  useEffect(() => {
    if (web) return
    told.current?.(
      open
        ? () => {
            setPicking(undefined)
          }
        : undefined
    )
  }, [web, open])
  // Shut with the sheet: the screen's backdrop goes too.
  useEffect(
    () => () => {
      told.current?.(undefined)
    },
    []
  )
  const pickerWidth = Math.min(PLAN_PICKER_WIDTH, area.width)
  const rowTop =
    picking == null
      ? 0
      : sheetTop + PLAN_HEADER_HEIGHT + picking.row * PLAN_ROW_HEIGHT - scrollY
  const pickerTop = planPickerTop({
    rowTop,
    rowBottom: rowTop + PLAN_ROW_HEIGHT,
    height: PLAN_PICKER_HEIGHT,
    areaTop: Math.max(0, sheetTop + PLAN_HEADER_HEIGHT - scrollY),
    areaBottom: area.height
  })
  const confirming = useConfirmedAction('plan', 'confirm')
  const [helping, setHelping] = useState(false)
  const innings = Array.from({ length: aligned.innings }, (_, at) => at + 1)
  const deleteInning = (inning: number): void => {
    const title = sprintf(lstrings.plan_delete_inning_title, inning)
    confirming.open({
      title,
      detail: lstrings.plan_delete_inning_detail,
      sheetLabel: title,
      label: lstrings.plan_delete,
      testID: 'Plan delete inning confirm',
      run: async () => {
        const { aligned: shown, onChange: change } = current.current
        setPicking(undefined)
        change(removeInning(shown, inning))
      }
    })
  }
  const link = {
    minHeight: 44,
    justifyContent: 'center' as const
  }
  return (
    <View
      testID="Plan tab"
      style={{ flex: 1, minHeight: 0 }}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout
        setArea({ width, height })
      }}
      {...(web ? {} : assignResponder)}
    >
      <View
        ref={port}
        testID="Plan sheet area"
        collapsable={false}
        style={{ flex: 1, minHeight: 0 }}
      >
        <RosterClipContext.Provider value={measure}>
          <ScrollView
            ref={scroller}
            testID="Plan scroll"
            scrollEnabled={!held && !touching && drag == null}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={(_, height) => {
              content.current = height
            }}
            onScroll={event => {
              offset.current = event.nativeEvent.contentOffset.y
              setScrollY(offset.current)
            }}
            scrollEventThrottle={16}
            contentContainerStyle={{ gap: 12, paddingBottom: 8 }}
          >
            <View
              testID="Plan help row"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <Pressable
                testID="Plan help"
                accessibilityRole="button"
                accessibilityLabel={lstrings.plan_help_label}
                onPress={() => {
                  setHelping(true)
                }}
                style={{ ...link, paddingRight: 16 }}
              >
                <Text
                  selectable={false}
                  style={{
                    color: theme.linkTextColor,
                    fontFamily: theme.boldTextFont,
                    fontSize: 16
                  }}
                >
                  {lstrings.roster_help}
                </Text>
              </Pressable>
              <Pressable
                testID="Plan clear"
                accessibilityRole="button"
                accessibilityLabel={lstrings.plan_clear_label}
                onPress={() => {
                  confirming.open({
                    title: lstrings.plan_clear_title,
                    detail: lstrings.plan_clear_detail,
                    sheetLabel: lstrings.plan_clear_title,
                    label: lstrings.plan_clear,
                    testID: 'Plan clear confirm',
                    run: async () => {
                      const { aligned: shown, onChange: change } =
                        current.current
                      change(clearPlan(shown))
                    }
                  })
                }}
                style={{ ...link, paddingLeft: 16 }}
              >
                <Text
                  selectable={false}
                  style={{
                    color: theme.scoringOutColor,
                    fontFamily: theme.boldTextFont,
                    fontSize: 16
                  }}
                >
                  {lstrings.plan_clear}
                </Text>
              </Pressable>
            </View>
            <View
              ref={sheetNode}
              testID="Plan sheet"
              onLayout={event => {
                setSheetTop(event.nativeEvent.layout.y)
              }}
              style={{
                flexDirection: 'row',
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: surface.divider
              }}
            >
              <View
                style={{
                  width: PLAN_SLOT_WIDTH + PLAN_PLAYER_WIDTH,
                  borderRightWidth: 1,
                  borderColor: surface.divider
                }}
              >
                <View
                  style={{
                    height: PLAN_HEADER_HEIGHT,
                    flexDirection: 'row',
                    alignItems: 'center'
                  }}
                >
                  <Text
                    style={{
                      ...header,
                      width: PLAN_SLOT_WIDTH,
                      textAlign: 'center'
                    }}
                  >
                    #
                  </Text>
                  <Text style={{ ...header, paddingLeft: 6 }}>
                    {lstrings.plan_player_header.toUpperCase()}
                  </Text>
                </View>
                {aligned.rows.map((row, index) => {
                  const batter = batters[index]
                  const active = picking?.row === index
                  return (
                    <View
                      key={batter.id}
                      style={{
                        ...rule,
                        height: PLAN_ROW_HEIGHT,
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: active ? surface.idle : undefined
                      }}
                    >
                      <Text
                        style={{
                          width: PLAN_SLOT_WIDTH,
                          textAlign: 'center',
                          color: active ? surface.accent : surface.mutedText,
                          fontFamily: theme.regularTextFont,
                          fontSize: 14
                        }}
                      >
                        {index + 1}
                      </Text>
                      {/* A fixed height, so a lifted card's closing slot
                          never pulls the rows under it out of line with
                          their innings. */}
                      <View
                        style={{ flex: 1, height: PLAN_ROW_HEIGHT - 1 }}
                        {...(web
                          ? {}
                          : {
                              // Its touches are the row's: the sheet holds
                              // still under a finger on a player.
                              onTouchStart: () => {
                                setTouching(true)
                              },
                              onTouchEnd: () => {
                                setTouching(false)
                              },
                              onTouchCancel: () => {
                                setTouching(false)
                              }
                            })}
                      >
                        <RosterDrag
                          playerId={batter.id}
                          targetId={`plan-${index}`}
                          insertion={locked ? undefined : 'row'}
                          fixed
                          immediate
                          immediateMouseDrag
                          label={`Reorder ${row.player.fullName}`}
                          onDropPlayer={(player, edge) => {
                            onDrop(player, index, edge)
                          }}
                          onReorder={delta => {
                            onReorder(batter.id, delta)
                          }}
                        >
                          <View
                            testID={`Plan player ${index + 1}`}
                            style={{
                              height: PLAN_ROW_HEIGHT - 1,
                              justifyContent: 'center',
                              paddingLeft: 6,
                              paddingRight: 4,
                              borderRadius: 6,
                              backgroundColor:
                                lifted === batter.id
                                  ? surface.active
                                  : undefined
                            }}
                          >
                            <Text
                              selectable={false}
                              numberOfLines={1}
                              style={{
                                color: surface.text,
                                fontFamily: theme.regularTextFont,
                                fontSize: 15
                              }}
                            >
                              {planBatterLabel(batter)}
                            </Text>
                          </View>
                        </RosterDrag>
                      </View>
                    </View>
                  )
                })}
              </View>
              <ScrollView
                horizontal
                testID="Plan innings"
                scrollEnabled={drag == null}
                // No scrollbar track under the dark grid on the web: the sheet
                // still scrolls by wheel, trackpad and finger.
                showsHorizontalScrollIndicator={false}
                style={{ flex: 1 }}
                // The rows' rules run to the sheet's edge past the last inning.
                contentContainerStyle={{ flexGrow: 1 }}
              >
                <View style={{ flexGrow: 1 }}>
                  <View
                    style={{ height: PLAN_HEADER_HEIGHT, flexDirection: 'row' }}
                  >
                    {innings.map(inning => {
                      const active = picking?.inning === inning - 1
                      // An added inning's number is red, and deletes it.
                      const added = inning > DEFAULT_PLAN_INNINGS
                      const number = (
                        <Text
                          selectable={false}
                          style={{
                            ...header,
                            fontSize: 13,
                            color: added
                              ? theme.scoringOutColor
                              : active
                                ? surface.accent
                                : surface.mutedText
                          }}
                        >
                          {inning}
                        </Text>
                      )
                      const style = {
                        width: PLAN_COLUMN_WIDTH,
                        height: PLAN_HEADER_HEIGHT,
                        alignItems: 'center' as const,
                        justifyContent: 'center' as const,
                        borderBottomWidth: 2,
                        borderColor: active ? surface.accent : 'transparent'
                      }
                      return added ? (
                        <Pressable
                          key={inning}
                          testID={`Plan inning ${inning}`}
                          accessibilityRole="button"
                          accessibilityLabel={sprintf(
                            lstrings.plan_delete_inning_label,
                            inning
                          )}
                          onPress={() => {
                            deleteInning(inning)
                          }}
                          style={style}
                        >
                          {number}
                        </Pressable>
                      ) : (
                        <View
                          key={inning}
                          testID={`Plan inning ${inning}`}
                          style={style}
                        >
                          {number}
                        </View>
                      )
                    })}
                    {aligned.innings < MAX_PLAN_INNINGS && (
                      <Pressable
                        testID="Plan add inning"
                        accessibilityRole="button"
                        accessibilityLabel={lstrings.plan_add_inning}
                        hitSlop={8}
                        onPress={() => {
                          emit(addInning(aligned))
                        }}
                        style={{
                          width: PLAN_COLUMN_WIDTH,
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}
                      >
                        <Text
                          selectable={false}
                          style={{
                            color: surface.accent,
                            fontFamily: theme.semiBoldTextFont,
                            fontSize: 20
                          }}
                        >
                          +
                        </Text>
                      </Pressable>
                    )}
                  </View>
                  {aligned.rows.map((row, index) => (
                    <View
                      key={batters[index].id}
                      style={{
                        ...rule,
                        height: PLAN_ROW_HEIGHT,
                        flexDirection: 'row',
                        alignItems: 'center',
                        opacity: lifted === batters[index].id ? 0.35 : 1
                      }}
                    >
                      {row.cells.map((cell, inning) => {
                        const at = { row: index, inning }
                        const selected =
                          picking?.row === index && picking.inning === inning
                        const label = sprintf(
                          lstrings.plan_cell_label,
                          row.player.fullName,
                          inning + 1
                        )
                        const testID = `Plan cell ${index + 1}-${inning + 1}`
                        return (
                          <View
                            key={inning}
                            style={{
                              width: PLAN_COLUMN_WIDTH,
                              height: PLAN_ROW_HEIGHT - 1,
                              borderRightWidth: StyleSheet.hairlineWidth,
                              borderColor: surface.divider
                            }}
                          >
                            {web ? (
                              <WebPlanCell
                                testID={testID}
                                label={label}
                                value={cell}
                                selected={selected}
                                onFocus={() => {
                                  setPicking(at)
                                }}
                                onBlur={closeUnlessFocused}
                                onCommit={value => {
                                  setCell(at, value)
                                  // Typed whole, the picture has done its
                                  // part, and no longer covers the cells
                                  // under it.
                                  setPicking(undefined)
                                }}
                                onRefuse={text => {
                                  setRefusal(
                                    sprintf(lstrings.plan_refused, text)
                                  )
                                }}
                                onEscape={() => {
                                  setPicking(undefined)
                                }}
                              />
                            ) : (
                              <NativePlanCell
                                testID={testID}
                                label={label}
                                value={cell}
                                selected={selected}
                                onPress={() => {
                                  setPicking(at)
                                }}
                                onLongPress={event => {
                                  setPicking(at)
                                  const start = startAssignDrag(
                                    at,
                                    pointOf(event)
                                  )
                                  dragging.current = start
                                  rootOwns.current = false
                                  setDrag(start)
                                }}
                                onPressOut={() => {
                                  // A hold let go where it was, with no move the
                                  // root took: the picker stays open for a tap.
                                  setTimeout(() => {
                                    if (
                                      !rootOwns.current &&
                                      dragging.current != null
                                    )
                                      endDrag()
                                  }, 0)
                                }}
                              />
                            )}
                          </View>
                        )
                      })}
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
            <PlanWarnings warnings={warnings} rules={context.rules != null} />
            {/* Said to a screen reader when a cell refuses what was typed. */}
            <Text
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              testID="Plan refusal"
              style={{
                position: 'absolute',
                width: 1,
                height: 1,
                overflow: 'hidden',
                opacity: 0
              }}
            >
              {refusal}
            </Text>
          </ScrollView>
        </RosterClipContext.Provider>
      </View>
      {/* On a phone, a tap anywhere outside the picker closes it, changing
          nothing; the web closes it on a click outside (above). */}
      {picking != null && chosen != null && !web && (
        <Pressable
          testID="Plan picker backdrop"
          accessibilityLabel={lstrings.plan_close_picker}
          onPress={() => {
            setPicking(undefined)
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 19
          }}
        />
      )}
      {picking != null && chosen != null && (
        <View
          ref={pickerNode}
          style={{
            position: 'absolute',
            top: pickerTop,
            left: Math.max(0, (area.width - pickerWidth) / 2),
            zIndex: 20
          }}
        >
          <PlanFieldPicker
            // Measured afresh for each cell: the card moves with its row.
            key={`${picking.row}-${picking.inning}`}
            title={sprintf(
              lstrings.plan_assign_title,
              planBatterLabel(batters[picking.row]),
              picking.inning + 1
            )}
            value={chosen.cells[picking.inning]}
            over={drag?.over}
            width={pickerWidth}
            onTargets={found => {
              targets.current = found
            }}
            measureRef={measureTargets}
            onPick={value => {
              pick(picking, value)
              setPicking(undefined)
            }}
            onClose={() => {
              setPicking(undefined)
            }}
            onHold={holdTarget}
            onHoldEnd={releaseTarget}
          />
        </View>
      )}
      {confirming.sheet}
      {helping && (
        <HelpSheet
          text={lstrings.plan_help}
          onClose={() => {
            setHelping(false)
          }}
        />
      )}
    </View>
  )
}
