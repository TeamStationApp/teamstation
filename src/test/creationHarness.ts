import { resolve } from 'node:path'

import { makeToken } from '../server/auth/tokens'
import type { AddedNotice, GuardianInvitation } from '../server/email/sendMail'
import { type Clock, realClock } from '../server/groups/requests'
import { eventGeocoder } from '../server/location/eventGeocoder'
import type { GooglePlaces } from '../server/location/googlePlaces'
import { publishPictureCatalog } from '../server/media/pictureCatalog'
import { eventInfoRoutes } from '../server/routes/eventInfo'
import { eventListRoutes } from '../server/routes/eventList'
import { eventRoutes } from '../server/routes/events'
import { gameApprovalRoutes } from '../server/routes/gameApprovals'
import { groupRoutes } from '../server/routes/groups'
import { inviteRoutes } from '../server/routes/invites'
import { lineupRoutes } from '../server/routes/lineups'
import { liveRoutes } from '../server/routes/live'
import { locationRoutes } from '../server/routes/location'
import { manageRoutes } from '../server/routes/manage'
import { nodeAdministrationRoutes } from '../server/routes/nodeAdministration'
import { notificationRoutes } from '../server/routes/notifications'
import { onboardingRoutes } from '../server/routes/onboarding'
import { peopleRoutes } from '../server/routes/people'
import { pictureRoutes } from '../server/routes/pictures'
import { scheduleRoutes } from '../server/routes/schedule'
import { schedulingSetupRoutes } from '../server/routes/schedulingSetup'
import { seasonRoutes } from '../server/routes/seasons'
import { statsRoutes } from '../server/routes/stats'
import { teamMemberRoutes } from '../server/routes/teamMembers'
import { userRoutes } from '../server/routes/users'
import { venueRoutes } from '../server/routes/venues'
import { walkUpSongRoutes } from '../server/routes/walkUpSongs'
import {
  type AccountHarness,
  accountHarness,
  type MountExtra
} from './accountHarness'

/** Real server/database/mail/object service; no creation or approval response is stubbed. */
export async function creationHarness(
  webRoot?: string,
  clock: Clock = realClock,
  bindHost = '127.0.0.1',
  mountExtra?: MountExtra,
  cityLookup?: GooglePlaces,
  eventOptions: Parameters<typeof eventInfoRoutes>[2] = {}
): Promise<AccountHarness> {
  const h: AccountHarness = await accountHarness(
    webRoot,
    (app, { db, media, space, sendCode }) => {
      const sendInvite = async (
        email: string,
        invitation: { scopeName: string; invitedBy: string; link: string }
      ): Promise<void> => {
        if (h.controls.failMail) throw new Error('Test invitation mail failure')
        h.links.set(email, invitation.link)
      }
      app.use('/api/v1', onboardingRoutes(db, media))
      app.use('/api/v1', pictureRoutes(db, space))
      app.use(
        '/api/v1',
        locationRoutes(undefined, { db, googlePlaces: cityLookup })
      )
      const sendGuardianInvite = async (
        email: string,
        invitation: GuardianInvitation
      ): Promise<void> => {
        if (h.controls.failMail) throw new Error('Test invitation mail failure')
        h.links.set(email, invitation.link)
        h.invitations.set(email, invitation)
      }
      // Mail telling somebody they were added: its link, and the notice.
      const sendAdded = async (
        email: string,
        notice: AddedNotice
      ): Promise<void> => {
        if (h.controls.failMail) throw new Error('Test added mail failure')
        h.links.set(email, notice.link)
        h.invitations.set(email, notice)
      }
      app.use(
        '/api/v1',
        groupRoutes(db, media, clock, {
          sendInvite,
          sendGuardianInvite,
          sendAdded
        })
      )
      app.use('/api/v1', manageRoutes(db, { sendInvite, sendAdded, clock }))
      app.use('/api/v1', peopleRoutes(db, media, { sendAdded, clock }))
      app.use('/api/v1', inviteRoutes(db, { sendCode }))
      app.use('/api/v1', nodeAdministrationRoutes(db, media.space))
      app.use('/api/v1', gameApprovalRoutes(db, clock))
      app.use('/api/v1', scheduleRoutes(db))
      app.use('/api/v1', notificationRoutes(db, clock))
      app.use('/api/v1', seasonRoutes(db, media))
      app.use('/api/v1', userRoutes(db, space))
      app.use('/api/v1', statsRoutes(db, media))
      app.use('/api/v1', walkUpSongRoutes(db))
      app.use('/api/v1', lineupRoutes(db))
      app.use('/api/v1', teamMemberRoutes(db, media))
      app.use('/api/v1', eventRoutes(db))
      app.use(
        '/api/v1',
        eventInfoRoutes(db, media, {
          googleMapsApiKey: '',
          geocoder: eventGeocoder(db, { googlePlaces: cityLookup }),
          ...eventOptions
        })
      )
      app.use('/api/v1', eventListRoutes(db, media))
      app.use('/api/v1', venueRoutes(db, media, { places: cityLookup, clock }))
      app.use('/api/v1', schedulingSetupRoutes(db, { clock }))
      app.use(
        '/api/v1',
        liveRoutes(db, {
          live: {
            enabled: false,
            bindHost: '127.0.0.1',
            port: 0,
            app: 'live',
            segmentSeconds: 4,
            freeDiskFloorGb: 1
          },
          sessionSecret: makeToken(),
          host: 'localhost'
        })
      )
    },
    bindHost,
    mountExtra
  )
  try {
    // This synthetic harness starts after the explicit migration cutover.
    await h.db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
      .execute()
    await publishPictureCatalog(h.space, resolve('src/app/assets/sports'))
  } catch (error) {
    await h.close()
    throw error
  }
  return h
}
