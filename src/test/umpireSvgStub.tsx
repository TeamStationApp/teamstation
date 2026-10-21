import React from 'react'
/** DOM host adapters for the native icon's SVG components in the unit suite. */
export const Svg = (
  props: React.SVGProps<SVGSVGElement>
): React.ReactElement => <svg {...props} />
export const Path = (
  props: React.SVGProps<SVGPathElement>
): React.ReactElement => <path {...props} />
