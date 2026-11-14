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
  planCellEntry,
  planCellOf,
  planHasPositions,
  removeInning
} from '../../../common/gamePlan'
import { type PlanSameDay, planWarnings } from '../../../common/planWarnings'
import type { PlayingTimeRules } from '../../../common/playingTimeRules'
import { ButtonIcon } from '../../components/ButtonIcon'
import { TickerText } from '../../components/TickerText'
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
import { NativePlanCell, PLAN_REFUSAL_MS, WebPlanCell } from './PlanCell'
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
 * What the plan's warnings are judged by: the rules and the day's other
 * games from `GET /games/:gameId/plans`, and from the game the screen
 * holds, whether it is final and the innings it reached.
 */
export interface PlanContext {
  rules: PlayingTimeRules | null
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
 * How soon after the press that closed the web's picker its click comes, at
 * most, to be taken as that press's and stopped.
 */
const PLAN_CLOSING_CLICK_MS = 1000

/** The rows and innings each arrow key moves the web's highlight by. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1]
}

/**
 * The cell an arrow key highlights: the next one its way, held at the
 * sheet's edges, or the first cell when none is highlighted yet.
 */
function steppedCell(
  at: PlanCellAddress | undefined,
  [rows, innings]: readonly [number, number],
  plan: Pick<GamePlan, 'innings' | 'rows'>
): PlanCellAddress {
  if (at == null) return { row: 0, inning: 0 }
  const held = (value: number, count: number): number =>
    Math.max(0, Math.min(count - 1, value))
  return {
    row: held(at.row + rows, plan.rows.length),
    inning: held(at.inning + innings, plan.innings)
  }
}

/** Whether a DOM node holds another (or is it), for the web's focus. */
const holds = (node: unknown, other: EventTarget | null): boolean =>
  other != null &&
  (node as { contains?: (other: Node) => boolean } | null)?.contains?.(
    other as Node
  ) === true

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

