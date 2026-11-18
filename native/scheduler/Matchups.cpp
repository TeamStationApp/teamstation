// The seeded generator, matchups and targets: random.ts, matchups.ts and
// the target arithmetic of counts.ts.
#include <algorithm>
#include <cmath>
#include <unordered_set>

#include "Engine.h"

namespace teamstation::scheduler {

uint32_t toUint32(double value) {
  if (!std::isfinite(value)) return 0;
  const double whole = std::trunc(value);
  double wrapped = std::fmod(whole, 4294967296.0);
  if (wrapped < 0) wrapped += 4294967296.0;
  return static_cast<uint32_t>(wrapped);
}

Random mulberry32(uint32_t seed) {
  auto state = std::make_shared<uint32_t>(seed);
  return [state]() {
    *state += 0x6d2b79f5u;
    uint32_t t = *state;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>(t ^ (t >> 14)) / 4294967296.0;
  };
}

int randomIndex(const Random& random, int length) {
  return std::min(length - 1, static_cast<int>(std::floor(random() * length)));
}

std::vector<int> shuffled(const std::vector<int>& items, const Random& random) {
  std::vector<int> out = items;
  for (int i = static_cast<int>(out.size()) - 1; i > 0; --i) {
    const int j = randomIndex(random, i + 1);
    std::swap(out[i], out[j]);
  }
  return out;
}

uint32_t nthSeed(uint32_t seed, uint32_t k) { return seed + k * 0x9e3779b9u; }

namespace {

std::pair<int, int> pairKey(int a, int b) {
  return a < b ? std::make_pair(a, b) : std::make_pair(b, a);
}

std::vector<const FixedGame*> fixedOf(const RunContext& context,
                                      const std::string& seasonId) {
  std::vector<const FixedGame*> out;
  for (const FixedGame& game : context.input->fixed)
    if (game.seasonId == seasonId) out.push_back(&game);
  return out;
}

}  // namespace

std::unordered_map<int, TeamCounts> fixedCounts(const Season& season,
                                                const RunContext& context) {
  std::unordered_map<int, TeamCounts> counts;
  for (const int team : season.participants) counts[team];
  for (const int team : season.exhibitionTeams) counts[team];
  for (const FixedGame& game : context.input->fixed) {
    if (game.seasonId != season.id) continue;
    for (const int team : {game.home, game.away}) {
      const auto found = counts.find(team);
      if (found == counts.end()) continue;
      if (game.exhibition)
        found->second.exhibition++;
      else
        found->second.regular++;
    }
  }
  return counts;
}

std::vector<std::pair<int, TeamCounts>> seasonNeeds(
    const Season& season, const Targets& targets,
    const std::unordered_map<int, TeamCounts>& counts,
    const RunContext& context) {
  std::vector<std::pair<int, TeamCounts>> needs;
  for (const int team : season.participants) {
    const auto found = counts.find(team);
    const TeamCounts count = found == counts.end() ? TeamCounts{} : found->second;
    const bool playing = context.isActive(team);
    needs.push_back(
        {team,
         {playing ? std::max(0, targets.regular - count.regular) : 0,
          playing ? std::max(0, targets.exhibition - count.exhibition) : 0}});
  }
  return needs;
}

std::vector<std::pair<int, int>> regularPairs(
    const std::vector<int>& order, const std::unordered_map<int, int>& needs,
    std::map<std::pair<int, int>, int>& met, int cap) {
  std::unordered_map<int, int> left;
  std::unordered_map<int, int> rank;
  for (size_t i = 0; i < order.size(); ++i) {
    const auto need = needs.find(order[i]);
    left[order[i]] = need == needs.end() ? 0 : need->second;
    rank[order[i]] = static_cast<int>(i);
  }
  auto meetings = [&](int a, int b) {
    const auto found = met.find(pairKey(a, b));
    return found == met.end() ? 0 : found->second;
  };
  auto meet = [&](int a, int b, int by) { met[pairKey(a, b)] += by; };
  auto byNeed = [&](int a, int b) {
    const int difference = left[b] - left[a];
    return difference != 0 ? difference : rank[a] - rank[b];
  };
  std::vector<std::pair<int, int>> pairs;
  for (;;) {
    std::vector<int> needing;
    for (const int team : order)
      if (left[team] > 0) needing.push_back(team);
    if (needing.size() < 2) break;
    std::stable_sort(needing.begin(), needing.end(),
                     [&](int a, int b) { return byNeed(a, b) < 0; });
    const int first = needing.front();
    std::vector<int> others(needing.begin() + 1, needing.end());
    std::stable_sort(others.begin(), others.end(), [&](int a, int b) {
      const int difference = meetings(first, a) - meetings(first, b);
      return (difference != 0 ? difference : byNeed(a, b)) < 0;
    });
    const int second = others.front();
    pairs.emplace_back(first, second);
    left[first]--;
    left[second]--;
    meet(first, second, 1);
  }

  bool changed = true;
  for (int rounds = 0; changed && rounds < 1000; ++rounds) {
    changed = false;
    for (size_t i = 0; i < pairs.size() && !changed; ++i) {
      const auto [a, b] = pairs[i];
      if (meetings(a, b) <= cap) continue;
      for (size_t j = 0; j < pairs.size() && !changed; ++j) {
        if (j == i) continue;
        const auto [c, d] = pairs[j];
        if (c == a || c == b || d == a || d == b) continue;
        for (const auto& [x, y] : {std::make_pair(c, d), std::make_pair(d, c)})
          if (!changed && meetings(a, x) < cap && meetings(b, y) < cap) {
            meet(a, b, -1);
            meet(c, d, -1);
            meet(a, x, 1);
            meet(b, y, 1);
            pairs[i] = {a, x};
            pairs[j] = {b, y};
            changed = true;
          }
      }
    }
  }
  return pairs;
}

std::vector<int> exhibitionOpponents(int index, int perTeam,
                                     const std::vector<int>& exhibitionTeams,
                                     const std::vector<int>& alreadyPlayed,
                                     int need) {
  if (exhibitionTeams.empty()) return {};
  std::vector<int> assigned;
  const int64_t count = static_cast<int64_t>(exhibitionTeams.size());
  for (int k = 0; k < perTeam; ++k)
    assigned.push_back(
        exhibitionTeams[static_cast<size_t>((static_cast<int64_t>(index) * perTeam + k) % count)]);
  for (const int team : alreadyPlayed) {
    const auto at = std::find(assigned.begin(), assigned.end(), team);
    if (at != assigned.end()) assigned.erase(at);
  }
  if (static_cast<int>(assigned.size()) > need)
    assigned.resize(static_cast<size_t>(std::max(0, need)));
  return assigned;
}

std::vector<std::pair<int, int>> orient(
    const std::vector<std::pair<int, int>>& pairs,
    const std::vector<const FixedGame*>& fixed) {
  // The balance per team, in the order teams were first seen.
  std::vector<int> teams;
  std::unordered_map<int, int> balance;
  auto lean = [&](int team) {
    const auto found = balance.find(team);
    return found == balance.end() ? 0 : found->second;
  };
  auto shift = [&](int team, int by) {
    const auto found = balance.find(team);
    if (found == balance.end()) {
      teams.push_back(team);
      balance[team] = by;
    } else {
      found->second += by;
    }
  };
  for (const FixedGame* game : fixed) {
    shift(game->home, 1);
    shift(game->away, -1);
  }
  std::vector<std::pair<int, int>> out;
  for (const auto& [a, b] : pairs) {
    const int home = lean(b) < lean(a) ? b : a;
    const int away = home == a ? b : a;
    shift(home, 1);
    shift(away, -1);
    out.emplace_back(home, away);
  }

  struct Step {
    int team;
    int game;
    int back;
  };
  auto flipChain = [&](int from, bool hosting, bool (*wanted)(int)) {
    std::vector<Step> steps{{from, -1, -1}};
    std::unordered_set<int> seen{from};
    for (size_t at = 0; at < steps.size(); ++at) {
      const int team = steps[at].team;
      for (size_t game = 0; game < out.size(); ++game) {
        const auto [home, away] = out[game];
        int next = -1;
        if (hosting && home == team) next = away;
        if (!hosting && away == team) next = home;
        if (next < 0 || seen.count(next) > 0) continue;
        seen.insert(next);
        steps.push_back({next, static_cast<int>(game), static_cast<int>(at)});
      }
      int found = -1;
      for (size_t i = 1; i < steps.size(); ++i)
        if (wanted(lean(steps[i].team))) {
          found = static_cast<int>(i);
          break;
        }
      if (found < 0) continue;
      for (int i = found; i > 0; i = steps[i].back) {
        auto& game = out[steps[i].game];
        const int home = game.first;
        const int away = game.second;
        game = {away, home};
        shift(home, -2);
        shift(away, 2);
      }
      return true;
    }
    return false;
  };

  for (size_t guard = 0; guard < 4 * out.size() + 4; ++guard) {
    if (teams.empty()) break;
    int most = teams.front();
    for (const int team : teams)
      if (lean(team) > lean(most)) most = team;
    if (lean(most) >= 2 && flipChain(most, true, [](int value) { return value <= -1; }))
      continue;
    int least = teams.front();
    for (const int team : teams)
      if (lean(team) < lean(least)) least = team;
    if (lean(least) <= -2 &&
        flipChain(least, false, [](int value) { return value >= 1; }))
      continue;
    break;
  }
  return out;
}

std::vector<Matchup> keyMatchups(const Input& input, const std::string& seasonId,
                                 const std::vector<std::pair<int, int>>& oriented,
                                 size_t regularCount) {
  std::unordered_map<std::string, int> seen;
  std::vector<Matchup> out;
  for (size_t i = 0; i < oriented.size(); ++i) {
    const auto [home, away] = oriented[i];
    const std::string base =
        seasonId + ":" + input.teams.name(home) + ":" + input.teams.name(away);
    const int n = ++seen[base];
    out.push_back({base + ":" + std::to_string(n), seasonId, home, away,
                   i >= regularCount});
  }
  return out;
}

std::vector<Matchup> seasonMatchups(const RunContext& context,
                                    const SeasonContext& seasonContext,
                                    const Targets& targets, uint32_t seed) {
  const Season& season = *seasonContext.season;
  const std::vector<const FixedGame*> own = fixedOf(context, season.id);
  const auto needs =
      seasonNeeds(season, targets, fixedCounts(season, context), context);
  std::map<std::pair<int, int>, int> met;
  std::unordered_map<int, std::vector<int>> played;
  for (const FixedGame* game : own) {
    if (!game->exhibition) {
      met[pairKey(game->home, game->away)]++;
      continue;
    }
    played[game->home].push_back(game->away);
    played[game->away].push_back(game->home);
  }
  const Random random = mulberry32(seed ^ 0x5eedu);
  std::unordered_map<int, int> regularNeeds;
  for (const auto& [team, need] : needs) regularNeeds[team] = need.regular;
  const int participants = static_cast<int>(season.participants.size());
  const int cap = std::max(
      1, static_cast<int>(std::ceil(static_cast<double>(targets.regular) /
                                    std::max(1, participants - 1))));
  std::vector<std::pair<int, int>> pairs =
      regularPairs(shuffled(season.participants, random), regularNeeds, met, cap);
  const size_t regularCount = pairs.size();
  std::vector<int> exhibitionTeams;
  for (const int team : season.exhibitionTeams)
    if (context.isActive(team)) exhibitionTeams.push_back(team);
  for (size_t i = 0; i < season.participants.size(); ++i) {
    const int team = season.participants[i];
    const auto playedBy = played.find(team);
    const std::vector<int> opponents = exhibitionOpponents(
        static_cast<int>(i), targets.exhibition, season.exhibitionTeams,
        playedBy == played.end() ? std::vector<int>{} : playedBy->second,
        needs[i].second.exhibition);
    for (const int opponent : opponents)
      if (std::find(exhibitionTeams.begin(), exhibitionTeams.end(), opponent) !=
          exhibitionTeams.end())
        pairs.emplace_back(team, opponent);
  }
  return keyMatchups(*context.input, season.id, orient(pairs, own), regularCount);
}

// ---------------------------------------------------------------- counts

Targets requestedTargets(const SeasonContext& season) {
  return {season.settings().regularGames, season.settings().exhibitionGames};
}

Targets floorTargets(const RunContext& context, const SeasonContext& season) {
  const Targets requested = requestedTargets(season);
  const auto counts = fixedCounts(*season.season, context);
  int regular = 0;
  int exhibition = 0;
  for (const int team : season.season->participants) {
    const auto found = counts.find(team);
    if (found == counts.end()) continue;
    regular = std::max(regular, found->second.regular);
    exhibition = std::max(exhibition, found->second.exhibition);
  }
  return {std::min(regular, requested.regular),
          std::min(exhibition, requested.exhibition)};
}

bool oddTotal(const RunContext& context, const SeasonContext& season,
              const Targets& targets) {
  int total = 0;
  for (const auto& [team, need] : seasonNeeds(
           *season.season, targets, fixedCounts(*season.season, context), context))
    total += need.regular;
  return total % 2 == 1;
}

bool lowerTargets(const RunContext& context, const SeasonContext& season,
                  Targets& targets) {
  const Targets floor = floorTargets(context, season);
  if (targets.regular > floor.regular) {
    const bool oddAsked = oddTotal(context, season, requestedTargets(season));
    targets.regular--;
    if (!oddAsked)
      while (targets.regular > floor.regular && oddTotal(context, season, targets))
        targets.regular--;
    return true;
  }
  if (targets.exhibition > floor.exhibition) {
    targets.exhibition--;
    return true;
  }
  return false;
}

Targets startingTargets(const RunContext& context, const SeasonContext& season,
                        uint32_t seed, const Targets* from) {
  Targets targets = from != nullptr ? *from : requestedTargets(season);
  const int capacity = fieldCapacity(context, season);
  std::unordered_map<int, int> open;
  for (const int team : season.season->participants)
    open[team] = teamCapacity(season, team, true);
  const auto counts = fixedCounts(*season.season, context);
  auto fits = [&]() {
    if (static_cast<int>(seasonMatchups(context, season, targets, seed).size()) > capacity)
      return false;
    for (const auto& [team, need] : seasonNeeds(*season.season, targets, counts, context))
      if (need.regular + need.exhibition > open[team]) return false;
    return true;
  };
  while (!fits() && lowerTargets(context, season, targets)) {
  }
  return targets;
}

}  // namespace teamstation::scheduler
