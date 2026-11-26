import React, { useMemo } from 'react'
import { View } from 'react-native'

import { replayBoxScore } from '../../common/replay/replayBoxScore'
import type { GameState } from '../../common/scoring/state'
import { fieldSafePadding, SCORING_SIDE_WIDTH } from '../field/fieldSafeArea'
import type { ScoringFrame } from '../field/scoringFrame'
import type { Insets } from '../platform/insets'
import { ReplayBoxScore } from '../replay/ReplayBoxScore'
import { scoringSurface } from '../theme/scoringSurface'
import {
  RemoteScoringUpdates,
  type RemoteScoringUpdatesProps
} from './RemoteScoringUpdates'

/** Keep one subscription to remote plays while the field changes layout. */
export function ScoringSidePanel({
  frame,
  insets,
  row,
  updates,
  state
}: {
  frame: ScoringFrame
  insets: Insets
  row: { left: number; right: number }
  updates?: Pick<RemoteScoringUpdatesProps, 'game' | 'userId' | 'obscured'>
  state?: GameState
}): React.ReactElement | null {
  const { side, fieldWidth, logTop, stripTop } = frame
  const box = useMemo(
    () => (side && state != null ? replayBoxScore(state) : undefined),
    [side, state]
  )
  if (!side && updates == null) return null
  const width = side ? SCORING_SIDE_WIDTH : fieldWidth - row.left - row.right
  return (
    <View
      testID={side ? 'scoring-side' : 'scoring-log-band'}
      pointerEvents="box-none"
      collapsable={false}
      style={
        side
          ? {
              position: 'absolute',
              left: fieldWidth,
              top: 0,
              bottom: 0,
              width,
              ...fieldSafePadding(insets),
              paddingLeft: 0,
              backgroundColor: scoringSurface.canvas
            }
          : {
              position: 'absolute',
              top: logTop,
              left: row.left,
              width,
              height: Math.max(0, stripTop - logTop),
              zIndex: 10
            }
      }
    >
      {updates != null && (
        <RemoteScoringUpdates
          key={`${updates.game.gameId}:${updates.userId}`}
          {...updates}
          placement={side ? 'column' : 'stacked'}
          frame={{ top: 0, left: 0, width, lines: side ? 8 : frame.logLines }}
        />
      )}
      {box != null && <ReplayBoxScore box={box} bottomInset={0} />}
    </View>
  )
}
