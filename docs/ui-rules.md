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

## Buttons

### Membership and access actions belong in list rows

Whenever a collection lets the user enable or disable, join or leave, add or
revoke, or end a relationship, render a proper list with one row per item.
Use a leading image, name-hashed initials tile or appropriate icon when available;
put the name above quieter details in the flexible middle and a compact action
at the right. Use short visible labels such as **Add**, **Leave**, **Revoke** or
**End**, with an accessible label that also names the affected item.

Separate rows with hairline dividers. Do not give each item its own bounding
card or put a full-width action below its name. A shared list container may
match the surrounding screen; a long scrolling list remains unbounded. Keep
actions aligned, names readable and touch targets at least 48 points.
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
