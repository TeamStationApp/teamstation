# teamstation

## Unreleased

- added: Master production builds of the Apple TV app are uploaded to TestFlight, ready for App Store review
- added: `segmentSpaceVideos` repackages the videos already in the Space as one file into six-second pieces, with a dry run first and `--delete-old` for the old copies afterwards
- added: Tapping "N edits not sent" opens a sheet of each refused edit, naming its game or team with the server's message, with Try Again and Use Server's Copy; the Game and Team screens show the same held notice
- changed: The Apple TV app declares that it uses no non-exempt encryption, and its release builds carry no development settings
- changed: Every uploaded video and every recorded game is kept in the Space as six-second pieces, never as one large file
- changed: The web keeps the phone's copy of what its screens read and queues edits as the phone does, in the tab: it scores without waiting on the server, keeps every play across browser Back and while offline, shows the offline banner and the "edits not sent" banner and sheet, and warns before the tab is left while edits wait
- changed: On the web, Coach Game keeps a refused lineup or rostered change and holds it in "edits not sent", as the phone does
- changed: The web build writes brotli and gzip copies of its scripts, styles and WebAssembly for the server to send, about a quarter of the bytes on a first visit
- fixed: The Apple TV sign-in screen says its code is eight letters, entered under Account, TeamStation TV
- fixed: Tapping a highlight or seeking in a recorded game starts playing at once, instead of hanging on "Camera loading…"
- fixed: A ball scored on the web just before browser Back is no longer lost
- fixed: Scoring opens at once from what the phone or tab holds, with a pitch still on its way to the server, instead of waiting on a slow server
- changed: Screens read again only when the server's socket says something they show changed, once on opening, and once for each time the socket drops; nothing reads on a timer or on coming back to the app, and the bell's slow answer no longer puts the app offline
- changed: A phone keeps the nearest three games its person is a scorekeeper of, in the next four days, ready to open and score with no signal, even one never opened; nobody else's phone downloads games ahead
- fixed: A tab or phone left open on a busy schedule no longer reads every game again and again

## 1.4.0 (2026-11-21)

- changed: Google Play closed-testing uploads publish the bundle and do not send release notes
- added: One search field finds leagues, seasons, teams and people, with the closest matches first
- changed: The Auto-Scheduler builds every schedule exactly on the web, iPhone and Android, and publishes a large preview in a bounded number of queries
- changed: On a phone, the game screen releases its own player while the four-camera grid is open, and the live pill pulses only where it can be seen
- added: Streaming end-to-end tests replay synthetic cameras from a publisher, and every viewer recovers when a camera drops out or the viewer scrubs
- added: The end-to-end suite runs on develop's framework on its test stacks, including stand-ins, Tess and covered taps
- added: Anyone can ask Tess how TeamStation works and get an answer from the source code of the release they are using, with the files and lines it comes from
- added: Develop, branch and seat builds of the web and phone apps report how each video plays: how long it takes to start, every stall and seek with how far behind live it was, errors and the recoveries that followed, bitrate and dropped frames, so a slow start or a stall can be measured
- added: `?debug=1` on the game page shows what its video player is doing: its state, the page's own reading and its last events
- added: Streaming end-to-end scenarios for iPhone Safari: twenty rapid scrubs, and a camera cut for 64 s again and again
- added: Chat asks once for your age, in a modal: a birth year and month, or 18 or older. Until you give it you can be added to chats and sent messages but read none, and notifications say only that you have a new message
- added: A league's settings have a SafeSport switch for leagues that are SafeSport Local Affiliated Organizations: a message between an adult and someone 13 to 17 must then include their guardian, an adult family member, or an adult coach, assistant or admin of their team
- added: Guardians and site administrators can change a person's age from Player Settings; only a site administrator can make an adult a minor or clear an age
- changed: Tess keeps more of a long conversation before summarizing it, and can look things up 20 times in one answer instead of 10
- changed: The schedule build's log is a four-line box that scrolls like a terminal: each step shows as it starts, its time counting up each second, and becomes its finished line, with how long it took, in place; the clock stops while the build waits at a time limit
- changed: App builds made with the deploy scripts from any branch but master report their logs to the server they talk to, not to production's
- changed: Who may message someone 13 to 17 follows their age, not whether anyone plays: their team's admins, coaches and assistants, players within 4 years of them in their season, and their adult guardians and family. Adults message each other as before, so an adult who also plays can message league staff
- changed: Chat is closed to anyone under 13: they leave every chat, and a direct message left with one person closes. Someone who first gives their age in a direct message the rules don't allow it in doesn't see what was said there before
- changed: A guardian must be an adult, and coaches no longer see or set players' birth months
- changed: The 13+ consent sheet is gone, along with the account setting behind it
- changed: In the iPhone and Android apps, the age modal's birth year and month are wheels, starting 10 years back; on an iPhone, Apple's age range (under 13, 13 to 15, 16 to 17, or 18 and older) skips the modal for an adult and offers a teenager only the years their range allows
- fixed: Offline documents and unsent edits stay with the server and account that created them.
- fixed: A web build can send its logs to the log collector it was built for; the page's content policy refused them before
- fixed: Phone builds from Mason, other than master's production build, report their logs and crashes to the server they talk to; they reported nothing before
- fixed: Scoreboards, roster caches and live playlists recover promptly after an idle connection closes.
- fixed: Chrome end-to-end observations no longer retain a second copy of downloaded responses, keeping long streaming memory measurements representative of playback
- fixed: In iPhone Safari, a live game's video plays again after a camera is away longer than the 45 s cushion, instead of staying stopped for good
- fixed: In iPhone Safari, the video no longer freezes for good after quick scrubs or coming back from full screen

