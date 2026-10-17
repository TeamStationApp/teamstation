import React from 'react'

import type { Locality } from '../../common/locality'
import { ListRow } from './ListRow'

export function LocationRow({
  value,
  onPress
}: {
  value: Locality | null
  onPress?: () => void
}): React.ReactElement {
  return (
    <ListRow
      title={
        value == null ? 'Location not set' : `${value.city}, ${value.region}`
      }
      subtitle={value == null ? 'Add a city' : value.country}
      onPress={onPress}
    />
  )
}