  // The web's spreadsheet. A click highlights a cell and opens the picker
  // for it, and the grid, which takes the focus, reads the keys, the copy
  // and the paste for that cell: no text field is focused, and no text is
  // selected. A position's first key writes it at once (C waits for an F,
  // which makes CF); Delete benches; the arrows move the highlight.
  const tab = useRef<React.ComponentRef<typeof View>>(null)
  const grid = useRef<React.ComponentRef<typeof View>>(null)
  const pickerNode = useRef<React.ComponentRef<typeof View>>(null)
  const [highlight, setHighlight] = useState<PlanCellAddress>()
  const [editing, setEditing] = useState('')
  const [refused, setRefused] = useState<PlanCellAddress>()
  useEffect(() => {
    if (refused == null) return
    const timer = setTimeout(() => {
      setRefused(undefined)
    }, PLAN_REFUSAL_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [refused])
  // A cell of a lineup or plan that has since shrunk is highlighted no
  // longer.
  const lit =
    highlight != null &&
    highlight.row < aligned.rows.length &&
    highlight.inning < aligned.innings
      ? highlight
      : undefined
  const focusGrid = (): void => {
    ;(grid.current as unknown as HTMLElement | null)?.focus()
  }
  const refuse = (at: PlanCellAddress, text: string): void => {
    setRefused({ ...at })
    setRefusal(sprintf(lstrings.plan_refused, text))
  }
  /** The letter being typed, written as it stands: C is the catcher. */
  const finishEditing = (): void => {
    const cell = planCellOf(editing)
    if (lit != null && editing !== '' && cell != null) setCell(lit, cell)
    setEditing('')
  }
  const highlightCell = (at: PlanCellAddress): void => {
    finishEditing()
    setHighlight(at)
    setPicking(at)
    focusGrid()
  }
  const keyDown = (event: KeyboardEvent): void => {
    if (
      event.target !== grid.current ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return
    const step = ARROWS[event.key]
    if (step != null) {
      event.preventDefault()
      if (aligned.rows.length === 0) return
      finishEditing()
      setPicking(undefined)
      setHighlight(steppedCell(lit, step, aligned))
      return
    }
    if (lit == null) return
    switch (event.key) {
      case 'Escape':
        // A letter being typed is dropped; else the picker closes.
        if (editing !== '') setEditing('')
        else setPicking(undefined)
        return
      case 'Enter':
      case 'Tab':
        if (editing === '') {
          // A Tab with nothing typed leaves the sheet's cells, even for a
          // button inside the grid such as +: nothing stays lit.
          if (event.key === 'Tab') {
            setHighlight(undefined)
            setPicking(undefined)
          }
          return
        }
        // The letter is written and the cell stays highlighted: a Tab that
        // moved the focus on would leave it lit with the keys gone elsewhere.
        event.preventDefault()
        finishEditing()
        return
      case 'Backspace':
      case 'Delete':
        event.preventDefault()
        setEditing('')
        setPicking(undefined)
        setCell(lit, '')
        return
    }
    if (event.key.length !== 1) return
    event.preventDefault()
    const entry = planCellEntry(editing, event.key)
    if ('commit' in entry) {
      setEditing('')
      // Typed whole, the picture has done its part, and no longer covers
      // the cells under it.
      setPicking(undefined)
      setCell(lit, entry.commit)
    } else if ('pending' in entry) {
      setEditing(entry.pending)
      setPicking(undefined)
    } else if (editing !== '')
      refuse(lit, `${editing}${event.key.toUpperCase()}`)
  }
  const copy = (event: ClipboardEvent): void => {
    if (lit == null || event.clipboardData == null) return
    event.clipboardData.setData(
      'text/plain',
      aligned.rows[lit.row].cells[lit.inning]
    )
    event.preventDefault()
  }
  const paste = (event: ClipboardEvent): void => {
    if (lit == null) return
    event.preventDefault()
    const text = (event.clipboardData?.getData('text') ?? '').trim()
    const cell = planCellOf(text)
    setEditing('')
    if (cell == null) refuse(lit, text)
    else {
      setPicking(undefined)
      setCell(lit, cell)
    }
  }
  /** Focus gone from the grid and the picker: nothing is highlighted. */
  const left = (): void => {
    finishEditing()
    setHighlight(undefined)
    setPicking(undefined)
  }
  const keys = useRef({ keyDown, copy, paste, left })
  keys.current = { keyDown, copy, paste, left }
  useEffect(() => {
    const node = grid.current as unknown as HTMLElement | null
    const whole = tab.current as unknown as HTMLElement | null
    if (!web || node?.addEventListener == null || whole == null) return
    const keyDown = (event: KeyboardEvent): void => {
      keys.current.keyDown(event)
    }
    const copy = (event: ClipboardEvent): void => {
      keys.current.copy(event)
    }
    const paste = (event: ClipboardEvent): void => {
      keys.current.paste(event)
    }
    // Chromium aims a copy or a paste made with nothing selected at the
    // page's body, not at the focused grid, so the grid holds a collapsed
    // selection of its own, which draws nothing, while it has the focus.
    const focusIn = (event: FocusEvent): void => {
      if (event.target === node) window.getSelection()?.collapse(node, 0)
    }
    const focusOut = (): void => {
      setTimeout(() => {
        const active = document.activeElement
        if (holds(node, active) || holds(pickerNode.current, active)) return
        keys.current.left()
      }, 0)
    }
    node.addEventListener('keydown', keyDown)
    node.addEventListener('copy', copy)
    node.addEventListener('paste', paste)
    node.addEventListener('focusin', focusIn)
    // From the grid, or from the picker the grid's cell opened.
    whole.addEventListener('focusout', focusOut)
    return () => {
      node.removeEventListener('keydown', keyDown)
      node.removeEventListener('copy', copy)
      node.removeEventListener('paste', paste)
      node.removeEventListener('focusin', focusIn)
      whole.removeEventListener('focusout', focusOut)
    }
  }, [web])

  // A web click anywhere but the picker and the grid closes the picker,
  // changing nothing: the click that follows the press is stopped before
  // what it landed on sees it, as the phone's backdrop takes its tap, so a
  // tab or the Box Score pill under it does not open too.
  const closingClick = useRef<{ target: EventTarget | null; at: number }>(
    undefined
  )
  useEffect(() => {
    if (!web || picking == null) return
    const press = (event: Event): void => {
      if (holds(pickerNode.current, event.target)) return
      if (holds(grid.current, event.target)) return
      // Only a primary press is followed by a click; a right or middle one
      // must not leave a record that stops the next real click.
      if ((event as MouseEvent).button === 0)
        closingClick.current = { target: event.target, at: Date.now() }
      setPicking(undefined)
    }
    document.addEventListener('pointerdown', press, true)
    return () => {
      document.removeEventListener('pointerdown', press, true)
    }
  }, [web, picking])
  // Kept past the picker's closing, which comes before the click.
  useEffect(() => {
    if (!web) return
    const click = (event: Event): void => {
      const closing = closingClick.current
      closingClick.current = undefined
      if (closing === undefined) return
      if (
        closing.target !== event.target ||
        Date.now() - closing.at > PLAN_CLOSING_CLICK_MS
      )
        return
      event.stopPropagation()
      event.preventDefault()
    }
    document.addEventListener('click', click, true)
    return () => {
      document.removeEventListener('click', click, true)
    }
  }, [web])

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
      // The web's keys go back to the highlighted cell, as after a tap.
      if (web) focusGrid()
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
  // The cell the sheet marks: the highlighted one on the web, else the one
  // the picker is open for.
  const marked = web ? lit : picking
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
      ref={tab}
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
                  const active = marked?.row === index
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
                            {/* A name wider than the column pans. */}
                            <TickerText
                              selectable={false}
                              style={{
                                color: surface.text,
                                fontFamily: theme.regularTextFont,
                                fontSize: 15
                              }}
                            >
                              {planBatterLabel(batter)}
                            </TickerText>
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
                <View
                  ref={grid}
                  testID="Plan grid"
                  accessibilityLabel={
                    web ? lstrings.plan_grid_label : undefined
                  }
                  // The web's grid takes the focus, and the keys, for the
                  // highlighted cell; that cell's outline shows it.
                  tabIndex={web ? 0 : undefined}
                  style={{ flexGrow: 1, outlineWidth: 0 }}
                >
                  <View
                    style={{ height: PLAN_HEADER_HEIGHT, flexDirection: 'row' }}
                  >
                    {innings.map(inning => {
                      const active = marked?.inning === inning - 1
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
                        <ButtonIcon name="add">
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
                        </ButtonIcon>
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
                          marked?.row === index && marked.inning === inning
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
                                highlighted={selected}
                                editing={
                                  selected && editing !== ''
                                    ? editing
                                    : undefined
                                }
                                refused={
                                  refused?.row === index &&
                                  refused.inning === inning
                                }
                                onPress={() => {
                                  highlightCell(at)
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
              // The web's keys go back to the highlighted cell.
              if (web) focusGrid()
            }}
            onClose={() => {
              setPicking(undefined)
              if (web) focusGrid()
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