## Unreleased

## 1.3.0 (2026-11-18)

- added: An animated launch splash over the stadium on every cold launch, on iPhone, iPad, Apple TV and Android
- added: The phone keeps what its screens read and the pictures it drew, opens them with no signal, and scores from its own copy without waiting on the server. The offline banner sits at the bottom of the phone, under the tab bar.
- added: User Management in Node administration: node administrators page through recent logins and device sessions, look people up, and change a person's name and photo
- added: The game plan lists each inning's missing and doubled positions, and shares and prints as a one-page Letter PDF
- added: A team's assistants coach its games and read its game plan
- added: Add Admins, Staff, Spectators and Players from each people section. Add People ends with a locked Spectator.
- added: The account screen lists the account's direct affiliations below its email addresses
- added: Seasons choose their fields, availability takes dated windows, and the Auto-Scheduler has one season table with weekly limits and preferred days
- added: A develop build's server can be set from a deep link or from About TeamStation
- added: End-to-end test framework (`npm run e2e`) with streaming end-to-end tests: synthetic cameras, every kind of watcher, soaks and targeted scenarios
- added: Master production Android bundles are released to Google Play closed testing, as a draft while the app has never been published
- added: Notifications on iPhone, Android and the browser for direct messages, mentions, and a reminder two hours before an event you said you'd attend. Each device has its own switches under Account › Notifications.
- added: After you RSVP or open messaging, TeamStation offers once to turn on notifications for that device
- added: A message you're reading doesn't notify you, and reading a conversation on one device clears its notifications on your others
- added: Backspace in Search's empty field takes out the chosen place
- added: Search suggests the places near you first among those that match as well: near your own teams and leagues, or, signed out, near the city DB-IP's free database places your connection in. The server keeps that database in its state directory (`ipPlaces` in the server config moves it, `false` turns it off), refreshes it monthly and holds one copy in memory for all its workers, and About TeamStation credits DB-IP
- changed: A stream ends after ten minutes without video once its game has ended. Its recording is kept and its expired ingest key is revoked.
- changed: Schedules are computed on the device and stored as sent, and the server validates the submitted games
- changed: Imported games carry TeamStation records on every play, so replay, box score, pitch counts, statistics and editing treat them like scored games. An outside scorer's unknown players are seated as guests.
- changed: A team's coaching plan stays with its coaches. The scoring screen downloads only the defensive column of the inning in play.
- changed: A league's and a season's People tabs list no players
- changed: Creating a league or season inside one you already administer from above adds no separate administrator grant, and grants an inherited one covers are removed. The last-administrator check counts administration inherited from above; a team still keeps its own administrators.
- changed: Every pill on Search is the size of a result's kind pill, in the same neutral colours; a chosen place's pill takes it out with a small gray circle and a white X
- changed: Every pill on Search is the size of a result's kind pill and stands off the page on Following's shadow, in the same neutral colours; a chosen place's pill takes it out with a small gray circle and a white X, centred at its end
- changed: In a browser, Search's field sits at the top under its title, with the suggested places right under it and the results below
- changed: On a phone or tablet, Search's field stays at the bottom with the suggested places above it, and both rise and fall with the keyboard as it opens and closes; dragging the results puts the keyboard away
- changed: Add Player searches with Search's own field: at the top in a browser, and on a phone or tablet at the bottom, rising and falling with the keyboard while the screen stays put; dragging the list puts the keyboard away
- changed: The game plan's inning columns grow with the window, up to 1206 points
- changed: Clear and Help on the coaching and scoring sheets are brighter
- changed: Node administration sits beside the account instead of inside Account
- changed: Pictures are stored as public objects under random names and served unsigned
- changed: Master builds upload to TestFlight without being submitted for beta review
- changed: Android releases are signed in the Masonfile with the release key from Mason secrets
- changed: Nomac archives accept Xcode 27.0, 27.1 and 27.2
- changed: `npm run lint` runs ESLint once per TypeScript project, so it no longer runs out of CI's heap
- fixed: Dictation keeps a runner who holds short of the hit at the base he held
- fixed: Dictation scores a swing on a wild pitch as a swinging strike and keeps the wild pitch
- fixed: Dictation places a ball a named fielder took, with no place said, where that fielder plays
- fixed: Dictation reads a loop as a bloop, and a hit's trajectory only from its words
- fixed: A phone's multi-camera grid starts once Android's player is ready
- fixed: A live segment with no timestamp is placed by when it was written
- fixed: A scorer's grab of a fielder holds while the screen redraws
- fixed: The Android release check reads apksigner's per-scheme signer lines

