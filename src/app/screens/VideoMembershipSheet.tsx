import React from 'react'

import { MembershipAccess } from './MembershipAccess'

/** Video access is explained only when playback is attempted. */
export function VideoMembershipSheet(
  props: Omit<
    React.ComponentProps<typeof MembershipAccess>,
    'resource' | 'presentation'
  >
): React.ReactElement {
  return <MembershipAccess {...props} presentation="sheet" resource="videos" />
}
