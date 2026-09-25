export const PLAYER_COUNTS = Array.from({ length: 16 }, (_, index) => index + 1)
export const COUNT_ROW_HEIGHT = 40
export const clampPlayerCount = (value: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.min(16, Math.round(value))) : 1
export const countAtOffset = (y: number): number =>
  clampPlayerCount(y / COUNT_ROW_HEIGHT + 1)
export interface PlayerCountPickerProps {
  value: number
  onChange: (value: number) => void
}
