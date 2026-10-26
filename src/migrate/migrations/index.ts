import type { Migration } from '../runner'
import { migration001Identity } from './001identity'
import { migration002Content } from './002content'
import { migration003Operations } from './003operations'
import { migration004Migration } from './004migration'
import { migration005SeasonsWithoutLeague } from './005seasonsWithoutLeague'
import { migration006SeasonMembers } from './006seasonMembers'
import { migration007RateLimits } from './007rateLimits'
import { migration008MergedTeams } from './008mergedTeams'
import { migration009Images } from './009images'
import { migration010Credits } from './010credits'
import { migration011Cameras } from './011cameras'
import { migration012SignInLinks } from './012signInLinks'
import { migration013Live } from './013live'
import { migration014LiveIndex } from './014liveIndex'
import { migration015LiveStreamOwners } from './015liveStreamOwners'
import { migration017OpenFromIssue } from './017openFromIssue'
import { migration018NoLateBound } from './018noLateBound'
import { migration019Invites } from './019invites'
import { migration020InviteEmails } from './020inviteEmails'
import { migration021BatsThrows } from './021batsThrows'
import { migration022CreditIndex } from './022creditIndex'
import { migration023GameStats } from './023gameStats'
import { migration024SeasonInnings } from './024seasonInnings'
import { migration025ShortNamesInDescriptions } from './025shortNamesInDescriptions'
import { migration026DirectorUploads } from './026directorUploads'
import { migration027UploadStartedAt } from './027uploadStartedAt'
import { migration028UploadKeepsItsHistory } from './028uploadKeepsItsHistory'
import { migration029UploadStep } from './029uploadStep'
import { migration030ReplacementCanBeDeleted } from './030replacementCanBeDeleted'
import { migration031Scoring } from './031scoring'
import { migration033DropEventDescription } from './033dropEventDescription'
import { migration035EraInnings } from './035eraInnings'
import { migration036KeepArchivedResponses } from './036keepArchivedResponses'
import { migration037GameStatsState } from './037gameStatsState'
import { migration038CurrentPlay } from './038currentPlay'
import { migration039GumboEventTypes } from './039gumboEventTypes'
import { migration040LegacyEventTypes } from './040legacyEventTypes'
import { migration041ScheduleApi } from './041scheduleApi'
import { migration042FenceDistance } from './042fenceDistance'
import { migration043RoleFlags } from './043roleFlags'
import { migration044TeamDefaultLineup } from './044teamDefaultLineup'
import { migration045WalkUpSongs } from './045walkUpSongs'
import { migration046ExternalCleanup } from './046externalCleanup'
import { migration047TeamStation } from './047teamStation'
import { migration048DropStatRollups } from './048dropStatRollups'
import { migration049ExpandedStats } from './049expandedStats'
import { migration050CreationHierarchy } from './050creationHierarchy'
import { migration050OAuth } from './050oauth'
import { migration051EventTags } from './051eventTags'
import { migration051PersonalRequests } from './051personalRequests'
import { migration052SeasonGameRefinements } from './052seasonGameRefinements'
import { migration052SignOutMergedAccounts } from './052signOutMergedAccounts'
import { migration053Follows } from './053follows'
import { migration054AppOrigin } from './054appOrigin'
import { migration054AssistantRole } from './054assistantRole'
import { migration055GuardianRequests } from './055guardianRequests'
import { migration056OneMemberKind } from './056oneMemberKind'
import { migration057EventInfo } from './057eventInfo'
import { migration058EventDetails } from './058eventDetails'
import { migration059AccountMail } from './059accountMail'
import { migration060ScoreboardLog } from './060scoreboardLog'
import { migration061VideoWallTimeline } from './061videoWallTimeline'
import { migration062PhoneStreams } from './062phoneStreams'
import { migration063GameStarted } from './063gameStarted'
import { migration064MembershipRequests } from './064membershipRequests'
import { migration065RadarReadings } from './065radarReadings'
import { migration066GameGuests } from './066gameGuests'
import { migration067GameUnroster } from './067gameUnroster'
import { migration068GumboIds } from './068gumboIds'
import { migration069UserIds } from './069userIds'
import { migration070PlayerGumboIds } from './070playerGumboIds'
import { migration071DeletedAccounts } from './071deletedAccounts'
import { migration072NarrationAudio } from './072narrationAudio'
import { migration072SeasonDates } from './072seasonDates'
import { migration073SyncClock } from './073syncClock'
import { migration073UmpireManagement } from './073umpireManagement'
import { migration074OptionalUmpires } from './074optionalUmpires'
import { migration074SyncIdempotency } from './074syncIdempotency'
import { migration075UmpireTypes } from './075umpireTypes'
import { migration076UmpireNotes } from './076umpireNotes'
import { migration077AnalyticsEvents } from './077analyticsEvents'
import { migration077Venues } from './077venues'
import { migration078GameFields } from './078gameFields'
import { migration079SeasonScheduling } from './079seasonScheduling'
import { migration080SchedulePreviews } from './080schedulePreviews'
import { migration081TeamKeyedAvailability } from './081teamKeyedAvailability'
import { migration082GamePregame } from './082gamePregame'
import { migration083PlayGeneration } from './083playGeneration'
import { migration084GamePlayArchives } from './084gamePlayArchives'
import { migration085Tess } from './085tess'

