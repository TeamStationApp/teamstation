// The exact settlement (exact.ts), with required matchups and exhibition
// games in the model, solved by HiGHS's C++ API on this thread.
//
// The model's columns are games: a pair of a season's teams in one of the
// season's candidate slots. Its rows are the hard rules of `Occupancy`: a
// field holds one game at a time with the later game's buffer kept, a team
// plays one game at a time, at most once a day when its season never plays
// doubleheaders, within its weekday and weekend maximums, a pair meets at
// most as often as `regularPairs` allows, and teams sharing a manager never
// overlap.
//
// - A build has one integer target per season, `g`, for regular games, with
//   today's parity rule, and `e` for exhibition games: each participant plays
//   its exhibition need over the pairs `exhibitionOpponents` assigns it, or
//   all of them when they are fewer. `Σ g·W + Σ e·V` is maximised, `W` above
//   every exhibition count, so a regular game always comes first.
// - A recalculation gives each required matchup columns with `Σ ≤ 1`, no
//   target, parity or pair cap, and maximises the number placed. Matchups
//   alike (the same home, away and type) share their columns, at most as
//   many as there are of them, so the solve has no symmetric copies to
//   search; each chosen game then goes to the next of them in order.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <set>

#include "Engine.h"
#include "Highs.h"

namespace teamstation::scheduler {

namespace {

constexpr double kInfinity = std::numeric_limits<double>::infinity();

enum class Relaxed { None, Managers, WeekParts, Doubleheaders, Fields };
enum class Mode { Targets, MostAtFloor, Required };
enum class ColumnKind { Regular, Exhibition, Required };

struct Spec {
  const SeasonContext* season = nullptr;
  // The season's participants playing in this run, in season order; for a
  // recalculation, the teams of its required matchups.
  std::vector<int> active;
  std::unordered_map<int, int> fixedRegular;
  std::unordered_map<int, int> fixedExhibition;
  std::map<std::pair<int, int>, int> met;
  bool oddAsked = false;
  int floor = 0;
  int starting = 0;
  int floorE = 0;
  int startingE = 0;
  int requestedE = 0;
  // Each participant's exhibition opponents, one entry a game.
  std::vector<std::pair<int, int>> assignments;
  std::unordered_map<int, int> assigned;
  // The exhibition teams the assignments name, in season order.
  std::vector<int> exhibitionTeams;
  // Indexes into the context's required matchups.
  std::vector<int> required;
  // The same, matchups alike together, in the order each first appears.
  std::vector<std::vector<int>> classes;
  std::vector<int> candidates;

  int fixedRegularOf(int team) const {
    const auto found = fixedRegular.find(team);
    return found == fixedRegular.end() ? 0 : found->second;
  }
  int fixedExhibitionOf(int team) const {
    const auto found = fixedExhibition.find(team);
    return found == fixedExhibition.end() ? 0 : found->second;
  }
};

struct Bound {
  int lower = 0;
  int upper = 0;
  int capAt = 0;
  int eLower = 0;
  int eUpper = 0;
};

struct Column {
  int spec;
  int slot;
  int home;
  int away;
  ColumnKind kind;
  int item;
};

// The most games an objective bound allows a model: what the time limit
// and the progress report as "at most".
struct GameBound {
  // The objective counts each game once (a recalculation, the floors).
  bool perColumn = false;
  // Otherwise it is Σ g·regularWeight + exhibitions − at most `slack`.
  double regularWeight = 1;
  double slack = 0;
  struct Season {
    int needing = 0;     // teams that take new games
    int fixedTotal = 0;  // their fixed games
    int lower = 0;
    int upper = 0;
  };
  std::vector<Season> seasons;
  int exhibitionMost = 0;
  // A recalculation's matchups: the most it can place.
  int requiredMost = -1;

