/** One column of a pop-up spinner (`Wheel`): its choices and the one chosen. */
export interface WheelProps {
  label: string
  options: number[]
  value: number
  onChange: (value: number) => void
  /** How an option reads, on its row and to assistive technology. */
  format?: (option: number) => string
  /** The column's `testID`. */
  testID?: string
  /**
   * Each row's `testID` is this, a dash, and the option; `testID` unless set.
   * Only the scrolling column (Android and browsers) has rows: on iOS a test
   * reads and turns the system's wheel through `src/test/iosWheel.e2e.ts`.
   */
  rowTestID?: string
  /**
   * The scrolling column's width, wide enough for the longest option. The
   * iOS wheel fills the width its column is given.
   */
  width?: number
}
