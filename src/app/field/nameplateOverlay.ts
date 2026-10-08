import type { FieldPlayer } from './fieldModel'
import type { NameplatePlacement } from './playerPresentation'

const BLUE_CARD = 'rgba(16, 40, 72, 0.94)'
const RED_CARD = 'rgba(122, 48, 16, 0.94)'
/** Away wears blue and home wears red, on the shirt and on the card. */
export function nameplateColor(plate: {
  team: FieldPlayer['team']
  uniformSide?: FieldPlayer['uniformSide']
}): string {
  const side = plate.uniformSide ?? (plate.team === 'runner' ? 'home' : 'away')
  return side === 'away' ? BLUE_CARD : RED_CARD
}

/**
 * The phone's nameplates, split the way it draws them: what each plate says
 * and how it hangs, which changes now and then and is laid out by React, and
 * where it is, which changes every frame the field draws and moves the plate
 * without React (`NativeNameplates.tsx`).
 */
export interface NameplateFace {
  emptyPosition?: boolean
  id: string
  name: string
  /** `#` plus the jersey, or empty. */
  number: string
  color: string
  anchorX: number
  anchorY: number
}

/** Where a plate's anchor is, in the field's points, and whether it shows. */
export interface NameplateSpot {
  x: number
  y: number
  visible: boolean
}

export function nameplateFaces(plates: NameplatePlacement[]): NameplateFace[] {
  return plates.map(plate => ({
    id: plate.id,
    name: plate.name,
    number: plate.number,
    color: nameplateColor(plate),
    ...(plate.emptyPosition === true ? { emptyPosition: true } : {}),
    anchorX: plate.anchorX,
    anchorY: plate.anchorY
  }))
}

/** Equal for two lists of faces that draw the same, in the same order. */
export function facesKey(faces: NameplateFace[]): string {
  return JSON.stringify(faces)
}

export function nameplateSpots(
  plates: NameplatePlacement[]
): Record<string, NameplateSpot> {
  const spots: Record<string, NameplateSpot> = {}
  for (const plate of plates)
    spots[plate.id] = { x: plate.x, y: plate.y, visible: plate.visible }
  return spots
}

/**
 * Whether two frames' spots would draw the same plates in the same places, to
 * within half a point: most frames move no one, and a phone skips them.
 */
export function sameSpots(
  a: Record<string, NameplateSpot>,
  b: Record<string, NameplateSpot>
): boolean {
  const ids = Object.keys(b)
  if (Object.keys(a).length !== ids.length) return false
  return ids.every(id => {
    const was = a[id] as NameplateSpot | undefined
    const now = b[id]
    return (
      was?.visible === now.visible &&
      Math.abs(was.x - now.x) < 0.5 &&
      Math.abs(was.y - now.y) < 0.5
    )
  })
}

/** Wider and taller than any plate, which sits inside it against its anchor. */
const REACH_X = 400
const REACH_Y = 200

/**
 * The box a plate is laid out in, relative to its anchor, so that the plate
 * hangs from the anchor as `anchorX` and `anchorY` say without being measured
 * first: the browser does it with a percentage translate, which a phone's
 * moving view cannot use.
 */
export function anchorFrame(
  anchorX: number,
  anchorY: number
): {
  left: number
  top: number
  width: number
  height: number
  alignItems: 'flex-start' | 'center' | 'flex-end'
  justifyContent: 'flex-start' | 'center' | 'flex-end'
} {
  const place = (anchor: number): 'flex-start' | 'center' | 'flex-end' =>
    anchor <= 0 ? 'flex-start' : anchor >= 1 ? 'flex-end' : 'center'
  return {
    left: 0 - anchorX * REACH_X,
    top: 0 - anchorY * REACH_Y,
    width: REACH_X,
    height: REACH_Y,
    alignItems: place(anchorX),
    justifyContent: place(anchorY)
  }
}
