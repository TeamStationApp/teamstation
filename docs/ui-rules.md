# UI rules

These are the rules every screen follows, so a new screen looks like the
ones already there. Read them before adding or changing a screen. The shared
pieces they name live in [`src/app/components`](../src/app/components).

## Pickers

### Multi-row pickers are rows, never pills

A choice among more options than fit on one line is a list of rows. Time
zones, months, seasons, teams and cities are all lists of rows. Pills are
never used for them: a wall of pills wrapping onto several lines reads as a
heap of buttons rather than one list to choose from.

A row in a picker has:

- an optional leading tile: a logo, initials or an icon (`Emblem`, or the
  tile in `ListRow`);
- the name, on one line;
- a quieter detail line when there is something worth knowing: a season's
  dates and league, a team's seasons, a time zone's offset and time now;
- a mark on the chosen row (`RadioMark`), never a filled background; immediate
  navigation choices such as Choose Team use a right chevron instead;
- at least 48 points of height, and a hairline divider between rows.

Group search results use the individual-card treatment below instead of shared
row dividers; their identity layout is still a row, never a pill.

A grid of plain cells is a row picker too: the calendar's days and the
month grid. Its cells are text, the chosen one shaded, with no pill shell.

### Pills are for one row of a few choices

Pills (`SegmentedPill`, `PillTabs`) are for two to four mutually exclusive
choices that sit on a single line and never wrap, such as the event type
(Game, Practice, Other) or a screen's tabs.

### A long or searchable picker is a scene of its own

When a picker needs a search field, or holds more than a screenful of rows,
it is its own scene that slides up from the bottom (a full-screen `Modal`
with `animationType="slide"`). The scene has its title and a red **Cancel**
text button at the top. Cancelling changes nothing. Choosing a row closes the
scene and returns the choice. `TeamSelectorScene` and the time zone picker
are the examples. Such a picker is
never a list expanding inside a card on the screen beneath.

### A search field floats at the bottom

A search field sits at the bottom of its screen, not the top, so it is under
the thumb and right above the keyboard it opens.

- It floats over the content at the bottom of the screen, clear of the home
  indicator (the safe-area inset plus 12 points), full width less the
  screen's side margins, on the theme's raised surface with a hairline border
  and a soft shadow. The list scrolls beneath it, with bottom padding equal to
  the field's height so the last row can be read.
- Tapped, it takes focus with the cursor showing and rises with the keyboard
  to sit directly above it (`KeyboardAvoidingView`: `padding` on iOS,
  `height` on Android, as `TessChat` does). Dismissing the keyboard returns
  it to the bottom.
- It has a leading `search` icon, placeholder text naming what it searches
  ("Search players"), and a clear button while it holds text.
- The scene's title and red Cancel stay at the top.
- Typing asks the server once it pauses for half a second
  (`useDebouncedValue`), never on every keystroke.

`ScoringPlayerSearchField` (scoring colours, in `ExistingPlayerSheet`) is the
example. A screen with a search field at the top moves to this the next time
it is changed.

## Cards and collections

Use the Home team row (`ListRow`) for group identities: a fixed-size logo or
initials tile on the left, with left-aligned name and details vertically centered
beside it. Omit missing details, including location; never show "Location not set"
in a search result. Let content determine row height. Fewer lines make a shorter
row, down to the logo height plus the row's padding. Keep every logo the same size
and every text column at the same left edge, regardless of the number of lines.

- **Search and other unbounded or infinite scrolling results:** give each item
  its own white (theme card background) card with rounded corners, a subtle border
  and shadow, and space between cards. Do not wrap the whole result list in one
  white card. Discover and Add Team/management-relationship searches use
  `GroupSearchCard`, which wraps the Home row in a single `Card`. This applies to
  team, season and league search results, including additional relationship changes.
- **Static collections on Home and settings screens:** group related people,
  teams, seasons or leagues in one `ListCard`, with padded rows and hairline
  dividers. Relationship lists with independent actions use `ActionList bounded`
  and `GroupRelationshipRow`. Each category may have its own shared card.

Navigation and a trailing action such as Follow remain separate touch targets.
Do not nest the action inside the navigation button. Empty, loading and error
states remain outside the result cards. Editable location fields may still explain
that a location has not been set.

## Buttons

### Game hero actions stay compact