  int operator()(double bound) const {
    // No bound yet (HiGHS has not solved the root): only the model's own.
    const bool unbounded = !(bound < kInfinity);
    if (perColumn && !unbounded) return std::max(0, static_cast<int>(std::floor(bound + 1e-6)));
    if (requiredMost >= 0) return requiredMost;
    // At most this many target units in all, given out where they place
    // the most games: a season of n needing teams places n/2 games a unit.
    int units = unbounded ? std::numeric_limits<int>::max() / 2
                          : static_cast<int>(std::floor((bound + slack) / regularWeight + 1e-6));
    std::vector<int> at;
    for (const Season& season : seasons) {
      at.push_back(season.lower);
      units -= season.lower;
    }
    std::vector<size_t> order(seasons.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
      return seasons[a].needing > seasons[b].needing;
    });
    for (const size_t i : order) {
      const int more = std::max(0, std::min(units, seasons[i].upper - at[i]));
      at[i] += more;
      units -= more;
    }
    int games = exhibitionMost;
    for (size_t i = 0; i < seasons.size(); ++i)
      games += std::max(0, (seasons[i].needing * at[i] - seasons[i].fixedTotal) / 2);
    return games;
  }
};

struct Built {
  std::vector<Column> games;
  std::vector<int> targetCol;      // per spec; -1 in a recalculation
  std::vector<int> exhibitionCol;  // per spec; -1 when none
  Model model;
  GameBound bound;
};

std::pair<int, int> pairKey(int a, int b) {
  return a < b ? std::make_pair(a, b) : std::make_pair(b, a);
}

template <typename T>
bool contains(const std::vector<T>& values, const T& value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

// A map in insertion order, from a small key to the columns under it.
template <typename Key>
class Lists {
 public:
  std::vector<int>& at(const Key& key) {
    const auto found = index_.find(key);
    if (found != index_.end()) return entries_[found->second].second;
    index_.emplace(key, entries_.size());
    entries_.emplace_back(key, std::vector<int>{});
    return entries_.back().second;
  }
  const std::vector<int>* find(const Key& key) const {
    const auto found = index_.find(key);
    return found == index_.end() ? nullptr : &entries_[found->second].second;
  }
  const std::vector<std::pair<Key, std::vector<int>>>& entries() const {
    return entries_;
  }

 private:
  std::vector<std::pair<Key, std::vector<int>>> entries_;
  std::map<Key, size_t> index_;
};

int pairCap(const Spec& spec, int target) {
  int needing = 0;
  for (const int team : spec.active)
    if (spec.fixedRegularOf(team) < target) ++needing;
  return std::max(
      1, static_cast<int>(std::ceil(static_cast<double>(target) / std::max(1, needing - 1))));
}

// Rows as they are built, laid out row by row.
class RowBuilder {
 public:
  void add(std::vector<std::pair<int, double>> entries, double lower, double upper) {
    if (entries.empty()) return;
    std::stable_sort(entries.begin(), entries.end(),
                     [](const auto& a, const auto& b) { return a.first < b.first; });
    // One entry a column, the last given winning, as a Map's set does.
    std::vector<std::pair<int, double>> unique;
    for (const auto& entry : entries) {
      if (!unique.empty() && unique.back().first == entry.first)
        unique.back().second = entry.second;
      else
        unique.push_back(entry);
    }
    for (const auto& [col, value] : unique) {
      index.push_back(col);
      value_.push_back(value);
    }
    start.push_back(static_cast<int>(index.size()));
    lowers.push_back(lower);
    uppers.push_back(upper);
  }
  void ones(const std::vector<int>& cols, double lower, double upper) {
    std::vector<std::pair<int, double>> entries;
    entries.reserve(cols.size());
    for (const int col : cols) entries.emplace_back(col, 1.0);
    add(std::move(entries), lower, upper);
  }
  size_t rows() const { return lowers.size(); }

  std::vector<int> start{0};
  std::vector<int> index;
  std::vector<double> value_;
  std::vector<double> lowers;
  std::vector<double> uppers;
};

struct Item {
  Instant start;
  Instant end;
  const std::vector<int>* cols;
};

// At most one of the items' columns at any instant: one row per start, over
// every column of the items open then.
void oneAtATime(RowBuilder& rows, std::vector<Item> items) {
  std::stable_sort(items.begin(), items.end(),
                   [](const Item& a, const Item& b) { return a.start < b.start; });
  std::vector<Instant> starts;
  for (const Item& item : items)
    if (starts.empty() || starts.back() != item.start) starts.push_back(item.start);
  std::vector<const Item*> open;
  size_t next = 0;
  for (const Instant at : starts) {
    std::vector<const Item*> still;
    for (const Item* item : open)
      if (item->end > at) still.push_back(item);
    open = std::move(still);
    while (next < items.size() && items[next].start <= at) open.push_back(&items[next++]);
    std::vector<int> cols;
    for (const Item* item : open) cols.insert(cols.end(), item->cols->begin(), item->cols->end());
    std::sort(cols.begin(), cols.end());
    cols.erase(std::unique(cols.begin(), cols.end()), cols.end());
    if (cols.size() > 1) rows.ones(cols, -kInfinity, 1);
  }
}

std::vector<int> managersOf(const Input& input, const std::vector<int>& teams) {
  std::vector<int> out;
  for (const int team : teams) {
    const int manager = input.managerOf(team);
    if (manager >= 0 && !contains(out, manager)) out.push_back(manager);
  }
  return out;
}

// Each season's candidate slots: its on-grid slots, the slot starting where
// another season's on-grid slot ends (plus this season's buffer) on a field
// both select, and, for a season sharing a manager with another, the slot
// starting where that season's on-grid slot ends. A recalculation also takes
// the slots that pack against what already holds a field or its teams. Only
// slots the field is free for before any placement.
void addCandidates(const RunContext& context, std::vector<Spec>& specs, Mode mode) {
  const Input& input = *context.input;
  std::vector<std::map<std::pair<int, Instant>, int>> byStart(specs.size());
  std::vector<std::set<int>> fieldsOf(specs.size());
  std::vector<std::vector<const Slot*>> grid(specs.size());
  for (size_t s = 0; s < specs.size(); ++s) {
    const SeasonContext& season = *specs[s].season;
    for (size_t i = 0; i < season.slots.size(); ++i) {
      const Slot& slot = season.slots[i];
      fieldsOf[s].insert(slot.field);
      if (season.fieldFree[i] != 1) continue;
      byStart[s][{slot.field, slot.start}] = static_cast<int>(i);
      if (slot.onGrid) grid[s].push_back(&slot);
    }
  }
  for (size_t s = 0; s < specs.size(); ++s) {
    Spec& spec = specs[s];
    const SeasonContext& season = *spec.season;
    std::set<int> chosen;
    for (const Slot* slot : grid[s]) chosen.insert(slot->index);
    const std::vector<int> mine = managersOf(input, spec.active);
    for (size_t o = 0; o < specs.size(); ++o) {
      if (o == s) continue;
      bool sharesManager = false;
      for (const int manager : managersOf(input, specs[o].active))
        if (contains(mine, manager)) sharesManager = true;
      for (const Slot* slot : grid[o]) {
        if (fieldsOf[s].count(slot->field) > 0) {
          // Games of another size also need the field's switch time.
          const Field* field = context.fieldById(slot->field);
          const Instant switchMs = slot->size == season.settings().fieldSize || field == nullptr
                                       ? 0
                                       : field->switchMinutes * kMinute;
          const auto at = byStart[s].find({slot->field, slot->end + season.bufferMs + switchMs});
          if (at != byStart[s].end()) chosen.insert(at->second);
        }
        if (sharesManager)
          for (const int field : fieldsOf[s]) {
            const auto at = byStart[s].find({field, slot->end});
            if (at != byStart[s].end()) chosen.insert(at->second);
          }
      }
    }
    if (mode == Mode::Required) {
      // Starts packed against the holds: from where one ends, and ending
      // where one starts, a stride at a time while the field is free.
      const Instant gameMs = season.settings().gameMinutes * kMinute;
      const Instant stride = gameMs + season.bufferMs;
      auto chain = [&](int field, Instant from, Instant step) {
        for (int k = 0; k < 64; ++k) {
          const auto at = byStart[s].find({field, from + step * k});
          if (at == byStart[s].end()) return;
          chosen.insert(at->second);
        }
      };
      auto around = [&](int field, Instant start, Instant end, int size, Instant after) {
        const Field* found = context.fieldById(field);
        const Instant switchMs =
            size < 0 || size == season.settings().fieldSize || found == nullptr
                ? 0
                : found->switchMinutes * kMinute;
        chain(field, end + season.bufferMs + switchMs, stride);
        chain(field, start - after - switchMs - gameMs, -stride);
      };
      for (const Booking& booking : input.bookings)
        if (!booking.managerOnly && fieldsOf[s].count(booking.field) > 0)
          around(booking.field, booking.start, booking.end, booking.size, season.bufferMs);
      for (const FixedGame& game : input.fixed) {
        if (fieldsOf[s].count(game.field) == 0) continue;
        const SeasonContext* other = context.seasonOf(game.seasonId);
        around(game.field, game.start, game.end, game.size,
               other != nullptr ? other->bufferMs : season.bufferMs);
      }
      // A team's own holds: the starts at their ends, and ending at their starts.
      auto teamHold = [&](Instant start, Instant end) {
        for (const int field : fieldsOf[s]) {
          chain(field, end, stride);
          chain(field, start - gameMs, -stride);
        }
      };
      for (const Booking& booking : input.bookings)
        for (const int team : booking.teams)
          if (contains(spec.active, team)) {
            teamHold(booking.start, booking.end);
            break;
          }
      for (const FixedGame& game : input.fixed)
        if (contains(spec.active, game.home) || contains(spec.active, game.away))
          teamHold(game.start, game.end);
    }
    spec.candidates.assign(chosen.begin(), chosen.end());
  }
}

struct BuildArgs {
  const std::vector<Bound>* bounds = nullptr;
  Mode mode = Mode::Targets;
  Relaxed relaxed = Relaxed::None;
  // A recalculation's cause solve: at least this many placed per spec.
  const std::vector<int>* atLeast = nullptr;
};

// The model, or nullopt when it has more columns than `maxColumns` (the
// count is then in `columns`).
std::optional<Built> buildModel(const RunContext& context, const std::vector<Spec>& specs,
                                const BuildArgs& args, int64_t maxColumns, int64_t& columns) {
  const Input& input = *context.input;
  Built built;
  // Columns by spec and team, then slot: every column, and the regular and
  // exhibition ones apart for the need rows.
  std::vector<Lists<int>> teamSlots(specs.size() * input.teams.size());
  std::vector<std::vector<int>> regularOf(specs.size() * input.teams.size());
  std::vector<std::vector<int>> exhibitionOf(specs.size() * input.teams.size());
  auto slotKey = [&](size_t s, int team) { return s * input.teams.size() + team; };
  std::vector<Lists<int>> slotCols(specs.size());
  std::vector<Lists<std::pair<int, int>>> pairCols(specs.size());
  std::vector<std::vector<std::vector<int>>> classCols(specs.size());
  auto eligible = [&](const std::vector<uint8_t>* free, int i) {
    if (free == nullptr) return false;
    const uint8_t value = (*free)[i];
    return value == kFree || (args.relaxed == Relaxed::Managers && value == kManagerBusy);
  };
  auto addColumn = [&](size_t s, int i, int home, int away, ColumnKind kind, int item) {
    const int col = static_cast<int>(built.games.size());
    built.games.push_back({static_cast<int>(s), i, home, away, kind, item});
    for (const int team : {home, away}) teamSlots[slotKey(s, team)].at(i).push_back(col);
    slotCols[s].at(i).push_back(col);
    return col;
  };
  // Every game column, in column order, handed to `each`: once to count
  // them, so that a model over the limit allocates none, then to add them.
  auto forEachColumn = [&](auto&& each) {
    for (size_t s = 0; s < specs.size(); ++s) {
      const Spec& spec = specs[s];
      const SeasonContext& season = *spec.season;
      if (args.mode == Mode::Required) {
        for (const int i : spec.candidates)
          for (size_t c = 0; c < spec.classes.size(); ++c) {
            const Matchup& matchup = context.required[spec.classes[c].front()];
            if (!eligible(season.freeOf(matchup.home), i) ||
                !eligible(season.freeOf(matchup.away), i))
              continue;
            each(s, i, matchup.home, matchup.away, ColumnKind::Required, static_cast<int>(c));
          }
        continue;
      }
      for (const int i : spec.candidates)
        for (size_t a = 0; a < spec.active.size(); ++a)
          for (size_t b = a + 1; b < spec.active.size(); ++b) {
            const int home = spec.active[a];
            const int away = spec.active[b];
            if (!eligible(season.freeOf(home), i) || !eligible(season.freeOf(away), i)) continue;
            each(s, i, home, away, ColumnKind::Regular, -1);
          }
      for (size_t k = 0; k < spec.assignments.size(); ++k) {
        const auto [participant, opponent] = spec.assignments[k];
        for (const int i : spec.candidates) {
          if (!eligible(season.freeOf(participant), i) || !eligible(season.freeOf(opponent), i))
            continue;
          each(s, i, participant, opponent, ColumnKind::Exhibition, static_cast<int>(k));
        }
      }
    }
  };
  columns = 0;
  forEachColumn([&](size_t, int, int, int, ColumnKind, int) { ++columns; });
  if (columns > maxColumns) return std::nullopt;
  built.games.reserve(static_cast<size_t>(columns));
  if (args.mode == Mode::Required)
    for (size_t s = 0; s < specs.size(); ++s) classCols[s].resize(specs[s].classes.size());
  forEachColumn([&](size_t s, int i, int home, int away, ColumnKind kind, int item) {
    const int col = addColumn(s, i, home, away, kind, item);
    if (kind == ColumnKind::Required) {
      classCols[s][static_cast<size_t>(item)].push_back(col);
    } else if (kind == ColumnKind::Regular) {
      regularOf[slotKey(s, home)].push_back(col);
      regularOf[slotKey(s, away)].push_back(col);
      pairCols[s].at(pairKey(home, away)).push_back(col);
    } else {
      exhibitionOf[slotKey(s, home)].push_back(col);
    }
  });

  // Targets, parity, short-team and exhibition columns follow the games.
  struct Extra {
    double lower;
    double upper;
    bool integer;
  };
  std::vector<Extra> extra;
  auto column = [&](double lower, double upper, bool integer) {
    extra.push_back({lower, upper, integer});
    return static_cast<int>(built.games.size() + extra.size() - 1);
  };
  std::vector<std::pair<int, double>> cost;
  RowBuilder rows;
  built.targetCol.assign(specs.size(), -1);
  built.exhibitionCol.assign(specs.size(), -1);
  // The weights: a regular game above every exhibition, an exhibition above
  // every game short of what was assigned.
  std::vector<int> deficits;  // the `d` columns
  double exhibitionTotal = 0;
  double deficitTotal = 0;
  if (args.mode == Mode::Targets)
    for (size_t s = 0; s < specs.size(); ++s) {
      const Spec& spec = specs[s];
      if (spec.requestedE == 0) continue;
      exhibitionTotal += (*args.bounds)[s].eUpper;
      for (const int team : spec.active) {
        const int fixed = spec.fixedExhibitionOf(team);
        if (fixed >= (*args.bounds)[s].eUpper) continue;
        const auto found = spec.assigned.find(team);
        const int assigned = found == spec.assigned.end() ? 0 : found->second;
        deficitTotal += std::max(0, (*args.bounds)[s].eUpper - fixed - assigned);
      }
    }
  const double exhibitionWeight = 1 + deficitTotal;
  const double regularWeight = exhibitionWeight * exhibitionTotal + 1;
  built.bound.perColumn = args.mode != Mode::Targets;
  if (args.mode == Mode::Required) {
    built.bound.requiredMost = 0;
    for (const Spec& spec : specs)
      built.bound.requiredMost += static_cast<int>(spec.required.size());
  }
  built.bound.regularWeight = regularWeight;
  built.bound.slack = deficitTotal;

  for (size_t s = 0; s < specs.size(); ++s) {
    const Spec& spec = specs[s];
    if (args.mode == Mode::Required) continue;
    const Bound& bound = (*args.bounds)[s];
    const int g = column(bound.lower, bound.upper, true);
    built.targetCol[s] = g;
    if (args.mode == Mode::Targets) cost.emplace_back(g, regularWeight);
    if (spec.active.empty()) {
      built.bound.seasons.push_back({0, 0, bound.lower, bound.upper});
      continue;
    }
    // A team whose fixed games already reach the most this season may be
    // given needs nothing.
    std::vector<int> needing;
    for (const int team : spec.active)
      if (spec.fixedRegularOf(team) < bound.upper) needing.push_back(team);
    std::vector<std::pair<int, int>> shortCol;
    const bool parity = args.mode == Mode::Targets;
    if (parity && spec.oddAsked) {
      for (const int team : needing) shortCol.emplace_back(team, column(0, 1, true));
      std::vector<int> cols;
      for (const auto& entry : shortCol) cols.push_back(entry.second);
      rows.ones(cols, -kInfinity, 1);
    }
    // Each team plays its need: g less its fixed games, one fewer for the
    // one team an odd-asked season may leave short; a team with none plays
    // no new game. At the floors, at most its need.
    int fixedTotal = 0;
    for (const int team : spec.active) {
      const int fixed = spec.fixedRegularOf(team);
      const std::vector<int>& own = regularOf[slotKey(s, team)];
      if (!contains(needing, team)) {
        rows.ones(own, 0, 0);
        continue;
      }
      fixedTotal += fixed;
      if (!parity) {
        rows.ones(own, -kInfinity, bound.upper - fixed);
        continue;
      }
      std::vector<std::pair<int, double>> entries;
      for (const int col : own) entries.emplace_back(col, 1.0);
      entries.emplace_back(g, -1.0);
      for (const auto& [shortTeam, col] : shortCol)
        if (shortTeam == team) entries.emplace_back(col, 1.0);
      rows.add(std::move(entries), -fixed, -fixed);
    }
    built.bound.seasons.push_back(
        {static_cast<int>(needing.size()), fixedTotal, bound.lower, bound.upper});
    if (parity) {
      // The season's total need is even: a·g − F − short = 2k. The need rows
      // imply it, but HiGHS settles the packed league in seconds with this
      // row and runs out of time without it.
      const int half = column(-kInfinity, kInfinity, true);
      std::vector<std::pair<int, double>> entries{
          {g, static_cast<double>(needing.size())}, {half, -2.0}};
      for (const auto& entry : shortCol) entries.emplace_back(entry.second, -1.0);
      rows.add(std::move(entries), fixedTotal, fixedTotal);
    }
    // Pairs meet at most as often as `regularPairs` allows.
    const int cap = pairCap(spec, bound.capAt);
    for (const auto& [pair, cols] : pairCols[s].entries()) {
      const auto met = spec.met.find(pair);
      rows.ones(cols, -kInfinity, std::max(0, cap - (met == spec.met.end() ? 0 : met->second)));
    }
    if (spec.requestedE == 0) continue;
    built.bound.exhibitionMost += static_cast<int>(spec.assignments.size());
    // Exhibitions: each assigned game once, and each participant its need
    // over its assignments, or all of them when they are fewer.
    std::vector<std::vector<int>> byAssignment(spec.assignments.size());
    for (size_t col = 0; col < built.games.size(); ++col)
      if (built.games[col].spec == static_cast<int>(s) &&
          built.games[col].kind == ColumnKind::Exhibition)
        byAssignment[built.games[col].item].push_back(static_cast<int>(col));
    for (const auto& cols : byAssignment)
      if (cols.size() > 1) rows.ones(cols, -kInfinity, 1);
    int e = -1;
    if (args.mode == Mode::Targets) {
      e = column(bound.eLower, bound.eUpper, true);
      built.exhibitionCol[s] = e;
      cost.emplace_back(e, exhibitionWeight);
    }
    for (const int team : spec.active) {
      const int fixed = spec.fixedExhibitionOf(team);
      const std::vector<int>& own = exhibitionOf[slotKey(s, team)];
      if (fixed >= bound.eUpper) {
        rows.ones(own, 0, 0);
        continue;
      }
      if (args.mode != Mode::Targets) {
        rows.ones(own, -kInfinity, bound.eUpper - fixed);
        continue;
      }
      const auto found = spec.assigned.find(team);
      const int assigned = found == spec.assigned.end() ? 0 : found->second;
      const int deficit = std::max(0, bound.eUpper - fixed - assigned);
      std::vector<std::pair<int, double>> entries;
      for (const int col : own) entries.emplace_back(col, 1.0);
      entries.emplace_back(e, -1.0);
      if (deficit > 0) {
        // d ≥ e − eUpper + deficit: short only by what it was not assigned.
        const int d = column(0, deficit, true);
        deficits.push_back(d);
        cost.emplace_back(d, -1.0);
        entries.emplace_back(d, 1.0);
        rows.add({{d, 1.0}, {e, -1.0}}, deficit - bound.eUpper, kInfinity);
      }
      rows.add(std::move(entries), -fixed, -fixed);
    }
  }
  if (args.mode != Mode::Targets)
    for (size_t col = 0; col < built.games.size(); ++col)
      cost.emplace_back(static_cast<int>(col), 1.0);
  if (args.mode == Mode::Required)
    for (size_t s = 0; s < specs.size(); ++s)
      for (size_t c = 0; c < classCols[s].size(); ++c) {
        const size_t count = specs[s].classes[c].size();
        if (classCols[s][c].size() > count)
          rows.ones(classCols[s][c], -kInfinity, static_cast<double>(count));
      }

  // Fields: one game at a time, the later game's buffer kept, and the
  // switch time between games of different sizes.
  struct FieldItem {
    Instant start;
    Instant end;
    const std::vector<int>* cols;
    int size;
    Instant buffer;
  };
  Lists<int> fieldOrder;
  std::vector<std::vector<FieldItem>> byField(input.fieldNames.size());
  for (size_t s = 0; s < specs.size(); ++s) {
    const SeasonContext& season = *specs[s].season;
    for (const auto& [i, cols] : slotCols[s].entries()) {
      const Slot& slot = season.slots[i];
      fieldOrder.at(slot.field);
      byField[slot.field].push_back(
          {slot.start - season.bufferMs, slot.end, &cols, slot.size, season.bufferMs});
    }
  }
  if (args.relaxed != Relaxed::Fields)
    for (const auto& [fieldId, unused] : fieldOrder.entries()) {
      (void)unused;
      const std::vector<FieldItem>& items = byField[fieldId];
      std::vector<Item> plain;
      for (const FieldItem& item : items) plain.push_back({item.start, item.end, item.cols});
      oneAtATime(rows, plain);
      const Field* field = context.fieldById(fieldId);
      const Instant switchMs = field == nullptr ? 0 : field->switchMinutes * kMinute;
      if (switchMs == 0) continue;
      // In start order, each game against those starting before its switch
      // window closes: no later one can clash with it.
      struct Timed {
        const FieldItem* item;
        Instant at;
      };
      std::vector<Timed> sorted;
      Instant widest = 0;
      for (const FieldItem& item : items) {
        sorted.push_back({&item, item.start + item.buffer});
        widest = std::max(widest, item.buffer);
      }
      std::stable_sort(sorted.begin(), sorted.end(),
                       [](const Timed& x, const Timed& y) { return x.at < y.at; });
      for (size_t a = 0; a < sorted.size(); ++a) {
        const Timed& x = sorted[a];
        for (size_t b = a + 1; b < sorted.size(); ++b) {
          const Timed& y = sorted[b];
          if (y.at >= x.item->end + widest + switchMs) break;
          if (x.item->size == y.item->size) continue;
          if (x.at < y.item->end + x.item->buffer + switchMs &&
              y.at < x.item->end + y.item->buffer + switchMs) {
            std::vector<int> cols = *x.item->cols;
            cols.insert(cols.end(), y.item->cols->begin(), y.item->cols->end());
            rows.ones(cols, -kInfinity, 1);
          }
        }
      }
    }

  // Teams: one game at a time across every season they play in this run;
  // in each season once a day when doubleheaders are never allowed, and
  // within its weekday and weekend maximums.
  Lists<int> managerOrder;
  std::vector<std::vector<Item>> managerItems(input.managers.size());
  Lists<int> teamOrder;
  std::vector<std::vector<Item>> teamItems(input.teams.size());
  std::vector<int> managed(input.managers.size(), 0);
  for (size_t s = 0; s < specs.size(); ++s) {
    const Spec& spec = specs[s];
    const SeasonContext& season = *spec.season;
    const Settings& settings = season.settings();
    std::vector<int> teams = spec.active;
    for (const int team : spec.exhibitionTeams)
      if (!contains(teams, team)) teams.push_back(team);
    for (const int team : teams) {
      const int manager = input.managerOf(team);
      if (manager >= 0) managed[manager]++;
      const Lists<int>& slots = teamSlots[slotKey(s, team)];
      if (slots.entries().empty()) continue;
      teamOrder.at(team);
      for (const auto& [i, cols] : slots.entries())
        teamItems[team].push_back({season.slots[i].start, season.slots[i].end, &cols});
      if (manager >= 0 && args.relaxed != Relaxed::Managers) {
        managerOrder.at(manager);
        for (const auto& [i, cols] : slots.entries())
          managerItems[manager].push_back({season.slots[i].start, season.slots[i].end, &cols});
      }
      if (settings.doubleheaders == Doubleheaders::Never &&
          args.relaxed != Relaxed::Doubleheaders) {
        Lists<int> byDay;
        for (const auto& [i, cols] : slots.entries()) {
          std::vector<int>& list = byDay.at(season.slots[i].point.day);
          list.insert(list.end(), cols.begin(), cols.end());
        }
        for (const auto& [day, cols] : byDay.entries())
          if (cols.size() > 1) rows.ones(cols, -kInfinity, 1);
      }
      if (args.relaxed != Relaxed::WeekParts) {
        Lists<int64_t> byPart;
        std::unordered_map<int64_t, int64_t> left;
        for (const auto& [i, cols] : slots.entries()) {
          const WeekPart portion = gameWeekPart(season.slots[i].point.day);
          if (left.count(portion.key) == 0) {
            int64_t held = 0;
            for (const WeeklyPoint& game : season.weeklyGames)
              if (contains(game.teams, team) && game.point.day >= portion.first &&
                  game.point.day <= portion.last)
                ++held;
            left[portion.key] = weekPartMaximum(settings, portion.weekend) - held;
          }
          std::vector<int>& list = byPart.at(portion.key);
          list.insert(list.end(), cols.begin(), cols.end());
        }
        for (const auto& [key, cols] : byPart.entries()) {
          const int64_t room = left[key];
          if (static_cast<int64_t>(cols.size()) > room)
            rows.ones(cols, -kInfinity, static_cast<double>(std::max<int64_t>(0, room)));
        }
      }
    }
  }
  for (const auto& [team, unused] : teamOrder.entries()) {
    (void)unused;
    oneAtATime(rows, teamItems[team]);
  }
  // Managers: the teams they coach never play at once.
  for (const auto& [manager, unused] : managerOrder.entries()) {
    (void)unused;
    if (managed[manager] > 1) oneAtATime(rows, managerItems[manager]);
  }
  if (args.atLeast != nullptr)
    for (size_t s = 0; s < specs.size(); ++s) {
      std::vector<int> cols;
      for (size_t col = 0; col < built.games.size(); ++col)
        if (built.games[col].spec == static_cast<int>(s)) cols.push_back(static_cast<int>(col));
      if ((*args.atLeast)[s] > 0) {
        if (cols.empty()) cols.push_back(-1);  // an infeasible row, marked below
        rows.ones(cols, (*args.atLeast)[s], kInfinity);
      }
    }

  // Lay out the model.
  const size_t total = built.games.size() + extra.size();
  Model& model = built.model;
  model.colCost.assign(total, 0);
  model.colLower.assign(total, 0);
  model.colUpper.assign(total, 1);
  model.integer.assign(total, 1);
  for (size_t k = 0; k < extra.size(); ++k) {
    model.colLower[built.games.size() + k] = extra[k].lower;
    model.colUpper[built.games.size() + k] = extra[k].upper;
    model.integer[built.games.size() + k] = extra[k].integer ? 1 : 0;
  }
  for (const auto& [col, weight] : cost) model.colCost[col] += weight;
  model.rowLower = std::move(rows.lowers);
  model.rowUpper = std::move(rows.uppers);
  model.rowStart = std::move(rows.start);
  model.rowIndex = std::move(rows.index);
  model.rowValue = std::move(rows.value_);
  return built;
}

// ---------------------------------------------------------------- specs

std::vector<Spec> targetSpecs(const RunContext& context) {
  std::vector<Spec> specs;
  const uint32_t seed = toUint32(context.input->seed);
  for (const SeasonContext& season : context.seasons) {
    Spec spec;
    spec.season = &season;
    for (const int team : season.season->participants)
      if (context.isActive(team)) spec.active.push_back(team);
    const auto counts = fixedCounts(*season.season, context);
    for (const int team : spec.active) {
      const auto found = counts.find(team);
      spec.fixedRegular[team] = found == counts.end() ? 0 : found->second.regular;
      spec.fixedExhibition[team] = found == counts.end() ? 0 : found->second.exhibition;
    }
    std::unordered_map<int, std::vector<int>> played;
    for (const FixedPoint& fixed : season.fixed) {
      const FixedGame& game = context.input->fixed[fixed.game];
      if (!game.exhibition) {
        spec.met[pairKey(game.home, game.away)]++;
        continue;
      }
      played[game.home].push_back(game.away);
      played[game.away].push_back(game.home);
    }
    const Targets requested = requestedTargets(season);
    spec.oddAsked = oddTotal(context, season, requested);
    const Targets floor = floorTargets(context, season);
    // The regular count the field time allows by itself: the solve, not the
    // search's lowering, weighs regular games against exhibition games, so
    // exhibitions are bounded by their request alone.
    const Targets regularOnly{requested.regular, 0};
    const Targets starting = startingTargets(context, season, seed, &regularOnly);
    spec.floor = floor.regular;
    spec.starting = starting.regular;
    spec.floorE = floor.exhibition;
    spec.startingE = requested.exhibition;
    spec.requestedE = requested.exhibition;
    if (spec.requestedE > 0) {
      // Each participant's opponents at the season's request.
      const auto needs = seasonNeeds(*season.season, requested, counts, context);
      for (size_t i = 0; i < season.season->participants.size(); ++i) {
        const int team = season.season->participants[i];
        const auto byTeam = played.find(team);
        for (const int opponent : exhibitionOpponents(
                 static_cast<int>(i), requested.exhibition, season.season->exhibitionTeams,
                 byTeam == played.end() ? std::vector<int>{} : byTeam->second,
                 needs[i].second.exhibition)) {
          if (!context.isActive(opponent)) continue;
          spec.assignments.emplace_back(team, opponent);
          spec.assigned[team]++;
        }
      }
      for (const int team : season.season->exhibitionTeams)
        for (const auto& entry : spec.assignments)
          if (entry.second == team) {
            spec.exhibitionTeams.push_back(team);
            break;
          }
    }
    specs.push_back(std::move(spec));
  }
  addCandidates(context, specs, Mode::Targets);
  return specs;
}

std::vector<Spec> requiredSpecs(const RunContext& context) {
  std::vector<Spec> specs;
  for (const SeasonContext& season : context.seasons) {
    Spec spec;
    spec.season = &season;
    for (size_t r = 0; r < context.required.size(); ++r) {
      const Matchup& matchup = context.required[r];
      if (matchup.seasonId != season.season->id) continue;
      spec.required.push_back(static_cast<int>(r));
      bool joined = false;
      for (auto& members : spec.classes) {
        const Matchup& like = context.required[members.front()];
        if (like.home == matchup.home && like.away == matchup.away &&
            like.exhibition == matchup.exhibition) {
          members.push_back(static_cast<int>(r));
          joined = true;
          break;
        }
      }
      if (!joined) spec.classes.push_back({static_cast<int>(r)});
      for (const int team : {matchup.home, matchup.away})
        if (!contains(spec.active, team)) spec.active.push_back(team);
    }
    if (!spec.required.empty()) specs.push_back(std::move(spec));
  }
  addCandidates(context, specs, Mode::Required);
  return specs;
}

// ---------------------------------------------------------------- solving

class Clock {
 public:
  explicit Clock(const ExactOptions& options) : now_(options.now) {
    if (options.session != nullptr) {
      Session* session = options.session;
      now_ = [session] { return session->now(); };
    } else if (!now_) {
      const auto started = std::chrono::steady_clock::now();
      now_ = [started] {
        return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() -
                                                         started)
            .count();
      };
    }
  }
  double now() const { return now_(); }

 private:
  std::function<double()> now_;
};

// One solve. With a session, a target or placement solve has no time limit
// of its own: it pauses at the session's deadline instead. A cause solve,
// and every solve without a session, stops at `until`.
SolveResult run(const Solver& solve, const Built& built, double until, const Clock& clock,
                Stage stage = Stage::Cause, Session* session = nullptr) {
  throwIfCanceled();
  Limits limits;
  limits.stage = stage;
  limits.gameColumns = static_cast<int>(built.games.size());
  const GameBound* bound = &built.bound;
  limits.boundGames = [bound](double objective) { return (*bound)(objective); };
  if (session != nullptr && stage != Stage::Cause) {
    limits.seconds = kInfinity;
  } else {
    limits.seconds = (until - clock.now()) / 1000;
    if (limits.seconds <= 0) return {SolveStatus::TimeLimit, 0, {}};
  }
  SolveResult result = solve(built.model, limits);
  // An interrupted solve answers nothing worth reading.
  throwIfCanceled();
  if (session != nullptr && session->canceled())
    throw Failure("canceled", "The build was canceled");
  return result;
}

int value(const SolveResult& result, int col) {
  return col < 0 || col >= static_cast<int>(result.colValue.size())
             ? 0
             : static_cast<int>(std::lround(result.colValue[col]));
}

bool chosen(const SolveResult& result, size_t col) {
  return col < result.colValue.size() && result.colValue[col] > 0.5;
}

[[noreturn]] void broken(const SolveResult& result, const char* stage) {
  const std::string why = result.status == SolveStatus::TimeLimit ? "ran out of time"
                          : result.status == SolveStatus::Infeasible
                              ? "found no schedule"
                              : "failed";
  throw Failure("broken", std::string("The ") + stage + " solve " + why);
}

[[noreturn]] void tooLarge(int64_t columns, int64_t limit) {
  Failure failure("broken", "model too large: " + std::to_string(columns) +
                                " columns, over the limit of " + std::to_string(limit));
  failure.columns = columns;
  failure.limit = limit;
  throw failure;
}

Built mustBuild(const RunContext& context, const std::vector<Spec>& specs,
                const BuildArgs& args, int64_t maxColumns) {
  int64_t columns = 0;
  std::optional<Built> built = buildModel(context, specs, args, maxColumns, columns);
  if (!built) tooLarge(columns, maxColumns);
  return std::move(*built);
}

// The next count above `target` the season's parity allows, at most its request.
std::optional<int> nextUp(const RunContext& context, const Spec& spec, int target) {
  const int requested = requestedTargets(*spec.season).regular;
  int up = target + 1;
  if (!spec.oddAsked)
    while (up <= requested && oddTotal(context, *spec.season, {up, 0})) ++up;
  return up <= requested ? std::optional<int>(up) : std::nullopt;
}

// In a solution that ignores managers, the season's team with the most of
// its games in a time its manager is held or overlapping a new game of a
// team with the same manager; ties go to the team's name.
int busiestManagedTeam(const RunContext& context, const std::vector<Spec>& specs,
                       const Built& built, const SolveResult& result, size_t s) {
  const Input& input = *context.input;
  struct Chosen {
    const Column* game;
    const Slot* slot;
  };
  std::vector<Chosen> picked;
  for (size_t col = 0; col < built.games.size(); ++col)
    if (chosen(result, col)) {
      const Column& game = built.games[col];
      picked.push_back({&game, &specs[game.spec].season->slots[game.slot]});
    }
  std::unordered_map<int, int> counts;
  for (const Chosen& a : picked) {
    if (a.game->spec != static_cast<int>(s)) continue;
    for (const int team : {a.game->home, a.game->away}) {
      const int manager = input.managerOf(team);
      if (manager < 0) continue;
      const std::vector<uint8_t>* free = specs[s].season->freeOf(team);
      bool overlaps = free != nullptr && (*free)[a.game->slot] == kManagerBusy;
      for (const Chosen& b : picked) {
        if (overlaps) break;
        if (&b == &a) continue;
        const bool shares = (b.game->home != team && input.managerOf(b.game->home) == manager) ||
                            (b.game->away != team && input.managerOf(b.game->away) == manager);
        if (shares && b.slot->start < a.slot->end && a.slot->start < b.slot->end)
          overlaps = true;
      }
      if (overlaps) counts[team]++;
    }
  }
  std::vector<int> ranked;
  for (const int team : specs[s].active)
    if (counts[team] > 0) ranked.push_back(team);
  std::stable_sort(ranked.begin(), ranked.end(), [&](int a, int b) {
    if (counts[a] != counts[b]) return counts[a] > counts[b];
    return localeLess(input.teamName(a), input.teamName(b));
  });
  return ranked.empty() ? -1 : ranked.front();
}

std::vector<Relaxed> rulesFor(const RunContext& context, const Spec& spec) {
  const Input& input = *context.input;
  std::vector<int> teamsOf(input.managers.size(), 0);
  for (const int manager : input.headCoaches)
    if (manager >= 0) teamsOf[manager]++;
  bool managers = false;
  for (const int team : spec.active) {
    const int manager = input.managerOf(team);
    if (manager >= 0 && teamsOf[manager] > 1) managers = true;
    const std::vector<uint8_t>* free = spec.season->freeOf(team);
    if (free != nullptr)
      for (const int i : spec.candidates)
        if ((*free)[i] == kManagerBusy) managers = true;
  }
  std::vector<Relaxed> rules;
  if (managers) rules.push_back(Relaxed::Managers);
  rules.push_back(Relaxed::WeekParts);
  if (spec.season->settings().doubleheaders == Doubleheaders::Never)
    rules.push_back(Relaxed::Doubleheaders);
  rules.push_back(Relaxed::Fields);
  return rules;
}

// Why season `s` stops short: the first rule whose relaxation lets it have
// one more, every other season held where it settled. Nullopt when a cause
// solve runs out of time, or no single rule is the limit, so the run keeps
// today's cause.
std::optional<Cause> causeOf(const RunContext& context, const std::vector<Spec>& specs,
                             size_t s, GameKind kind, int requested, const BuildArgs& base,
                             const Solver& solve, double until, const Clock& clock,
                             int64_t maxColumns) {
  const Spec& spec = specs[s];
  for (const Relaxed rule : rulesFor(context, spec)) {
    BuildArgs args = base;
    args.relaxed = rule;
    int64_t columns = 0;
    const std::optional<Built> built = buildModel(context, specs, args, maxColumns, columns);
    if (!built) return std::nullopt;
    const SolveResult result = run(solve, *built, until, clock);
    if (result.status == SolveStatus::TimeLimit || result.status == SolveStatus::Error)
      return std::nullopt;
    if (result.status != SolveStatus::Optimal) continue;
    const int season = spec.season->index;
    switch (rule) {
      case Relaxed::WeekParts:
        return Cause{season, kind, Rule::WeekParts, -1, requested};
      case Relaxed::Doubleheaders:
        return Cause{season, kind, Rule::Doubleheaders, -1, requested};
      case Relaxed::Fields:
        return Cause{season, kind,
                     kind == GameKind::Required ? Rule::RequiredUnplaced : Rule::FieldTime, -1,
                     requested};
      default: {
        // Another season's manager held: no team of this one to name.
        const int team = busiestManagedTeam(context, specs, *built, result, s);
        if (team < 0) return std::nullopt;
        return managerCause(*spec.season, kind, requested, team);
      }
    }
  }
  return std::nullopt;
}

// The matchups and slots a solve chose, oriented and keyed.
void settlementOf(const RunContext& context, const std::vector<Spec>& specs,
                  const Built& built, const SolveResult& result, Settlement& settlement) {
  for (size_t s = 0; s < specs.size(); ++s) {
    const Spec& spec = specs[s];
    std::vector<std::pair<int, int>> pairs;
    std::vector<const Slot*> slots;
    size_t regular = 0;
    for (const ColumnKind kind : {ColumnKind::Regular, ColumnKind::Exhibition})
      for (size_t col = 0; col < built.games.size(); ++col) {
        const Column& game = built.games[col];
        if (game.spec != static_cast<int>(s) || game.kind != kind || !chosen(result, col))
          continue;
        pairs.emplace_back(game.home, game.away);
        slots.push_back(&spec.season->slots[game.slot]);
        if (kind == ColumnKind::Regular) ++regular;
      }
    std::vector<const FixedGame*> fixed;
    for (const FixedPoint& point : spec.season->fixed)
      fixed.push_back(&context.input->fixed[point.game]);
    const std::vector<Matchup> keyed = keyMatchups(*context.input, spec.season->season->id,
                                                   orient(pairs, fixed), regular);
    settlement.matchups.insert(settlement.matchups.end(), keyed.begin(), keyed.end());
    settlement.slots.insert(settlement.slots.end(), slots.begin(), slots.end());
  }
}

// At the floors, as many games as fit: what the search did when even the
// floors could not all be reached.
Settlement mostAtFloors(const RunContext& context, const std::vector<Spec>& specs,
                        const Solver& solve, double until, const Clock& clock,
                        int64_t maxColumns, Session* session) {
  std::vector<Bound> bounds;
  for (const Spec& spec : specs)
    bounds.push_back({spec.floor, spec.floor, spec.floor, spec.floorE, spec.floorE});
  BuildArgs args;
  args.bounds = &bounds;
  args.mode = Mode::MostAtFloor;
  const Built built = mustBuild(context, specs, args, maxColumns);
  const SolveResult result = run(solve, built, until, clock, Stage::Targets, session);
  if (result.status != SolveStatus::Optimal) broken(result, "floor");
  Settlement settlement;
  for (const Spec& spec : specs) settlement.targets.push_back({spec.floor, spec.floorE});
  settlementOf(context, specs, built, result, settlement);
  settlement.lowered = true;
  settlement.provenOptimal = result.proven;
  return settlement;
}

// When the `k`th of `n` cause solves must stop. With a session, causes get
// what is left before its deadline, shared evenly and at least
// kCauseMinimumMs each; without one, an even share of what is left of
// `budgetEnd`.
double causeUntil(const Clock& clock, const Session* session, double budgetEnd, size_t k,
                  size_t n) {
  const double share = static_cast<double>(n - k);
  if (session != nullptr)
    return clock.now() + std::max(kCauseMinimumMs, session->remainingMs() / share);
  return clock.now() + (budgetEnd - clock.now()) / share;
}

// The phases a settlement goes through, one at a time, each reported to the
// session (when there is one) as it starts and as it ends, timed from its
// start.
class Phases {
 public:
  Phases(const Session* session, const char* first, const PhaseDetail& detail = {})
      : session_(session) {
    begin(first, detail);
  }
  void begin(const char* name, const PhaseDetail& detail = {}) {
    running_ = name;
    if (session_ == nullptr) return;
    session_->phaseStart(name, detail);
    timer_.emplace(*session_);
  }
  // Ends the running phase, `name`; with none running, nothing.
  void end(const char* name, const PhaseDetail& detail = {}) {
    if (running_ == nullptr) return;
    running_ = nullptr;
    if (session_ != nullptr) session_->phase(name, timer_->ms(), detail);
  }
  // Ends whichever phase is running.
  void endRunning() { end(running_); }
  // Ends one phase and starts the next.
  void next(const char* ended, const PhaseDetail& detail, const char* started) {
    end(ended, detail);
    begin(started);
  }

