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
  migration035EraInnings
]
