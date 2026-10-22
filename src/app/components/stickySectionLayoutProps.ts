import type React from 'react'

import type { ScreenProps } from './Screen'

export interface StickySectionLayoutProps {
  hero: React.ReactNode
  sections: React.ReactNode
  children: React.ReactNode
  onScroll: () => void
  wide?: boolean
  scrollRef?: ScreenProps['scrollRef']
  contentStyle?: ScreenProps['contentStyle']
}
