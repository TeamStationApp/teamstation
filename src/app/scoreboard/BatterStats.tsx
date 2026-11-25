import React, { useEffect, useReducer } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import {
  EXIT_WIPE_MS,
  type ExitReading,
  exitReturnAt
} from '../../common/scoreboard'
import type { BoardClock } from './boardClock'
import { scoreboardTheme as theme } from './scoreboardTheme'

/** 0 is stats, 1 is exit speed. The return runs from 2 to 3. */
function wipeAt(reading: ExitReading | undefined, time: number | null): number {
  if (reading == null || time == null || time < reading.startedAt) return 0
  const elapsed = time - reading.startedAt
  if (elapsed < EXIT_WIPE_MS) return elapsed / EXIT_WIPE_MS
  const returning = time - exitReturnAt(reading)
  if (returning < 0) return 1
  return returning < EXIT_WIPE_MS ? 2 + returning / EXIT_WIPE_MS : 0
}

const width = theme.rem(9.5)
const styles = StyleSheet.create({
  stage: { width, overflow: 'hidden' },
  measure: { opacity: 0 },
  caption: { position: 'absolute', top: 0, width },
  text: {
    width,
    fontSize: theme.rem(1.25),
    fontFamily: theme.secondaryTextFont,
    fontWeight: 'bold',
    color: theme.primaryTextColor,
    textAlign: 'right'
  },
  exit: { color: '#FFD34D' },
  mask: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden' }
})

export function BatterStats(props: {
  line: string
  reading?: ExitReading
  clock?: BoardClock
}): React.ReactElement {
  const { clock, line, reading } = props
  const [, redraw] = useReducer((frame: number) => frame + 1, 0)
  const phase = wipeAt(reading, clock?.now() ?? null)
  useEffect(() => {
    if (reading == null || clock == null) return
    let last = phase
    const tick = (): void => {
      const next = wipeAt(reading, clock.now())
      if (next !== last) {
        last = next
        redraw()
      }
    }
    const unsubscribe = clock.subscribe(tick)
    tick()
    return unsubscribe
    // The subscription tracks sampled phase itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, reading])

  const returning = phase >= 2
  const edge = width * (returning ? phase - 2 : phase)
  const layer = (
    exit: boolean,
    left: number,
    size: number
  ): React.ReactElement => (
    <View style={[styles.mask, { left, width: size }]}>
      <View style={[styles.caption, { left: -left }]}>
        <Text
          allowFontScaling={false}
          numberOfLines={1}
          dataSet={{ scoreboard: exit ? 'exitSpeed' : 'batterLine' }}
          testID={exit ? 'exit-speed' : undefined}
          style={[styles.text, exit && styles.exit]}
        >
          {exit ? `Exit: ${reading?.mph} MPH` : line}
        </Text>
      </View>
    </View>
  )
  return (
    <View
      testID="batter-stats"
      dataSet={{ scoreboard: 'batterStats' }}
      style={styles.stage}
    >
      <Text
        aria-hidden
        allowFontScaling={false}
        style={[styles.text, styles.measure]}
      >
        {'\u00a0'}
      </Text>
      {phase === 0 ? (
        layer(false, 0, width)
      ) : (
        <>
          {layer(!returning, 0, edge)}
          {layer(returning, edge, width - edge)}
        </>
      )}
    </View>
  )
}
