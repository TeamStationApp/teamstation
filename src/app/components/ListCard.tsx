import React from 'react'

import { Card, CardDivider, type CardProps } from './Card'

export type ListCardProps = Omit<CardProps, 'flush'>

/**
 * Rows own their padding, including the first and last row. This container
 * only draws the outer border and the dividers between nonempty children.
 * Supply padded rows directly, or wrap unpadded content in CardContent.
 */
export function ListCard({
  children,
  ...props
}: ListCardProps): React.ReactElement {
  const rows = React.Children.toArray(children)
  return (
    <Card {...props} flush>
      {rows.map((row, index) => (
        <React.Fragment key={React.isValidElement(row) ? row.key : index}>
          {index > 0 && <CardDivider />}
          {row}
        </React.Fragment>
      ))}
    </Card>
  )
}
