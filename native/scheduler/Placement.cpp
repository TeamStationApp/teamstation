// Scoring and the polish of an exact placement: score.ts and placement.ts
// (`placeFromSteps`, `polishSteps`).
#include <algorithm>
#include <cmath>

#include "Engine.h"

namespace teamstation::scheduler {

const Order kTrueOrder{kUnplaced, kDoubleheaders, kPreference, kTimeOfDay,
                       kSpacing,  kWeekday,       kScarcity};
const std::vector<Order> kWeightings{
    kTrueOrder,
    {kUnplaced, kDoubleheaders, kPreference, kTimeOfDay, kSpacing, kScarcity,
     kWeekday},
    {kUnplaced, kDoubleheaders, kPreference, kSpacing, kWeekday, kScarcity,
     kTimeOfDay}};

namespace {
constexpr double kEpsilon = 1e-9;
}

int compareScores(const Score& a, const Score& b, const Order& order) {
  for (const int term : order) {
    const double difference = a[term] - b[term];
    if (difference < -kEpsilon) return -1;
    if (difference > kEpsilon) return 1;
  }
  return 0;
}

double mixDeviation(const int* counts, int length, int games, const int* supply,
                    int supplyGames) {
  if (games == 0 || supplyGames == 0) return 0;
  double deviation = 0;
  for (int i = 0; i < length; ++i)
    deviation += std::abs(static_cast<double>(counts[i]) / games -
                          static_cast<double>(supply[i]) / supplyGames);
  return deviation;
}

// ------------------------------------------------------------- the tally

void TeamTally::add(const GamePoint& point) {
  const auto at = std::lower_bound(days.begin(), days.end(), point.day);
  if (at != days.end() && *at == point.day) ++doubleheaders;
  days.insert(at, point.day);
  ++games;
  timeOfDay[point.timeOfDay]++;
  weekdays[point.weekday]++;
  cached_ = false;
}

void TeamTally::remove(const GamePoint& point) {
  const auto at = std::lower_bound(days.begin(), days.end(), point.day);
  const auto next = days.erase(at);
  if (next != days.end() && *next == point.day) --doubleheaders;
  --games;
  timeOfDay[point.timeOfDay]--;
  weekdays[point.weekday]--;
  cached_ = false;
}

std::vector<int> TeamTally::spanDays() const {
  std::vector<int> out;
  for (const int day : days)
    if (day >= firstDay && day <= lastDay) out.push_back(day);
  return out;
}

int TeamTally::backToBack(const std::vector<int>& span) const {
  int count = 0;
  const int length = static_cast<int>(span.size());
  for (int i = 0; i < length; ++i) {
    const int day = span[i];
    int j = i;
    while (j > 0 && span[j - 1] == day) --j;
    int k = i;
    while (k < length - 1 && span[k + 1] == day) ++k;
    if ((j > 0 && span[j - 1] == day - 1) || (k < length - 1 && span[k + 1] == day + 1))
      ++count;
  }
  return count;
}

std::vector<int> TeamTally::gaps() const {
  const std::vector<int> span = spanDays();
  if (span.empty()) return {};
  std::vector<int> out;
  if (span.front() > firstDay) out.push_back(span.front() - firstDay);
  for (size_t i = 1; i < span.size(); ++i)
    if (span[i] != span[i - 1]) out.push_back(span[i] - span[i - 1]);
  if (lastDay > span.back()) out.push_back(lastDay - span.back());
  return out;
}

int TeamTally::unevenness(const std::vector<int>& span) const {
  if (planned == 0) return static_cast<int>(span.size());
  const int64_t length = static_cast<int64_t>(lastDay) - firstDay + 1;
  std::vector<int> counts(static_cast<size_t>(planned), 0);
  for (const int day : span) {
    const int64_t slice = floorDiv((static_cast<int64_t>(day) - firstDay) * planned, length);
    counts[static_cast<size_t>(std::min<int64_t>(planned - 1, slice))]++;
  }
  int penalty = 0;
  for (const int count : counts) penalty += std::abs(count - 1);
  return penalty;
}

int TeamTally::spacing() const {
  const std::vector<int> span = spanDays();
  return backToBack(span) + unevenness(span);
}

const std::array<double, 4>& TeamTally::terms(const Supply& supply) {
  if (!cached_) {
    terms_ = {static_cast<double>(doubleheaders),
              mixDeviation(timeOfDay.data(), 3, games, supply.timeOfDay.data(),
                           supply.games),
              static_cast<double>(spacing()),
              mixDeviation(weekdays.data(), 7, games, supply.weekdays.data(),
                           supply.games)};
    cached_ = true;
  }
  return terms_;
}

// ------------------------------------------------------------ the ledger

SeasonLedger::SeasonLedger(const RunContext& context, const SeasonContext& season,
                           int games, const std::unordered_map<int, int>& planned)
    : season(&season), games(games) {
  for (const int team : season.teams) {
    const auto found = planned.find(team);
    TeamTally tally(found == planned.end() ? 0 : found->second, season.firstDay,
                    season.lastDay);
    const auto at = at_.find(team);
    if (at != at_.end()) {
      tallies[at->second].second = tally;
      continue;
    }
    at_[team] = tallies.size();
    tallies.emplace_back(team, tally);
  }
  for (const FixedPoint& fixed : season.fixed) {
    const FixedGame& game = context.input->fixed[fixed.game];
    if (TeamTally* home = tally(game.home)) home->add(fixed.point);
    if (TeamTally* away = tally(game.away)) away->add(fixed.point);
  }
}

TeamTally* SeasonLedger::tally(int team) {
  const auto found = at_.find(team);
  return found == at_.end() ? nullptr : &tallies[found->second].second;
}

void SeasonLedger::add(int home, int away, const GamePoint& point, int scarce) {
  if (TeamTally* tally = this->tally(home)) tally->add(point);
  if (TeamTally* tally = this->tally(away)) tally->add(point);
  ++placed;
  scarcity += scarce;
}

void SeasonLedger::remove(int home, int away, const GamePoint& point, int scarce) {
  if (TeamTally* tally = this->tally(home)) tally->remove(point);
  if (TeamTally* tally = this->tally(away)) tally->remove(point);
  --placed;
  scarcity -= scarce;
}

Score SeasonLedger::score() {
  const Settings& settings = season->settings();
  const bool counted = settings.doubleheaders == Doubleheaders::IfNecessary;
  double doubleheaders = 0;
  double timeOfDay = 0;
  double spacing = 0;
  double weekday = 0;
  double nonpreferred = 0;
  for (auto& [team, tally] : tallies) {
    const int weekend = tally.weekdays[0] + tally.weekdays[6];
    nonpreferred += settings.preferWeekdays ? weekend : tally.games - weekend;
    const auto& terms = tally.terms(season->supply);
    if (counted) doubleheaders += terms[0];
    timeOfDay += terms[1];
    spacing += terms[2];
    weekday += terms[3];
  }
  return {static_cast<double>(games - placed), doubleheaders, timeOfDay, spacing,
          weekday, static_cast<double>(scarcity), nonpreferred};
}

int searchBudget(int games) { return std::min(20'000, 400 * games); }

namespace {

// A list that adds, removes and picks at random in constant time.
class Pool {
 public:
  void add(int item) {
    at_[item] = items.size();
    items.push_back(item);
  }
  void remove(int item) {
    const auto found = at_.find(item);
    if (found == at_.end()) return;
    const size_t at = found->second;
    const int last = items.back();
    items.pop_back();
    if (last != item) {
      items[at] = last;
      at_[last] = at;
    }
    at_.erase(item);
  }
  int pick(const Random& random) const {
    return items[static_cast<size_t>(randomIndex(random, static_cast<int>(items.size())))];
  }
  std::vector<int> items;

 private:
  std::unordered_map<int, size_t> at_;
};

class Search {
 public:
  struct Game {
    const Matchup* matchup;
    const SeasonContext* season;
    int ledger;
    int placed;  // the season's pool
    const Slot* slot = nullptr;
  };

  Search(const RunContext& context, const std::vector<Matchup>& matchups,
         const Order& order)
      : context(context), order(order), occupancy(context) {
    std::unordered_map<std::string, int> bySeason;
    for (const SeasonContext& season : context.seasons) {
      std::unordered_map<int, int> planned;
      for (const FixedPoint& fixed : season.fixed)
        if (fixed.point.day >= season.firstDay && fixed.point.day <= season.lastDay) {
          const FixedGame& game = context.input->fixed[fixed.game];
          planned[game.home]++;
          planned[game.away]++;
        }
      int count = 0;
      for (const Matchup& matchup : matchups)
        if (matchup.seasonId == season.season->id) {
          planned[matchup.home]++;
          planned[matchup.away]++;
          ++count;
        }
      bySeason[season.season->id] = static_cast<int>(ledgers.size());
      ledgers.emplace_back(context, season, count, planned);
      pools.emplace_back();
    }
    for (size_t i = 0; i < matchups.size(); ++i) {
      const auto found = bySeason.find(matchups[i].seasonId);
      if (found == bySeason.end())
        throw Failure("broken", "No season " + matchups[i].seasonId + " in the run");
      games.push_back({&matchups[i], &context.seasons[found->second], found->second,
                       found->second});
      unplaced.add(static_cast<int>(i));
    }
  }

  void put(int i, const Slot* slot) {
    Game& game = games[i];
    occupancy.place(i, *game.season, game.matchup->home, game.matchup->away, *slot);
    ledgers[game.ledger].add(game.matchup->home, game.matchup->away, slot->point,
                             slot->scarcity);
    game.slot = slot;
    unplaced.remove(i);
    pools[game.placed].add(i);
    anyPlaced.add(i);
  }

  const Slot* take(int i) {
    Game& game = games[i];
    const Slot* slot = game.slot;
    occupancy.unplace(i, *game.season, game.matchup->home, game.matchup->away, *slot);
    ledgers[game.ledger].remove(game.matchup->home, game.matchup->away, slot->point,
                                slot->scarcity);
    game.slot = nullptr;
    pools[game.placed].remove(i);
    anyPlaced.remove(i);
    unplaced.add(i);
    return slot;
  }

  bool fits(int i, const Slot& slot) const {
    const Game& game = games[i];
    return occupancy.fits(*game.season, game.matchup->home, game.matchup->away, slot);
  }

  const Slot* earliestIn(int i, const SlotGroup& group) const {
    const SeasonContext& season = *games[i].season;
    for (const bool onGrid : {true, false})
      for (const int index : group.slots) {
        const Slot& slot = season.slots[index];
        if (slot.onGrid == onGrid && fits(i, slot)) return &slot;
      }
    return nullptr;
  }

  void tryPlacing(const Random& random) {
    const int i = unplaced.pick(random);
    const auto& groups = games[i].season->groups;
    if (groups.empty()) return;
    const Slot* slot =
        earliestIn(i, groups[randomIndex(random, static_cast<int>(groups.size()))]);
    if (slot != nullptr) put(i, slot);
  }

  void tryMoving(const Random& random, int i) {
    SeasonLedger& ledger = ledgers[games[i].ledger];
    const Score before = ledger.score();
    const Slot* from = take(i);
    const auto& groups = games[i].season->groups;
    const Slot* slot =
        earliestIn(i, groups[randomIndex(random, static_cast<int>(groups.size()))]);
    if (slot != nullptr && slot != from) {
      put(i, slot);
      if (compareScores(ledger.score(), before, order) <= 0) return;
      take(i);
    }
    put(i, from);
  }

  void trySwapping(const Random& random, int i) {
    const int j = pools[games[i].placed].pick(random);
    if (j == i) return;
    SeasonLedger& ledger = ledgers[games[i].ledger];
    const Score before = ledger.score();
    const Slot* mine = take(i);
    const Slot* theirs = take(j);
    if (fits(i, *theirs)) {
      put(i, theirs);
      if (fits(j, *mine)) {
        put(j, mine);
        if (compareScores(ledger.score(), before, order) <= 0) return;
        take(j);
      }
      take(i);
    }
    put(i, mine);
    put(j, theirs);
  }

  Score total() {
    Score total{};
    for (SeasonLedger& ledger : ledgers) {
      const Score score = ledger.score();
      for (int t = 0; t < kTerms; ++t) total[t] += score[t];
    }
    return total;
  }

  const RunContext& context;
  const Order& order;
  Occupancy occupancy;
  std::vector<Game> games;
  std::vector<SeasonLedger> ledgers;
  std::vector<Pool> pools;
  Pool unplaced;
  Pool anyPlaced;
};

Placement polish(Search& search, const std::vector<Matchup>& matchups,
                 const Random& random, int budget) {
  for (int step = 0; step < budget; ++step) {
    const double roll = random();
    if (!search.unplaced.items.empty() && roll < 0.2) {
      search.tryPlacing(random);
      continue;
    }
    if (search.anyPlaced.items.empty()) break;
    const int i = search.anyPlaced.pick(random);
    if (roll < 0.7)
      search.tryMoving(random, i);
    else
      search.trySwapping(random, i);
  }
  Placement placement;
  placement.matchups = matchups;
  for (const Search::Game& game : search.games) placement.slots.push_back(game.slot);
  placement.score = search.total();
  for (SeasonLedger& ledger : search.ledgers) placement.ledgers.push_back(ledger);
  return placement;
}

}  // namespace

std::optional<Placement> placeFrom(const RunContext& context,
                                   const std::vector<Matchup>& matchups,
                                   const std::vector<const Slot*>& slots,
                                   uint32_t seed, const Order& order) {
  Search search(context, matchups, order);
  for (size_t i = 0; i < slots.size(); ++i) {
    if (slots[i] == nullptr) continue;
    if (!search.fits(static_cast<int>(i), *slots[i])) return std::nullopt;
    search.put(static_cast<int>(i), slots[i]);
  }
  return polish(search, matchups, mulberry32(seed),
                searchBudget(static_cast<int>(matchups.size())));
}

}  // namespace teamstation::scheduler