 private:
  const Session* session_;
  const char* running_ = nullptr;
  std::optional<PhaseTimer> timer_;
};

PhaseDetail sizeOf(const Built& built) {
  PhaseDetail detail;
  detail.columns = static_cast<int64_t>(built.model.colCost.size());
  detail.rows = static_cast<int64_t>(built.model.rowLower.size());
  return detail;
}

PhaseDetail seasonOf(const Spec& spec) {
  PhaseDetail detail;
  detail.seasonName = spec.season->season->name;
  return detail;
}

Settlement settleRequired(const RunContext& context, const Solver& solve,
                          const ExactOptions& options, const Clock& clock) {
  Session* session = options.session;
  // The model's time includes finding each matchup's candidate slots.
  Phases phases(session, "model");
  const std::vector<Spec> specs = requiredSpecs(context);
  Settlement settlement;
  for (const SeasonContext& season : context.seasons)
    settlement.targets.push_back(requestedTargets(season));
  settlement.matchups = context.required;
  settlement.slots.assign(context.required.size(), nullptr);
  if (specs.empty()) {
    phases.end("model");
    return settlement;
  }
  const double deadline = clock.now() + options.deadlineMs;
  BuildArgs args;
  args.mode = Mode::Required;
  const Built built = mustBuild(context, specs, args, options.maxColumns);
  phases.next("model", sizeOf(built), "placement");
  const SolveResult result = run(solve, built, deadline, clock, Stage::Placement, session);
  if (result.status != SolveStatus::Optimal) broken(result, "placement");
  settlement.provenOptimal = result.proven;
  std::vector<int> placed(specs.size(), 0);
  std::vector<std::vector<size_t>> used(specs.size());
  for (size_t s = 0; s < specs.size(); ++s) used[s].assign(specs[s].classes.size(), 0);
  for (size_t col = 0; col < built.games.size(); ++col) {
    if (!chosen(result, col)) continue;
    const Column& game = built.games[col];
    const std::vector<int>& members = specs[game.spec].classes[game.item];
    size_t& next = used[game.spec][game.item];
    if (next >= members.size()) continue;
    settlement.slots[members[next++]] = &specs[game.spec].season->slots[game.slot];
    placed[game.spec]++;
  }
  phases.end("placement");
  // The causes: one more placed, with one rule left out at a time; for a
  // placement not proven the best, the time limit.
  std::vector<size_t> shortSpecs;
  for (size_t s = 0; s < specs.size(); ++s)
    if (placed[s] < static_cast<int>(specs[s].required.size())) shortSpecs.push_back(s);
  const double budgetEnd = clock.now() + options.causeBudgetMs;
  for (size_t k = 0; k < shortSpecs.size(); ++k) {
    const size_t s = shortSpecs[k];
    const int count = static_cast<int>(specs[s].required.size());
    const int season = specs[s].season->index;
    if (!settlement.provenOptimal) {
      settlement.causes[{season, GameKind::Required}] =
          Cause{season, GameKind::Required, Rule::TimeLimit, -1, count};
      continue;
    }
    Phases cause(session, "cause", seasonOf(specs[s]));
    const double until = causeUntil(clock, session, budgetEnd, k, shortSpecs.size());
    std::vector<int> atLeast = placed;
    atLeast[s]++;
    BuildArgs more = args;
    more.atLeast = &atLeast;
    if (const auto found = causeOf(context, specs, s, GameKind::Required, count, more, solve,
                                   until, clock, options.maxColumns))
      settlement.causes[{season, GameKind::Required}] = *found;
    cause.end("cause", seasonOf(specs[s]));
  }
  return settlement;
}

}  // namespace

