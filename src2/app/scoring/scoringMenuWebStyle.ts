import type { CSSProperties } from 'react'

import { SCORING_MENU } from './ScoringMenuAppearance'

export const scoringMenuPanel: CSSProperties = {
  background: SCORING_MENU.background,
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: `1px solid ${SCORING_MENU.border}`,
  borderRadius: 12,
  boxShadow: '0 12px 24px rgba(0, 0, 0, 0.4)',
  overflow: 'hidden',
  boxSizing: 'border-box'
}
export const scoringMenuRow = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  flexShrink: 0,
  boxSizing: 'border-box',
  minHeight: SCORING_MENU.rowHeight,
  border: 0,
  borderRadius: 0,
  borderBottom: `1px solid ${SCORING_MENU.divider}`,
  padding: '9px 10px',
  background: active
    ? `linear-gradient(to right, ${SCORING_MENU.active}, ${SCORING_MENU.activeEnd})`
    : 'transparent',
  color: active ? '#ffffff' : SCORING_MENU.text,
  fontSize: 13,
  fontWeight: 700,
  textAlign: 'left',
  cursor: 'pointer',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none'
})
