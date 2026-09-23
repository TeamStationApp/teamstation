import React from 'react'

/** A fruit, with a leaf and no bite: not the company mark. */
export function AppleGlyph(props: {
  size: number
  color: string
}): React.ReactElement {
  const { size, color } = props
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path
        fill={color}
        d="M12 7.2c-2.8.1-5.1 2.5-5.4 5.5-.4 3.5 1.7 6.8 4.8 7.5 1 .3 1.6-.2 2.4-.2.8 0 1.3.5 2.3.2 3.2-.8 5.3-4.2 4.8-7.7-.4-2.7-2.4-4.9-5-5.3-.5-1.3-1.6-2.3-3-2.5.3.8.5 1.7.1 2.5z"
      />
      <path
        fill={color}
        d="M14.4 4.4c.7-.9 1.1-2 1-2.9-1 .1-2.1.7-2.8 1.6-.6.8-1 1.8-.8 2.7 1.1.1 2-.5 2.6-1.4z"
      />
    </svg>
  )
}
