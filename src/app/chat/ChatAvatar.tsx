import React from 'react'
import { View } from 'react-native'

import { Emblem } from '../components/Emblem'
import { useTheme } from '../theme/ThemeContext'
import type { ChatIdentity } from './chatIdentityModel'

export interface ChatAvatarProps {
  identity: ChatIdentity
  size?: number
}

/** Renewed URLs remount the shared image fallback, including each DM tile. */
export function ChatAvatar(props: ChatAvatarProps): React.ReactElement {
  const { identity, size = 2.5 } = props
  const theme = useTheme()
  const composite = identity.tiles.length > 1
  return (
    <View
      testID="chat-avatar"
      accessibilityLabel={identity.label}
      style={{
        width: theme.rem(size),
        height: theme.rem(size),
        flexShrink: 0,
        borderRadius: theme.rem(theme.radiusRem),
        overflow: 'hidden'
      }}
    >
      {identity.tiles.slice(0, 4).map((tile, index) => (
        <View
          key={tile.key}
          style={
            composite
              ? {
                  position: 'absolute',
                  left: theme.rem(((index % 2) * size) / 2),
                  top: theme.rem(
                    ((identity.tiles.length === 2
                      ? index
                      : Math.floor(index / 2)) *
                      size) /
                      2
                  )
                }
              : undefined
          }
        >
          <Emblem
            key={`${tile.key}:${tile.uri ?? ''}`}
            uri={tile.uri}
            fallback={tile.initials}
            tint={tile.tint}
            shape="rounded"
            size={composite ? size / 2 : size}
          />
        </View>
      ))}
    </View>
  )
}
