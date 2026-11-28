import React from 'react'

import { MembershipAccess } from './MembershipAccess'

/**
 * Video access, and the hero's Live / Replay, are explained only when they
 * are tried.
 */
export function VideoMembershipSheet({
  resource = 'videos',
  ...props
}: Omit<
  React.ComponentProps<typeof MembershipAccess>,
  'resource' | 'presentation'
> & { resource?: 'videos' | 'replay' }): React.ReactElement {
  return (
    <MembershipAccess {...props} presentation="sheet" resource={resource} />
  )
}
