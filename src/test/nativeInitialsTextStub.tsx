import React from 'react'
import type { TextProps } from 'react-native'
import { Text as WebText, View } from 'react-native'

export { View }
let layout: TextProps['onTextLayout']
/** Inject native font layout events without claiming a simulator rendering pass. */
export function emitInitialsLayout(
  lines: Array<{ width: number; capHeight: number }>
): void {
  // The native layout event contains additional unused event metadata.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  layout?.({ nativeEvent: { lines } } as Parameters<
    NonNullable<TextProps['onTextLayout']>
  >[0])
}
export function Text({
  onTextLayout,
  ...props
}: TextProps): React.ReactElement {
  if (onTextLayout != null) layout = onTextLayout
  return <WebText {...props} adjustsFontSizeToFit={false} />
}
