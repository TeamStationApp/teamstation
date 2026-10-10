import React from 'react'

import { useTheme } from '../theme/ThemeContext'
import { useHeaderSlot } from './headerSlot'
import { Screen } from './Screen'
import type { StickySectionLayoutProps } from './stickySectionLayoutProps'

/** The same section strip stays below the glass header after its hero leaves. */
export function StickySectionLayout({
  hero,
  sections,
  children,
  onScroll,
  wide
}: StickySectionLayoutProps): React.ReactElement {
  const { headerHeight } = useHeaderSlot()
  const theme = useTheme()
  return (
    <Screen onScroll={onScroll} wide={wide}>
      {hero}
      <div
        data-testid="sticky-season-sections"
        style={{
          position: 'sticky',
          top: headerHeight,
          zIndex: 3,
          backgroundColor: theme.backgroundColor
        }}
      >
        {sections}
      </div>
      {children}
    </Screen>
  )
}
