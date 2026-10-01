import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'

import { applyOverrides } from '../../common/scoreboard'
import { useHeaderSlot } from '../components/headerSlot'
import { lstrings, sprintf } from '../locales/strings'
import { routePath } from '../navigation/routes'
import { cacheStyles } from '../theme/ThemeContext'
import { type DashboardTheme, dashboardTheme } from './dashboardTheme'
import {
  acceptServerOverrides,
  type BaseName,
  type CountRow,
  isOverridden,
  type OverrideAction,
  type OverrideModel,
  overrideReducer,
  overridesKey,
  type Side
} from './overrideModel'
import {
  connectDashboard,
  type DashboardClient
} from './scoreboardDashboardClient'
import { ScoreboardNotFound } from './ScoreboardNotFound'
import { type PageOrigin, socketUrlFor } from './scoreboardRoute'
import type { Schedule, SocketConstructor } from './scoreboardSocket'

export interface ScoreboardOverrideScreenProps {
  apiBaseUrl: string
  gameId: string
  /** Signed out: go through sign-in and come back to `next`. */
  onSignIn: (next: string) => void
  /** Where the page was loaded from, for a relative API base. */
  origin?: PageOrigin
  /**
   * The session, on a phone. The dashboard's socket needs the person running
   * the game, and a phone proves who that is with this rather than a cookie.
   */
  token?: string
  /** A test's socket and clock; the browser's otherwise. */
  WebSocketImpl?: SocketConstructor
  schedule?: Schedule
}

/** The page's own origin, where there is a page. */
function pageOrigin(): PageOrigin | undefined {
  // Through `globalThis`, because a phone has no `window.location` and the
  // native build's types have no DOM to name it with.
  const location = (globalThis as { window?: { location?: PageOrigin } }).window
    ?.location
  return location == null
    ? undefined
    : { protocol: location.protocol, host: location.host }
}

/** Where a long press landed, on the page. */
interface PagePoint {
  x: number
  y: number
}
function pagePoint(event: GestureResponderEvent): PagePoint {
  return { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }
}

/**
 * The override dashboard: 1.0's `src/client/Dashboard.tsx`, its layout,
 * styles and gestures, on the 2.0 dashboard socket.
 *
 * It draws in 1.0's dark GameStation colours (`dashboardTheme.ts`) whatever
 * the app's theme is. Five groups — the team names, the score, the inning,
 * the bases and the count — each turn the override colour while overridden.
 * Tapping a score or the inning number adds one, and a long press opens the
 * number picker where it was pressed. The arrows pick the half, a tapped
 * base flips, B, S and O add one up to 3, 2 and 2, and C clears the row.
 * Each ✕ turns its group off. Reset Game State turns every group off and has
 * the server drop GS Watcher's stored state, so the board falls back to the
 * game's own scoring.
 *
 * What the server works out on its own stays in sight: each count circle
 * and base draws it as an inner circle or diamond, darkened while the group
 * is overridden, and the team names, scores and inning show it small in the
 * corner of their fields.
 *
 * It opens the dashboard socket straight away and shows a spinner until the
 * first state. A socket that fails is tried again every 3 s. A game that has
 * closed, or that this account does not run, shows the branded 404; a
 * signed-out visitor is sent to sign in and brought back here.
 */
