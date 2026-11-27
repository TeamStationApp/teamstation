import React from 'react'
import { Image, View } from 'react-native'

import type { LogoPlacement } from '../../../common/nodeSettings'
import type { GameSponsorLogo } from '../../../common/sponsors/types'
import type { Rect } from '../controlGeometry'
import { logoRect } from './overlayRects'

/**
 * A game's sponsor logo over one video, in its upper-right corner where the
 * node's `placement` puts it (`logoRect`), in the coordinates of whatever
 * holds `tile`. It takes no touch, and sits over the picture and under the
 * board and the controls that follow it. Nothing without a logo, or for a
 * tile with no size.
 */
export function SponsorLogoOverlay(props: {
  logo: GameSponsorLogo | null | undefined
  tile: Rect
  placement: LogoPlacement
}): React.ReactElement | null {
  const { logo, tile, placement } = props
  if (logo == null || !(tile.w > 0 && tile.h > 0)) return null
  const rect = logoRect(tile, placement, {
    width: logo.width,
    height: logo.height
  })
  return (
    <View
      testID="sponsor-logo"
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h
      }}
    >
      <Image
        source={{ uri: logo.url }}
        resizeMode="contain"
        style={{ width: '100%', height: '100%' }}
      />
    </View>
  )
}