/** Every migration, in the order they were written. */
export const migrations: Migration[] = [
  migration001Identity,
  migration002Content,
  migration003Operations,
  migration004Migration,
  migration005SeasonsWithoutLeague,
  migration006SeasonMembers,
  migration007RateLimits,
  migration008MergedTeams,
  migration009Images,
  migration010Credits,
  migration011Cameras,
  migration012SignInLinks,
  migration013Live,
  migration014LiveIndex,
  migration015LiveStreamOwners,
  migration017OpenFromIssue,
  migration018NoLateBound,
  migration019Invites,
  migration020InviteEmails,
  migration021BatsThrows,
  migration022CreditIndex,
  migration023GameStats,
  migration024SeasonInnings,
  migration025ShortNamesInDescriptions,
  migration026DirectorUploads,
  migration027UploadStartedAt,
  migration028UploadKeepsItsHistory,
  migration029UploadStep,
  migration030ReplacementCanBeDeleted,
  migration031Scoring,
  migration033DropEventDescription,
  migration035EraInnings,
  migration036KeepArchivedResponses,
  migration037GameStatsState,
  migration038CurrentPlay,
  migration039GumboEventTypes,
  migration040LegacyEventTypes,
  migration041ScheduleApi,
  migration042FenceDistance,
  migration043RoleFlags,
  migration044TeamDefaultLineup,
  migration045WalkUpSongs,
  migration046ExternalCleanup,
  migration047TeamStation,
  migration048DropStatRollups,
  migration049ExpandedStats,
  migration050CreationHierarchy,
  migration050OAuth,
  migration051EventTags,
  migration051PersonalRequests,
  migration052SeasonGameRefinements,
  migration052SignOutMergedAccounts,
  migration053Follows,
  migration054AppOrigin,
  migration054AssistantRole,
  migration055GuardianRequests,
  migration056OneMemberKind,
  migration057EventInfo,
  migration058EventDetails,
  migration059AccountMail,
  migration060ScoreboardLog,
  migration061VideoWallTimeline,
  migration062PhoneStreams,
  migration063GameStarted,
  migration064MembershipRequests,
  migration065RadarReadings,
  migration066GameGuests,
  migration067GameUnroster,
  migration068GumboIds,
  migration069UserIds,
  migration070PlayerGumboIds,
  migration071DeletedAccounts,
  migration072NarrationAudio,
  migration072SeasonDates,
  migration073SyncClock,
  migration073UmpireManagement,
  migration074OptionalUmpires,
  migration074SyncIdempotency,
  migration075UmpireTypes,
  migration076UmpireNotes,
  migration077Venues,
  migration078GameFields,
  migration079SeasonScheduling,
  migration080SchedulePreviews,
  migration077AnalyticsEvents,
  migration081TeamKeyedAvailability,
  migration082GamePregame,
  migration083PlayGeneration,
  migration084GamePlayArchives,
  migration085Tess
]
