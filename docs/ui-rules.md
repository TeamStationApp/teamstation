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
- a mark on the chosen row (`RadioMark`), never a filled background;
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
are the examples. A team search and a time zone list are never a list
expanding inside a card on the screen beneath.

### A required city stays on the screen that asks for it

Create League asks for a city on the screen titled Create League, the one
that says to choose a city and state. The text field is on that screen. It
is not a button that opens another scene.

Typing opens a dropdown of matching cities in the space above the keyboard.
That space is the keyboard's real frame, from Reanimated, not a guessed
height. The dropdown has no Save button. Choosing a row writes the full
place into the field, dismisses the keyboard, and the screen then offers
Continue.

## Motion

A transition on a screen runs through Reanimated. A text field never snaps
from one position to another. When the keyboard opens or closes, or when
rows appear or leave around a field, the field and the space above the
keyboard move with the keyboard's own frame on the animation thread.
Applying a guessed keyboard height in a React render is a snap.

## Buttons

- **One filled button per form.** The primary action (Save, Create) is the
  only filled button.
- **Cancel is red text.** Cancelling a form or dismissing a picker is a text
  button in the danger colour (`Button kind="text"` with
  `textColor={theme.dangerColor}`). It is never a filled or pale button.
- **A long label gets smaller type, not a smaller target.** Use
  `Button small`, which keeps the 48-point height.

## Explain a choice where it is made

When a screen cannot offer a choice, say why in a sentence near the action
it affects, instead of a control that does nothing. A team page's Create
Game says above Save that its games are always scrimmages or exhibitions,
and that games counting for standings are created from the season.