// localeCompare for team names: punctuation and spaces before digits before
// letters, letters without case first, then lower case before upper, as
// ICU's root collation orders plain names.
bool localeLess(const std::string& a, const std::string& b) {
  auto primary = [](unsigned char c) -> int {
    if (c >= '0' && c <= '9') return 1000 + c;
    if (c >= 'a' && c <= 'z') return 2000 + (c - 'a') * 2;
    if (c >= 'A' && c <= 'Z') return 2000 + (c - 'A') * 2;
    if (c >= 0x80) return 3000 + c;
    return c;
  };
  const size_t length = std::min(a.size(), b.size());
  for (size_t i = 0; i < length; ++i) {
    const int x = primary(static_cast<unsigned char>(a[i]));
    const int y = primary(static_cast<unsigned char>(b[i]));
    if (x != y) return x < y;
  }
  if (a.size() != b.size()) return a.size() < b.size();
  for (size_t i = 0; i < length; ++i) {
    const bool lowerA = a[i] >= 'a' && a[i] <= 'z';
    const bool lowerB = b[i] >= 'a' && b[i] <= 'z';
    if (lowerA != lowerB) return lowerA;
  }
  return a < b;
}

namespace {

// What a solve under a session watches through HiGHS's callbacks: the best
// schedule found so far, and the admin's answer at the time limit.
//
// The deadline is read wherever HiGHS calls back: branch and bound's
// interrupt check, and the simplex and interior-point ones, which an LP
// solve reaches. A MIP's presolve and the LPs it solves inside branch and
// bound (the root LP among them) run in HiGHS's own instance, which calls
// back only through the MIP check, so a pause that falls due there comes
// at the next MIP check after them.
struct Watch {
  Session* session = nullptr;
  const Limits* limits = nullptr;
  std::optional<int> best;
  // Use was answered before any schedule was found: stop at the first, or
  // at `fallback`, one more limit after the answer.
  bool useWanted = false;
  double fallback = -1;
  // Stopped with its incumbent.
  bool used = false;
  // Stopped at the fallback with no schedule: the time limit's failure.
  bool timedOut = false;

