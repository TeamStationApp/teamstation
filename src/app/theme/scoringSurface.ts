/** Shared palette for scoring sheets and their anchored menu counterparts. */
export const scoringSurface = {
  background: 'rgba(18, 28, 23, 0.95)',
  canvas: '#121c17',
  border: 'rgba(16, 185, 129, 0.4)',
  divider: 'rgba(6, 78, 59, 0.5)',
  text: '#e2e8f0',
  secondaryText: '#cbd5e1',
  mutedText: '#a3a3a3',
  activeText: '#ffffff',
  active: '#1d6b42',
  activeEnd: '#165835',
  accent: '#34d399',
  chevronActive: '#a7f3d0',
  idle: '#172720',
  input: '#243b30',
  inputBorder: '#658578',
  danger: '#f87171',
  dangerFill: '#991b1b',
  switchThumb: '#e2e8f0',
  badges: {
    green: { text: '#6ee7b7', background: '#10b98133', border: '#10b9814d' },
    amber: { text: '#fcd34d', background: '#f59e0b33', border: '#f59e0b4d' },
    red: { text: '#fca5a5', background: '#450a0acc', border: '#991b1b99' }
  }
}

export type ScoringSurface = typeof scoringSurface
