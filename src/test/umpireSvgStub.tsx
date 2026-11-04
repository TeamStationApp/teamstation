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
export const Circle = (
  props: React.SVGProps<SVGCircleElement>
): React.ReactElement => <circle {...props} />
export const Ellipse = (
  props: React.SVGProps<SVGEllipseElement>
): React.ReactElement => <ellipse {...props} />
export const Line = (
  props: React.SVGProps<SVGLineElement>
): React.ReactElement => <line {...props} />
export const G = (props: React.SVGProps<SVGGElement>): React.ReactElement => (
  <g {...props} />
)
export const Defs = (
  props: React.SVGProps<SVGDefsElement>
): React.ReactElement => <defs {...props} />
export const LinearGradient = (
  props: React.SVGProps<SVGLinearGradientElement>
): React.ReactElement => <linearGradient {...props} />
export const RadialGradient = (
  props: React.SVGProps<SVGRadialGradientElement>
): React.ReactElement => <radialGradient {...props} />
export const Stop = (
  props: React.SVGProps<SVGStopElement>
): React.ReactElement => <stop {...props} />
/** `import Svg from 'react-native-svg'`, as Tess's hold-to-confirm writes it. */
export default Svg