## 1.2.0 (2026-11-14)

- added: A Plan tab on the coaching screen, where a game plan sets the defense for every inning. On the web it edits like a spreadsheet, and innings can be added and deleted.
- added: Playing Time Rules for seasons and teams, with warnings when a player would fall short
- added: The scorekeeper's defense moves to the game plan's at the end of each inning
- added: Several people can score one game. The first server-accepted play wins a conflict, delayed and offline histories are reconciled without replaying a losing timeline, and remote scoring and Undo appear, attributed, in a collapsible panel.
- added: HBP, pitch (#P) and strike (S) columns on box scores on the web, mobile, replay and TV, with one key beneath both teams. Season, team and player statistics tables have full keys.
- added: Tap-to-focus on local and remote camera previews, with a persistent lock and an explicit Auto Focus
- added: The replay plays a stadium crowd and cheers the big plays
- added: Wide, signed-in windows use labelled left navigation, with Notifications and the account at the sidebar's foot. Tess opens in its own full-height panel on the right.
- added: An affiliation line under every person a list names
- added: Live playback can jump to the present, and entering the Videos tab starts playback
- added: The TV sign-in screen shows the app version and build
- changed: Anyone allowed to read a person's full name, player or adult, reads it everywhere the app names that person. Everyone else reads the short name, as before.
- changed: Initials, teams, leagues and seasons are coloured by their id, and a season without a picture draws its league's
- changed: The replay frames its field like the scoring screen, with one black-on-white volume button, an X to close, a three-line scrolling announcer, and the box score and play card in a side column on tablets and wide windows
- changed: The remote scoring log is worded on the client from the accepted history, in a scrolling panel, so it can be translated. The server records only who scored each action.
- changed: Redesigned scoring overrides. Changing halves resets the players.
- changed: The roster editor's Defense tab lays the field out in six rows with larger names, roster cards are picked up by their grip and dropped onto a vacated position, and Box Score has its own pill
- changed: Roster and Lineup names draw at full size, wrapping between first and last name instead of shrinking. Fielders on the defensive field show their short name, unshrunk.
- changed: The coach's plan opens with five innings, with a wider player column
- changed: A game takes at most four active cameras
- changed: Pop-up spinners use the native iOS wheel in the app, and Safari's time wheel on iPhone and iPad
- changed: Public season schedules use the same tappable rows as member schedules
- changed: League Teams and Season Settings' participating teams each show in one shared list card
- changed: TV pairing screens have larger artwork and instructions, Apple TV artwork keeps its rounded corners, and TV game dates use the viewer's time zone
- changed: Upgrade glob to 14.0.4 and minimatch to 11.0.8
- changed: Unit tests run per commit and integration tests run on their own (`npm run test.integration`)
- fixed: Android event maps draw Google tiles instead of a blank map. Builds now carry the Google Maps key and check the APK has it.
- fixed: Ending a half by hand mid at-bat saves the at-bat and leaves that batter due. Older builds are kept from saving plays, and a repair puts back the at-bats they dropped.
- fixed: Delayed scoring updates no longer remove a game's finalization or leave another scorer stuck on an unfinished play
- fixed: Shared cards stay readable on dark themes whose card surface matches the canvas text
- fixed: Native action icons are centered in their buttons
- fixed: Scoring sheet backgrounds extend through the bottom safe area, and the half-inning and home-away confirmations sit clear of their buttons
- fixed: A narrow team card keeps its name whole when a place badge shares the corner with Follow
- fixed: A failed address lookup no longer ends the server

## 1.1.0 (2026-11-11)

- added: First release on the App Store
