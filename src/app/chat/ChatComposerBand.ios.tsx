import React from 'react'
import {
  Platform,
  requireNativeComponent,
  StyleSheet,
  View,
  type ViewProps
} from 'react-native'

import { ChatComposerBand as TabletComposerBand } from './ChatComposerBand.native'
import type { ChatComposerBandProps } from './ChatViewport'

const KeyboardDock = requireNativeComponent<
  ViewProps & { dockClearance?: number }
>('TSChatComposerDock')

export function ChatComposerBand(
  props: ChatComposerBandProps
): React.ReactElement {
  if (Platform.OS === 'ios' && Platform.isPad)
    return <TabletComposerBand {...props} />
  const {
    viewport,
    active,
    frame: _frame,
    tabletLift: _tabletLift,
    style,
    ...rest
  } = props
  const { bottom, gap, follow } = viewport.composerDock
  const following = active && follow
  return (
    <KeyboardDock
      pointerEvents="box-none"
      style={[
        StyleSheet.absoluteFill,
        { zIndex: StyleSheet.flatten(style)?.zIndex }
      ]}
      dockClearance={following ? bottom - gap : undefined}
    >
      <View
        {...rest}
        style={[
          style,
          { bottom: following ? bottom : viewport.composerBottom }
        ]}
      />
    </KeyboardDock>
  )
}
