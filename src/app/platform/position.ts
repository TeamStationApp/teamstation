/** A point on the map: where the person is now. */
export interface Position {
  latitude: number
  longitude: number
}

/** How long to wait for a position before listing without one. */
export const POSITION_TIMEOUT_MS = 8000
