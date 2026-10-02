/**
 * How many device pixels the field draws per layout point: at least one, and
 * no more than 1.25 on a phone or 1.5 on anything wider. A phone's screen is
 * two to three times that, and filling it costs frames the field needs more.
 */
export const FIELD_MAX_PIXEL_RATIO = { phone: 1.25, wide: 1.5 } as const

/** The range Fiber's `dpr` prop takes in the browser. */
export function fieldPixelRatioRange(phone: boolean): [number, number] {
  return [1, phone ? FIELD_MAX_PIXEL_RATIO.phone : FIELD_MAX_PIXEL_RATIO.wide]
}

/** The ratio the field draws at on a screen of `deviceRatio`. */
export function fieldPixelRatio(deviceRatio: number, phone: boolean): number {
  const [least, most] = fieldPixelRatioRange(phone)
  return Math.min(most, Math.max(least, deviceRatio))
}

export interface FieldRenderBox {
  /** The drawing view's size, in layout points. */
  width: number
  height: number
  /** Where it sits in the field, so that stretched by `stretch` it fills it. */
  left: number
  top: number
  stretch: number
  /** The pixel ratio that fills the drawing view's buffer at the field's size. */
  ratio: number
}

/**
 * expo-gl always draws at the device's full pixel ratio, so the phone field
 * gets the browser's cap another way: it draws into a view smaller by the
 * ratio it gives up, and stretches that view over the field. The scene still
 * works at the field's own size (`FieldRenderScale`), at `ratio`.
 */
export function fieldRenderBox(
  width: number,
  height: number,
  deviceRatio: number,
  phone: boolean
): FieldRenderBox {
  const scale = Math.min(1, fieldPixelRatio(deviceRatio, phone) / deviceRatio)
  const inner = { width: width * scale, height: height * scale }
  return {
    ...inner,
    left: (width - inner.width) / 2,
    top: (height - inner.height) / 2,
    stretch: 1 / scale,
    ratio: deviceRatio * scale
  }
}