  int bound(double objective) const {
    return limits->boundGames ? limits->boundGames(objective) : 0;
  }

  // A schedule that places no game (HiGHS's first, trivial one) is not one
  // to offer: until a better one comes there is no best.
  void improved(const HighsCallbackOutput& out) {
    int games = 0;
    const size_t columns =
        std::min(out.mip_solution.size(), static_cast<size_t>(limits->gameColumns));
    for (size_t col = 0; col < columns; ++col)
      if (out.mip_solution[col] > 0.5) ++games;
    if (games == 0) return;
    best = games;
    session->progress(games, bound(out.mip_dual_bound));
  }

  // `dualBound` is the MIP's bound, or infinite where there is none yet (an
  // LP's callbacks).
  void check(double dualBound, HighsCallbackInput& in) {
    if (useWanted) {
      if (best) {
        stop(in, true);
      } else if (session->now() >= fallback) {
        timedOut = true;
        stop(in, false);
      }
      return;
    }
    if (!session->due()) return;
    // With no schedule yet, Use waits for the first: the pause offers
    // going on or canceling, and Use is the wait for one.
    switch (session->pause(limits->stage, best, bound(dualBound))) {
      case Decision::Continue:
        return;
      case Decision::Use:
        if (best) {
          stop(in, true);
        } else {
          useWanted = true;
          fallback = session->now() + session->limitMs();
        }
        return;
      default:
        stop(in, false);
    }
  }