Order hero actions Score, Record, Coach, DJ, filtering each by its capability
and assigned scorekeeper, videographer, coach, or songkeeper role respectively.
Inherited season/league assignments count; admin privileges and roles implied
by another role do not. This presentation rule does not change authorization.
Coach and DJ use Score's existing scoring availability; DJ also needs device
support. Divide the card's full inner width into four equal slots with the
usual gaps and card margins. Reserve unused slots so fewer actions keep the
same width. Keep a 1.5 rem visible pill, 0.875 rem label and 3 rem touch target;
allow labels to scale down on narrow phones without truncation. Score is blue,
Coach green, DJ dark purple, and Record red.

### Membership and access actions belong in list rows

Whenever a collection lets the user enable or disable, join or leave, add or
revoke, or end a relationship, render a proper list with one row per item.
Use a leading image, name-hashed initials tile or appropriate icon when available;
put the name above quieter details in the flexible middle and a compact action
at the right. Use short visible labels such as **Add**, **Leave**, **Revoke** or
**End**, with an accessible label that also names the affected item.

In static collections, separate rows with hairline dividers inside one shared
card. Search results use individual cards as described above. Do not put a
full-width action below the item's name. Keep actions aligned, names readable
and touch targets at least 48 points.
Use green for adding/enabling and red for removing/ending. Destructive actions
open a confirmation modal; opening or cancelling it must not change the item.
Use `ActionRow` and `ActionList` for these collections, with
`GroupRelationshipRow` for groups. Navigation and the destructive action are
separate touch targets. The confirmation names the item and the relationship,
keeps failed writes retryable, blocks duplicate submissions, and ignores a
completion after the user leaves its owning group or person. This includes
ending season participation, disabling invite links, withdrawing invitations
and removing held roles. Existing permission checks and inherited-role rules
remain in force.

### A pill's label sits on its straight run

A fully rounded button, badge, count or tab has semicircular ends, each as
wide as half its height. The first and last glyph must clear those arcs:
horizontal padding is at least half the explicit shell height. Derive the
padding from that height, and check the longest label. A label that would
truncate gets smaller type, a shorter label or its own row; its padding and
touch target stay large enough. Dense tab strips reduce gaps and scroll.

- **One filled button per form.** The primary action (Save, Create) is the
  only filled button.
- **Cancel is centered beneath a primary action.** Use `CancelAction`: blue text
  beneath a red destructive primary, red text otherwise. Header and toolbar Cancels
  retain their header alignment; the team picker places its visible text on the
  right content margin. Cancel is never a filled or pale button.
- **A long label gets smaller type, not a smaller target.** Use
  `Button small`, which keeps the 48-point height.

## Explain a choice where it is made

### Use action language when no invitation is needed

When current permissions show the person can supply all required approvals,
use **Save**, **Add** or **Create Game**, as appropriate, and apply those
available approvals on submission. Do not ask for a separate approval toggle.
Use invitation/request wording when somebody else's consent is still needed.
The server's final result decides what happened: an accepted action returns to
the relevant connection or created item and shows a detailed success toast for
five seconds. Do not route it to a sent/approved notification. A pending request
keeps its pending flow. This also applies when submitting an older request
again: use neutral action language, apply currently available approvals and
route by the actual result. Cancel and failed writes show no success confirmation.

When a screen cannot offer a choice, say why in a sentence near the action
it affects, instead of a control that does nothing. A team page's Create
Game says above Save that its games are always scrimmages or exhibitions,
and that games counting for standings are created from the season.

## Access warnings

Use `WarningSheet` for a blocked action with a path to gaining access. It is a
solid yellow bottom sheet in every theme, with dark readable text, rounded top
corners and a slight shadow. Its single primary action is a content-width blue
pill centered at the bottom; dismiss through the close control or backdrop.
Keep available content visible behind the sheet. Game video restrictions keep
the main poster, camera choices and highlight thumbnails visible. Open the
warning only on a playback attempt, and never load restricted video sources.
Signed-out viewers see Log in / Sign up; signed-in nonmembers can request
membership in one participating team, subject to administrator approval.

A scan that cannot be read uses the same sheet: Share Lineup's scan step
raises it over the camera for a QR code that is not a GameChanger lineup or a
camera the app may not use, with Scan Again as its action.

Stats restrictions use the same message and blue login/membership action inline
under the public stats (the inning box score or team season performance). Do not
open a warning modal for stats. Keep team selection, request errors and pending
confirmation inline too; signing in returns to the same stats tab.

## Text in compact table cells

Use `TickerText` when a single-line identity must fit a fixed table column.
It pans only overflowing text, pauses at both ends, respects reduced motion,
and exposes one complete accessible label. Names and affiliated teams in
umpire assignment cells use this component. Ordinary descriptive table cells
use two-line wrapping instead.
