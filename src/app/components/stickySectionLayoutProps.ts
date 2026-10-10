import type React from 'react'

export interface StickySectionLayoutProps {
  hero: React.ReactNode
  sections: React.ReactNode
  children: React.ReactNode
  onScroll: () => void
  wide?: boolean
}