  void stop(HighsCallbackInput& in, bool withIncumbent) {
    in.user_interrupt = true;
    used = withIncumbent;
  }
};

void onCallback(int type, const std::string&, const HighsCallbackOutput* out,
                HighsCallbackInput* in, void* data) {
  auto* watch = static_cast<Watch*>(data);
  if (type == kCallbackMipImprovingSolution) {
    // HiGHS takes no interrupt here; the next interrupt check does.
    if (watch != nullptr && out != nullptr) watch->improved(*out);
    return;
  }
  if (in == nullptr) return;
  if (canceled()) {
    in->user_interrupt = true;
    return;
  }
  if (watch == nullptr) return;
  if (type == kCallbackMipInterrupt) {
    if (out != nullptr) watch->check(out->mip_dual_bound, *in);
  } else {
    watch->check(kHighsInf, *in);
  }
}

}  // namespace

Solver highsSolver(double seed, Session* session) {
  return [seed, session](const Model& model, const Limits& limits) -> SolveResult {
    try {
      const HighsInt cols = static_cast<HighsInt>(model.colCost.size());
      const HighsInt rows = static_cast<HighsInt>(model.rowLower.size());
      HighsLp lp;
      lp.num_col_ = cols;
      lp.num_row_ = rows;
      lp.sense_ = ObjSense::kMaximize;
      lp.col_cost_ = model.colCost;
      lp.col_lower_ = model.colLower;
      lp.col_upper_ = model.colUpper;
      lp.row_lower_ = model.rowLower;
      lp.row_upper_ = model.rowUpper;
      lp.a_matrix_.format_ = MatrixFormat::kRowwise;
      lp.a_matrix_.num_col_ = cols;
      lp.a_matrix_.num_row_ = rows;
      lp.a_matrix_.start_.assign(model.rowStart.begin(), model.rowStart.end());
      lp.a_matrix_.index_.assign(model.rowIndex.begin(), model.rowIndex.end());
      lp.a_matrix_.value_ = model.rowValue;
      lp.integrality_.resize(cols);
      for (HighsInt j = 0; j < cols; ++j)
        lp.integrality_[j] =
            model.integer[j] == 1 ? HighsVarType::kInteger : HighsVarType::kContinuous;
      // A row with no column of the model (a recalculation's cause solve
      // asking for a game no column can give) is plainly infeasible.
      for (const int col : model.rowIndex)
        if (col < 0) return {SolveStatus::Infeasible, 0, {}};
      // A target or placement solve under a session pauses at its deadline,
      // so HiGHS has no limit of its own; a cause solve has one.
      const bool pausable = session != nullptr && limits.stage != Stage::Cause;
      Watch watch;
      watch.session = session;
      watch.limits = &limits;
      Highs highs;
      highs.setOptionValue("output_flag", false);
      highs.setOptionValue("threads", 1);
      highs.setOptionValue("random_seed",
                           static_cast<HighsInt>(std::max(0.0, std::min(seed, 2147483647.0))));
      highs.setOptionValue("mip_rel_gap", 0.0);
      highs.setOptionValue("time_limit", pausable ? kHighsInf : std::max(0.001, limits.seconds));
      if (highs.passModel(lp) == HighsStatus::kError) return {SolveStatus::Error, 0, {}};
      if (pausable) session->startSolve();
      // Cancel reaches the solve wherever it is: branch and bound, or an LP
      // by either method. Read on this thread, which runs the solve.
      highs.setCallback(onCallback, pausable ? &watch : nullptr);
      for (const HighsCallbackType type :
           {kCallbackMipInterrupt, kCallbackSimplexInterrupt, kCallbackIpmInterrupt})
        highs.startCallback(type);
      if (pausable) highs.startCallback(kCallbackMipImprovingSolution);
      highs.run();
      const HighsModelStatus status = highs.getModelStatus();
      if (status == HighsModelStatus::kOptimal)
        return {SolveStatus::Optimal, highs.getInfo().objective_function_value,
                highs.getSolution().col_value};
      // Stopped at the time limit with its incumbent: a schedule, not
      // proven the best.
      if (watch.used && highs.getSolution().value_valid) {
        SolveResult result{SolveStatus::Optimal, highs.getInfo().objective_function_value,
                           highs.getSolution().col_value};
        result.proven = false;
        return result;
      }
      // The targets bound the objective, so these models are never
      // unbounded: presolve's "unbounded or infeasible" is infeasible.
      if (status == HighsModelStatus::kInfeasible ||
          status == HighsModelStatus::kUnboundedOrInfeasible)
        return {SolveStatus::Infeasible, 0, {}};
      if (status == HighsModelStatus::kTimeLimit || watch.timedOut)
        return {SolveStatus::TimeLimit, 0, {}};
      return {SolveStatus::Error, 0, {}};
    } catch (...) {
      return {SolveStatus::Error, 0, {}};
    }
  };
}

