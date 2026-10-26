import React from 'react'
/** DOM host adapters for the native icon's SVG components in the unit suite. */
export const Svg = (
  props: React.SVGProps<SVGSVGElement>
): React.ReactElement => <svg {...props} />
export const Path = (
  props: React.SVGProps<SVGPathElement>
): React.ReactElement => <path {...props} />
/** Tess's hold-to-confirm traces its outline on a `Rect`. */
export const Rect = (
  props: React.SVGProps<SVGRectElement>
): React.ReactElement => <rect {...props} />
/** `import Svg from 'react-native-svg'`, as Tess's hold-to-confirm writes it. */
export default Svg