export function ScoreboardOverrideScreen(
  props: ScoreboardOverrideScreenProps
): React.ReactElement {
  const { apiBaseUrl, gameId, token, WebSocketImpl, schedule } = props
  const theme = dashboardTheme
  const styles = getStyles(theme)
  const { headerHeight } = useHeaderSlot()
  const window = useWindowDimensions()
  const [model, setModel] = useState<OverrideModel | undefined>(undefined)
  const [refused, setRefused] = useState(false)

  // Number picker state
  const [showScorePicker, setShowScorePicker] = useState<
    Side | 'inning' | null
  >(null)
  const [pickerPosition, setPickerPosition] = useState<PagePoint>({
    x: 0,
    y: 0
  })
  const pickerScrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null)

  const client = useRef<DashboardClient | undefined>(undefined)
  const pending = useRef<string[]>([])
  const onSignIn = useRef(props.onSignIn)
  onSignIn.current = props.onSignIn
  const origin = props.origin ?? pageOrigin()
  const protocol = origin?.protocol
  const host = origin?.host

  useEffect(() => {
    pending.current = []
    const dashboard = connectDashboard({
      url: socketUrlFor(
        protocol == null || host == null ? undefined : { protocol, host },
        apiBaseUrl,
        gameId,
        'dashboard'
      ),
      token,
      onState: state => {
        const { pending: left, adopt } = acceptServerOverrides(
          pending.current,
          state.overrides
        )
        pending.current = left
        setModel(current => ({
          automated: state.automated,
          overrides:
            adopt || current == null ? state.overrides : current.overrides
        }))
      },
      onError: () => {
        // What was refused will never come back, so stop waiting for it.
        pending.current = []
      },
      onStop: code => {
        if (code === 4401) {
          onSignIn.current(routePath({ name: 'scoreboardOverride', gameId }))
          return
        }
        setRefused(true)
      },
      WebSocketImpl,
      schedule
    })
    client.current = dashboard
    return () => {
      dashboard.close()
      client.current = undefined
    }
  }, [apiBaseUrl, gameId, protocol, host, token, WebSocketImpl, schedule])

  if (refused) return <ScoreboardNotFound />

  const page = (children: React.ReactNode): React.ReactElement => (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ paddingTop: headerHeight }}
      keyboardShouldPersistTaps="handled"
    >
      <View testID="override-dashboard" style={styles.dashboardContainer}>
        {children}
      </View>
    </ScrollView>
  )

  if (model == null) {
    return page(
      <View style={styles.loading}>
        <ActivityIndicator color={theme.primaryTextColor} />
        <Text accessibilityLiveRegion="polite" style={styles.loadingText}>
          {lstrings.override_loading}
        </Text>
      </View>
    )
  }

  const dispatch = (action: OverrideAction): void => {
    const next = overrideReducer(model, action)
    setModel(next)
    pending.current.push(overridesKey(next.overrides))
    client.current?.send(
      action.type === 'reset'
        ? { type: 'reset' }
        : { type: 'overrides', data: next.overrides }
    )
  }
  const { automated, overrides } = model
  const shown = applyOverrides(automated, overrides)
  const overrideEnabled = isOverridden(overrides, 'count')
  const overrideBasesEnabled = isOverridden(overrides, 'bases')
  const overrideTeamEnabled = isOverridden(overrides, 'team')
  const overrideScoreEnabled = isOverridden(overrides, 'score')
  const overrideInningEnabled = isOverridden(overrides, 'inning')

  const handleInningNumberLongPress = (event: GestureResponderEvent): void => {
    setPickerPosition(pagePoint(event))
    setShowScorePicker('inning')
  }

  // Number picker component
  const renderNumberPicker = (): React.ReactNode => {
    if (showScorePicker == null) return null
    const picking = showScorePicker

    const handleScoreSelect = (value: number): void => {
      setShowScorePicker(null)
      dispatch(
        picking === 'inning'
          ? { type: 'setInning', inning: value }
          : { type: 'setScore', side: picking, score: value }
      )
    }

    // An inning starts at 1; a score at 0.
    const first = picking === 'inning' ? 1 : 0
    const numbers = Array.from({ length: 21 - first }, (_, i) => i + first)
    const currentScore =
      picking === 'home'
        ? shown.homeScore
        : picking === 'away'
          ? shown.awayScore
          : shown.inning
    const centerIndex = numbers.indexOf(currentScore)

    // Calculate item height: paddingVertical (8*2=16) + fontSize (approx 32) = ~48px
    const itemHeight = 48
    // Offset so current value appears at tap position
    const idealTopOffset = pickerPosition.y - centerIndex * itemHeight - 24
    // Constrain to viewport bounds (min 20px from top, ensure picker container fits)
    const topOffset = Math.max(
      20,
      Math.min(idealTopOffset, window.height - 270)
    )

    // Calculate how much we need to scroll the picker container
    const scrollOffset = Math.max(0, centerIndex * itemHeight - 100)

    return (
      <Modal
        transparent
        visible
        animationType="none"
        onRequestClose={() => {
          setShowScorePicker(null)
        }}
      >
        {/*
          No button role here or on a score, as in 1.0: each holds buttons of
          its own, and react-native-web draws a button role as a <button>,
          which may not contain another.
        */}
        <Pressable
          accessibilityLabel={lstrings.override_close_picker}
          style={styles.pickerOverlay}
          onPress={() => {
            setShowScorePicker(null)
          }}
        >
          <ScrollView
            ref={pickerScrollRef}
            testID="override-picker"
            style={[
              styles.pickerContainer,
              { left: pickerPosition.x - 50, top: topOffset }
            ]}
            onLayout={() => {
              // Scroll to show current value after layout
              pickerScrollRef.current?.scrollTo({
                y: scrollOffset,
                animated: false
              })
            }}
          >
            {numbers.map((num, index) => {
              const distance = Math.abs(index - centerIndex)
              const opacity = Math.max(0.3, 1 - distance * 0.2)
              const fontSize = distance === 0 ? 32 : 24
              const fontWeight = distance === 0 ? '700' : '400'

              return (
                <Pressable
                  key={num}
                  accessibilityRole="button"
                  accessibilityLabel={sprintf(lstrings.override_pick, num)}
                  style={[
                    styles.pickerItem,
                    distance === 0 && styles.pickerItemSelected
                  ]}
                  onPress={() => {
                    handleScoreSelect(num)
                  }}
                >
                  <Text
                    style={[
                      styles.pickerItemText,
                      { opacity, fontSize, fontWeight }
                    ]}
                  >
                    {num}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
        </Pressable>
      </Modal>
    )
  }

  // Team score row renderer
  const renderTeamScoreRow = (side: Side): React.ReactNode => {
    const isHome = side === 'home'
    const autoTeam = isHome ? automated.homeTeam : automated.awayTeam
    const autoScore = isHome ? automated.homeScore : automated.awayScore
    const overrideTeam = isHome ? shown.homeTeam : shown.awayTeam
    const overrideScore = isHome ? shown.homeScore : shown.awayScore
    return (
      <View style={styles.teamScoreRow}>
        <View
          testID={`override-tile-team-${side}`}
          style={[
            styles.teamNameContainer,
            overrideTeamEnabled && styles.teamNameContainerActive
          ]}
        >
          <Text
            testID={`automated-team-${side}`}
            style={[
              styles.superscriptInField,
              overrideTeamEnabled && styles.superscriptInFieldActive
            ]}
          >
            {autoTeam}
          </Text>
          <TextInput
            accessibilityLabel={
              isHome ? lstrings.override_home_team : lstrings.override_away_team
            }
            value={overrideTeamEnabled ? overrideTeam : ''}
            onChangeText={name => {
              dispatch({ type: 'setTeam', side, name })
            }}
            style={styles.teamNameInput}
            placeholder={autoTeam}
            placeholderTextColor={theme.dashboardSuperscript}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.override_revert_team}
            style={styles.xButtonInField}
            onPress={() => {
              // Turn off team override for BOTH teams
              dispatch({ type: 'revert', group: 'team' })
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
        </View>
        <Pressable
          testID={`override-tile-score-${side}`}
          accessibilityLabel={
            isHome ? lstrings.override_home_score : lstrings.override_away_score
          }
          style={[
            styles.scoreContainer,
            overrideScoreEnabled && styles.scoreContainerActive
          ]}
          onPress={() => {
            dispatch({ type: 'incrementScore', side })
          }}
          onLongPress={event => {
            setPickerPosition(pagePoint(event))
            setShowScorePicker(side)
          }}
        >
          <Text
            testID={`automated-score-${side}`}
            style={[
              styles.superscriptInField,
              overrideScoreEnabled && styles.superscriptInFieldActive
            ]}
          >
            {autoScore.toString()}
          </Text>
          <Text style={styles.scoreText}>{overrideScore}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.override_revert_score}
            style={styles.xButtonInField}
            onPress={() => {
              // Turn off score override for BOTH teams
              dispatch({ type: 'revert', group: 'score' })
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
        </Pressable>
      </View>
    )
  }

  const getInnerDiamondStyle = (
    overrideEnabled: boolean,
    autoBase: boolean
  ): object => {
    if (!overrideEnabled) {
      return {}
    }
    if (autoBase) {
      return styles.innerDiamondDarkened
    } else {
      return styles.innerDiamondDisabled
    }
  }

  const renderBase = (base: BaseName, label: string): React.ReactNode => {
    const autoBase = automated[base]
    const overrideBase = shown[base]
    return (
      <View style={styles.diamondWrapper}>
        <Pressable
          testID={`base-${base}`}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ checked: overrideBase }}
          style={[
            styles.diamond,
            overrideBasesEnabled && overrideBase ? styles.diamondFilled : {}
          ]}
          onPress={() => {
            dispatch({ type: 'toggleBase', base })
          }}
        />
        {(autoBase || (overrideBasesEnabled && autoBase !== overrideBase)) && (
          <View
            testID={`inner-${base}`}
            style={[
              styles.innerDiamond,
              getInnerDiamondStyle(overrideBasesEnabled, autoBase),
              styles.innerDiamondNonInteractive
            ]}
          />
        )}
      </View>
    )
  }

  const renderCountRow = (
    row: CountRow,
    label: string,
    maxCount: number,
    circleColor: string,
    addLabel: string,
    clearLabel: string
  ): React.ReactNode => {
    const count = shown[row]
    const autoCount = automated[row]
    return (
      <View style={styles.countRow}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={addLabel}
          style={styles.circleContainer}
          onPress={() => {
            dispatch({ type: 'incrementCount', row })
          }}
        >
          <View style={styles.circlesGroup}>
            {Array.from({ length: maxCount }).map((_, index) => {
              const outerColor = overrideEnabled
                ? index < count
                  ? circleColor
                  : '#4a4a4a'
                : '#555'
              const innerColor = getInnerColor(
                circleColor,
                index,
                autoCount,
                overrideEnabled
              )
              return (
                <View key={index} style={styles.circleWrapper}>
                  <View
                    testID={`count-${row}-${index}`}
                    style={[styles.circle, { backgroundColor: outerColor }]}
                  />
                  <View
                    testID={`inner-${row}-${index}`}
                    style={[
                      styles.innerCircle,
                      { backgroundColor: innerColor }
                    ]}
                  />
                </View>
              )
            })}
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          style={styles.clearButton}
          onPress={() => {
            dispatch({ type: 'clearCount', row })
          }}
        >
          <Text style={styles.clearButtonText}>C</Text>
        </Pressable>
      </View>
    )
  }

  const arrowUp = (active: boolean): object =>
    active ? styles.arrowOuterActiveUp : styles.arrowOuterInactiveUp
  const arrowUpInner = (active: boolean): object =>
    active ? styles.arrowInnerActiveUp : styles.arrowInnerInactiveUp
  const arrowDown = (active: boolean): object =>
    active ? styles.arrowOuterActiveDown : styles.arrowOuterInactiveDown
  const arrowDownInner = (active: boolean): object =>
    active ? styles.arrowInnerActiveDown : styles.arrowInnerInactiveDown

  return page(
    <>
      {renderNumberPicker()}
      <View style={styles.teamScoreCard}>
        {renderTeamScoreRow('away')}
        {renderTeamScoreRow('home')}
      </View>
      <View style={styles.cardsRow}>
        {/* Inning Card */}
        <View
          testID="override-tile-inning"
          style={[
            styles.inningCard,
            overrideInningEnabled && styles.inningCardActive
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.override_revert_inning}
            style={styles.xButtonInningCard}
            onPress={() => {
              dispatch({ type: 'revert', group: 'inning' })
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
          {/* Mini auto inning display */}
          <View
            testID="automated-inning"
            style={[
              styles.miniInningContainer,
              overrideInningEnabled && styles.miniInningContainerActive
            ]}
          >
            <View style={styles.miniArrowsOutsColumn}>
              <View
                style={[
                  styles.miniArrowOuterUp,
                  arrowUp(automated.half === 'top')
                ]}
              >
                <View
                  style={[
                    styles.miniArrowInnerUp,
                    arrowUpInner(automated.half === 'top')
                  ]}
                />
              </View>
              <Text style={styles.miniInningCount}>{automated.inning}</Text>
              <View
                style={[
                  styles.miniArrowOuterDown,
                  arrowDown(automated.half === 'bottom')
                ]}
              >
                <View
                  style={[
                    styles.miniArrowInnerDown,
                    arrowDownInner(automated.half === 'bottom')
                  ]}
                />
              </View>
            </View>
          </View>
          <View style={styles.arrowsOutsColumn}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.override_top}
              onPress={() => {
                dispatch({ type: 'toggleHalf', half: 'top' })
              }}
            >
              <View
                testID="override-arrow-top"
                style={[styles.arrowOuterUp, arrowUp(shown.half === 'top')]}
              >
                <View
                  style={[
                    styles.arrowInnerUp,
                    arrowUpInner(shown.half === 'top')
                  ]}
                />
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.override_inning}
              onPress={() => {
                dispatch({ type: 'incrementInning' })
              }}
              onLongPress={handleInningNumberLongPress}
            >
              <Text style={styles.inningCount}>{shown.inning}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.override_bottom}
              onPress={() => {
                dispatch({ type: 'toggleHalf', half: 'bottom' })
              }}
            >
              <View
                style={[
                  styles.arrowOuterDown,
                  arrowDown(shown.half === 'bottom')
                ]}
              >
                <View
                  style={[
                    styles.arrowInnerDown,
                    arrowDownInner(shown.half === 'bottom')
                  ]}
                />
              </View>
            </Pressable>
          </View>
        </View>
        {/* Bases Card */}
        <View
          testID="override-tile-bases"
          style={[
            styles.basesCard,
            overrideBasesEnabled && styles.basesCardActive
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.override_revert_bases}
            style={styles.xButtonBasesCard}
            onPress={() => {
              dispatch({ type: 'revert', group: 'bases' })
            }}
          >
            <Text style={styles.xButtonText}>✕</Text>
          </Pressable>
          <View style={styles.diamondsContainer}>
            <View style={styles.diamondRow}>
              {renderBase('base2', lstrings.override_second)}
              {renderBase('base1', lstrings.override_first)}
            </View>
            <View style={styles.diamondRowLeftAlign}>
              {renderBase('base3', lstrings.override_third)}
            </View>
          </View>
        </View>
      </View>
      <View
        testID="override-tile-count"
        style={[styles.dashboard, overrideEnabled && styles.dashboardActive]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={lstrings.override_revert_count}
          style={styles.xButtonDashboard}
          onPress={() => {
            dispatch({ type: 'revert', group: 'count' })
          }}
        >
          <Text style={styles.xButtonText}>✕</Text>
        </Pressable>
        {renderCountRow(
          'balls',
          'B',
          3,
          theme.dashboardCircleGreen,
          lstrings.override_add_ball,
          lstrings.override_clear_balls
        )}
        {renderCountRow(
          'strikes',
          'S',
          2,
          theme.dashboardCircleOrange,
          lstrings.override_add_strike,
          lstrings.override_clear_strikes
        )}
        {renderCountRow(
          'outs',
          'O',
          2,
          theme.dashboardCircleRed,
          lstrings.override_add_out,
          lstrings.override_clear_outs
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.override_reset}
        style={styles.resetButton}
        onPress={() => {
          dispatch({ type: 'reset' })
        }}
      >
        <Text style={styles.resetButtonText}>{lstrings.override_reset}</Text>
      </Pressable>
    </>
  )
}

/**
 * The inner circle: the server's count, darkened while the count is
 * overridden, and an empty socket past it. 1.0's `getInnerColor`.
 */
export function getInnerColor(
  circleColor: string,
  index: number,
  autoCount: number,
  overrideEnabled: boolean
): string {
  if (index >= autoCount) return '#2a2a2a'

  if (overrideEnabled) {
    // Darken the color significantly by multiplying by 0.7
    const hex = circleColor.replace('#', '')
    const num = parseInt(hex, 16)
    const r = Math.floor(((num >> 16) & 0xff) * 0.7)
    const g = Math.floor(((num >> 8) & 0xff) * 0.7)
    const b = Math.floor((num & 0xff) * 0.7)
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
  }

  return circleColor
}

const getStyles = cacheStyles((theme: DashboardTheme) => ({
  page: {
    flex: 1,
    backgroundColor: theme.backgroundColor
  },
  loading: {
    width: '100%',
    maxWidth: 600,
    alignItems: 'center',
    gap: theme.rem(1),
    paddingVertical: theme.rem(3)
  },
  loadingText: {
    color: theme.primaryTextColor,
    fontFamily: theme.secondaryTextFont,
    fontSize: theme.rem(0.875)
  },
  dashboardContainer: {
    display: 'flex',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    minHeight: 1000,
    backgroundColor: theme.backgroundColor,
    padding: theme.rem(1)
  },
  teamScoreCard: {
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(1.25),
    marginTop: theme.rem(0.5),
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.25),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.3,
    shadowRadius: theme.rem(1.25),
    elevation: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.rem(1),
    width: '100%',
    maxWidth: 600
  },
  teamScoreRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75),
    justifyContent: 'space-between'
  },
  teamNameContainer: {
    flex: 1,
    minHeight: theme.rem(3),
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    paddingRight: theme.rem(3),
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.5),
    position: 'relative',
    marginRight: theme.rem(0.75)
  },
  teamNameContainerActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  teamNameInput: {
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor,
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderWidth: 0,
    width: '100%',
    paddingLeft: 0,
    transform: [{ translateY: theme.rem(0.5) }]
  },
  scoreContainer: {
    minWidth: theme.rem(6.25),
    minHeight: theme.rem(3),
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.rem(0.5),
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    paddingRight: theme.rem(3),
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(0.5),
    position: 'relative',
    flexShrink: 0
  },
  scoreContainerActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  scoreText: {
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor
  },
  superscriptInField: {
    fontSize: theme.rem(0.75),
    fontWeight: '400',
    color: theme.dashboardSuperscript,
    position: 'absolute',
    top: theme.rem(0.5),
    left: theme.rem(0.75),
    zIndex: 1
  },
  superscriptInFieldActive: {
    color: theme.primaryTextColor
  },
  xButtonInField: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: '50%',
    marginTop: theme.rem(-1)
  },
  xButtonText: {
    fontSize: theme.rem(1),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor
  },
  pickerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.overlayBackgroundColor,
    zIndex: 1000,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  pickerContainer: {
    position: 'absolute',
    width: theme.rem(6.25),
    maxHeight: theme.rem(15.75),
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(0.75),
    padding: theme.rem(0.5),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.5,
    shadowRadius: theme.rem(1.25),
    overflow: 'scroll'
  },
  pickerItem: {
    paddingVertical: theme.rem(0.5),
    paddingHorizontal: theme.rem(0.75),
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  pickerItemSelected: {
    backgroundColor: theme.secondaryButtonColor,
    borderRadius: theme.rem(0.5)
  },
  pickerItemText: {
    color: theme.primaryTextColor,
    fontFamily: theme.secondaryTextFont,
    textAlign: 'center'
  },
  dashboard: {
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(1.25),
    marginTop: theme.rem(1),
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.25),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.3,
    shadowRadius: theme.rem(1.25),
    elevation: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.rem(0.5),
    width: '100%',
    maxWidth: 600,
    position: 'relative'
  },
  dashboardActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  xButtonDashboard: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: theme.rem(0.5),
    zIndex: 10
  },
  countRow: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 0,
    paddingLeft: theme.rem(0.5),
    paddingRight: theme.rem(1.75),
    justifyContent: 'space-between'
  },
  rowLabel: {
    fontSize: theme.rem(2.25),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.primaryTextColor,
    minWidth: theme.rem(3),
    flexShrink: 0
  },
  circleContainer: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center'
  },
  circlesGroup: {
    display: 'flex',
    flexDirection: 'row',
    gap: theme.rem(0.75),
    justifyContent: 'flex-start'
  },
  circleWrapper: {
    position: 'relative',
    width: theme.rem(3),
    height: theme.rem(3),
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  circle: {
    position: 'absolute',
    width: theme.rem(3),
    height: theme.rem(3),
    borderRadius: theme.rem(1.5),
    borderWidth: 2,
    borderColor: theme.dashboardOutlineGray
  },
  innerCircle: {
    position: 'absolute',
    width: theme.rem(1.5),
    height: theme.rem(1.5),
    borderRadius: theme.rem(0.75),
    borderWidth: 0
  },
  clearButton: {
    width: theme.rem(3.25),
    height: theme.rem(3.25),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.clearButtonColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: theme.rem(0.5),
    flexShrink: 0
  },
  clearButtonText: {
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.scoreboardScoreText
  },
  cardsRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: theme.rem(1),
    width: '100%',
    maxWidth: 600,
    marginTop: theme.rem(1)
  },
  inningCard: {
    flex: 1,
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.25),
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(0.75),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  inningCardActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  xButtonInningCard: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: theme.rem(0.5),
    zIndex: 10
  },
  basesCard: {
    flex: 2,
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.25),
    backgroundColor: theme.cardBackgroundDark,
    borderRadius: theme.rem(0.75),
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.rem(0.75),
    position: 'relative'
  },
  basesCardActive: {
    backgroundColor: theme.dashboardOverrideBackground
  },
  xButtonBasesCard: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.buttonGrayColor,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'absolute',
    right: theme.rem(0.5),
    top: theme.rem(0.5),
    zIndex: 10
  },
  diamondsContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    marginTop: theme.rem(1.5),
    gap: theme.rem(0.5),
    transform: [{ rotate: '45deg' }]
  },
  diamondRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: theme.rem(0.5),
    justifyContent: 'flex-start'
  },
  diamondRowLeftAlign: {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'flex-start'
  },
  diamondWrapper: {
    position: 'relative',
    width: theme.rem(4),
    height: theme.rem(4),
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center'
  },
  diamond: {
    position: 'absolute',
    width: theme.rem(3),
    height: theme.rem(3),
    backgroundColor: 'transparent',
    borderWidth: 3,
    borderColor: theme.buttonGrayColor
  },
  diamondFilled: {
    backgroundColor: theme.activeColor,
    borderColor: theme.activeColor
  },
  innerDiamond: {
    position: 'absolute',
    width: theme.rem(1.25),
    height: theme.rem(1.25),
    backgroundColor: theme.activeColor
  },
  innerDiamondDarkened: {
    backgroundColor: theme.dashboardDarkBaseRed
  },
  innerDiamondDisabled: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  innerDiamondNonInteractive: {
    pointerEvents: 'none'
  },
  // Inning card styles (from Scoreboard)
  arrowsOutsColumn: {
    alignItems: 'center'
  },
  inningCount: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(3),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    marginVertical: theme.rem(0.5)
  },
  arrowOuterUp: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderBottomWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: theme.rem(0.5)
  },
  arrowInnerUp: {
    position: 'absolute',
    top: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderBottomWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  arrowOuterActiveUp: {
    borderBottomColor: theme.activeColor
  },
  arrowOuterInactiveUp: {
    borderBottomColor: theme.dashboardOutlineGray
  },
  arrowInnerActiveUp: {
    borderBottomColor: theme.activeColor
  },
  arrowInnerInactiveUp: {
    borderBottomColor: theme.dashboardBaseFill
  },
  arrowOuterDown: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderTopWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: theme.rem(0.5)
  },
  arrowInnerDown: {
    position: 'absolute',
    bottom: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderTopWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  arrowOuterActiveDown: {
    borderTopColor: theme.activeColor
  },
  arrowOuterInactiveDown: {
    borderTopColor: theme.dashboardOutlineGray
  },
  arrowInnerActiveDown: {
    borderTopColor: theme.activeColor
  },
  arrowInnerInactiveDown: {
    borderTopColor: theme.dashboardBaseFill
  },
  // Mini inning display (15% scale)
  miniInningContainer: {
    position: 'absolute',
    top: theme.rem(0.5),
    left: theme.rem(0.5),
    transform: [{ scale: 0.4 }],
    transformOrigin: 'top left',
    opacity: 0.6
  },
  miniInningContainerActive: {
    opacity: 1
  },
  miniArrowsOutsColumn: {
    alignItems: 'center'
  },
  miniInningCount: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(3),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    marginVertical: theme.rem(0.5)
  },
  miniArrowOuterUp: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderBottomWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: theme.rem(0.5)
  },
  miniArrowInnerUp: {
    position: 'absolute',
    top: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderBottomWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  miniArrowOuterDown: {
    position: 'relative',
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1.25),
    borderRightWidth: theme.rem(1.25),
    borderTopWidth: theme.rem(1.75),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginTop: theme.rem(0.5)
  },
  miniArrowInnerDown: {
    position: 'absolute',
    bottom: theme.rem(0.21875),
    left: theme.rem(-1),
    width: 0,
    height: 0,
    borderLeftWidth: theme.rem(1),
    borderRightWidth: theme.rem(1),
    borderTopWidth: theme.rem(1.375),
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  resetButton: {
    width: '100%',
    maxWidth: 600,
    marginTop: theme.rem(1),
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.25),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.dashboardCircleOrange,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    shadowOpacity: 0.3,
    shadowRadius: theme.rem(1.25),
    elevation: 8
  },
  resetButtonText: {
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    fontFamily: theme.secondaryTextFont,
    color: theme.scoreboardScoreText
  }
}))