std::optional<TargetModel> targetModel(const RunContext& context, int64_t maxColumns) {
  if (context.hasRequired || context.seasons.empty()) return std::nullopt;
  const std::vector<Spec> specs = targetSpecs(context);
  std::vector<Bound> bounds;
  for (const Spec& spec : specs)
    bounds.push_back({std::min(spec.floor, spec.starting), spec.starting, spec.starting,
                      std::min(spec.floorE, spec.startingE), spec.startingE});
  BuildArgs args;
  args.bounds = &bounds;
  int64_t columns = 0;
  std::optional<Built> built = buildModel(context, specs, args, maxColumns, columns);
  if (!built) return std::nullopt;
  return TargetModel{std::move(built->model), built->targetCol};
}

Settlement exactSettle(const RunContext& context, const Solver& solve,
                       const ExactOptions& options) {
  const Clock clock(options);
  if (context.hasRequired) return settleRequired(context, solve, options, clock);
  Settlement settlement;
  if (context.seasons.empty()) return settlement;
  Session* session = options.session;
  Phases phases(session, "model");
  const std::vector<Spec> specs = targetSpecs(context);
  const double deadline = clock.now() + options.deadlineMs;
  // The most games at every season's floor settles the targets and places
  // them in one solve, which ends the step it is reached from: the targets,
  // or the placement when no lowering lets it through.
  auto floors = [&] {
    Settlement settled =
        mostAtFloors(context, specs, solve, deadline, clock, options.maxColumns, session);
    phases.endRunning();
    return settled;
  };

  // The targets: as many games for every team as fit together.
  std::vector<Bound> bounds;
  for (const Spec& spec : specs)
    bounds.push_back({std::min(spec.floor, spec.starting), spec.starting, spec.starting,
                      std::min(spec.floorE, spec.startingE), spec.startingE});
  BuildArgs args;
  args.bounds = &bounds;
  // With exhibition games, regular games first: every regular game weighs
  // above every exhibition, so the regular counts are settled alone, by the
  // model a run without exhibitions has, and the exhibitions then by a solve
  // with them fixed. Settled together, the packed league's first solve took
  // four times as long.
  bool exhibitions = false;
  for (const Spec& spec : specs)
    if (spec.requestedE > 0) exhibitions = true;
  // Whether every target and placement solve was proven, not stopped at the
  // time limit with its incumbent.
  bool proven = true;
  if (exhibitions) {
    std::vector<Spec> regularOnly = specs;
    for (Spec& spec : regularOnly) {
      spec.requestedE = 0;
      spec.assignments.clear();
      spec.assigned.clear();
      spec.exhibitionTeams.clear();
    }
    const Built alone = mustBuild(context, regularOnly, args, options.maxColumns);
    phases.next("model", sizeOf(alone), "targets");
    const SolveResult regular = run(solve, alone, deadline, clock, Stage::Targets, session);
    if (regular.status == SolveStatus::Infeasible) return floors();
    if (regular.status != SolveStatus::Optimal) broken(regular, "targets");
    proven = proven && regular.proven;
    for (size_t s = 0; s < specs.size(); ++s)
      bounds[s].lower = bounds[s].upper = value(regular, alone.targetCol[s]);
  }
  const Built first = mustBuild(context, specs, args, options.maxColumns);
  if (!exhibitions) phases.next("model", sizeOf(first), "targets");
  const SolveResult settled = run(solve, first, deadline, clock, Stage::Targets, session);
  if (settled.status == SolveStatus::Infeasible) return floors();
  if (settled.status != SolveStatus::Optimal) broken(settled, "targets");
  proven = proven && settled.proven;
  std::vector<int> targets;
  std::vector<int> exhibition;
  for (size_t s = 0; s < specs.size(); ++s) {
    targets.push_back(value(settled, first.targetCol[s]));
    exhibition.push_back(first.exhibitionCol[s] < 0 ? std::min(specs[s].floorE, specs[s].startingE)
                                                    : value(settled, first.exhibitionCol[s]));
  }
  phases.next("targets", {}, "placement");

  // The placement at those targets, with the pair caps they allow.
  auto boundsAt = [&](const std::vector<int>& at) {
    std::vector<Bound> out;
    for (size_t s = 0; s < specs.size(); ++s)
      out.push_back({at[s], at[s], at[s], exhibition[s], exhibition[s]});
    return out;
  };
  std::optional<Built> placedModel;
  SolveResult placed;
  auto place = [&](const std::vector<int>& at) {
    const std::vector<Bound> fixed = boundsAt(at);
    BuildArgs placing;
    placing.bounds = &fixed;
    Built built = mustBuild(context, specs, placing, options.maxColumns);
    SolveResult result = run(solve, built, deadline, clock, Stage::Placement, session);
    return std::make_pair(std::move(built), std::move(result));
  };
  // With no season's pair cap tightened, the first answer is already the
  // placement, and is not solved again.
  bool done = true;
  for (size_t s = 0; s < specs.size(); ++s)
    if (pairCap(specs[s], targets[s]) != pairCap(specs[s], specs[s].starting)) done = false;
  if (done) {
    placedModel = first;
    placed = settled;
  }
  // Set when `targets` is a lone trial already found infeasible.
  bool knownInfeasible = false;
  while (!placedModel) {
    if (!knownInfeasible) {
      auto [built, result] = place(targets);
      if (result.status == SolveStatus::Optimal) {
        placedModel = std::move(built);
        placed = std::move(result);
        break;
      }
      if (result.status != SolveStatus::Infeasible) broken(result, "placement");
    }
    knownInfeasible = false;
    // Only the pair caps changed, so a season they tightened is to blame.
    // Each is lowered alone, in run order, and the first that lets the
    // placement through is kept; when none does alone, the first stays
    // lowered and the rest are tried again.
    std::vector<size_t> tightened;
    for (size_t s = 0; s < specs.size(); ++s)
      if (targets[s] > specs[s].floor &&
          pairCap(specs[s], targets[s]) < pairCap(specs[s], specs[s].starting))
        tightened.push_back(s);
    if (tightened.empty()) return floors();
    auto lower = [&](const std::vector<int>& at, size_t s) {
      Targets lowered{at[s], 0};
      lowerTargets(context, *specs[s].season, lowered);
      std::vector<int> out = at;
      out[s] = lowered.regular;
      return out;
    };
    if (tightened.size() > 1)
      for (const size_t s : tightened) {
        const std::vector<int> trial = lower(targets, s);
        auto [built, result] = place(trial);
        if (result.status == SolveStatus::Optimal) {
          targets = trial;
          placedModel = std::move(built);
          placed = std::move(result);
          break;
        }
        if (result.status != SolveStatus::Infeasible) broken(result, "placement");
      }
    if (placedModel) break;
    targets = lower(targets, tightened.front());
    // That was the first lone trial: no need to solve it again.
    knownInfeasible = tightened.size() > 1;
  }
  proven = proven && placed.proven;
  settlement.provenOptimal = proven;

  for (size_t s = 0; s < specs.size(); ++s) settlement.targets.push_back({targets[s], exhibition[s]});
  settlementOf(context, specs, *placedModel, placed, settlement);
  for (size_t s = 0; s < specs.size(); ++s)
    if (targets[s] < specs[s].starting || exhibition[s] < specs[s].startingE)
      settlement.lowered = true;
  phases.end("placement");

  // The causes: one count higher, with one rule left out at a time. Each
  // short count gets an even share of the time still left; a count not
  // proven the best is short by the time limit, and is not solved.
  struct Short {
    size_t s;
    GameKind kind;
    int up;
  };
  std::vector<Short> shortCounts;
  for (size_t s = 0; s < specs.size(); ++s) {
    if (specs[s].active.empty()) continue;
    const Targets requested = requestedTargets(*specs[s].season);
    if (targets[s] < requested.regular)
      if (const auto up = nextUp(context, specs[s], targets[s]))
        shortCounts.push_back({s, GameKind::Regular, *up});
    if (exhibition[s] < requested.exhibition)
      shortCounts.push_back({s, GameKind::Exhibition, exhibition[s] + 1});
  }
  const double budgetEnd = clock.now() + options.causeBudgetMs;
  for (size_t k = 0; k < shortCounts.size(); ++k) {
    const Short& entry = shortCounts[k];
    const Targets requested = requestedTargets(*specs[entry.s].season);
    const int asked = entry.kind == GameKind::Regular ? requested.regular : requested.exhibition;
    const int season = specs[entry.s].season->index;
    if (!proven) {
      settlement.causes[{season, entry.kind}] =
          Cause{season, entry.kind, Rule::TimeLimit, -1, asked};
      continue;
    }
    Phases cause(session, "cause", seasonOf(specs[entry.s]));
    const double until = causeUntil(clock, session, budgetEnd, k, shortCounts.size());
    std::vector<Bound> up;
    for (size_t o = 0; o < specs.size(); ++o) {
      const int regular =
          o == entry.s && entry.kind == GameKind::Regular ? entry.up : targets[o];
      const int exhibitions =
          o == entry.s && entry.kind == GameKind::Exhibition ? entry.up : exhibition[o];
      up.push_back({regular, regular, regular, exhibitions, exhibitions});
    }
    BuildArgs more;
    more.bounds = &up;
    if (const auto found = causeOf(context, specs, entry.s, entry.kind, asked, more, solve, until,
                                   clock, options.maxColumns))
      settlement.causes[{season, entry.kind}] = *found;
    cause.end("cause", seasonOf(specs[entry.s]));
  }
  return settlement;
}

}  // namespace teamstation::scheduler
