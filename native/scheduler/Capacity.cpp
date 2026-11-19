// Every cause computation of capacity.ts, answering structured causes that
// TypeScript words (capacity.ts `causeLine`).
#include <algorithm>
#include <limits>

#include "Engine.h"

namespace teamstation::scheduler {

namespace {

constexpr Instant kStep = 5 * kMinute;

Instant alignUp(Instant instant) { return -floorDiv(-instant, kStep) * kStep; }

struct Span {
  Instant start;
  Instant end;
};

// The time on a field held by bookings and other games.
std::vector<Span> fieldHolds(const RunContext& context, int field) {
  std::vector<Span> out;
  for (const Booking& booking : context.input->bookings)
    if (!booking.managerOnly && booking.field == field)
      out.push_back({booking.start, booking.end});
  for (const FixedGame& game : context.input->fixed)
    if (game.field == field) out.push_back({game.start, game.end});
  return out;
}

std::vector<Matchup> requiredOf(const RunContext& context,
                                const SeasonContext& season) {
  std::vector<Matchup> out;
  for (const Matchup& matchup : context.required)
    if (matchup.seasonId == season.season->id) out.push_back(matchup);
  return out;
}

}  // namespace

Cause fieldTimeCause(const SeasonContext& season, GameKind kind, int requested) {
  return {season.index, kind, Rule::FieldTime, -1, requested};
}

Cause managerCause(const SeasonContext& season, GameKind kind, int requested,
                   int team) {
  return {season.index, kind, Rule::Manager, team, requested};
}

int fieldCapacity(const RunContext& context, const SeasonContext& season) {
  const Instant gameMs = season.settings().gameMinutes * kMinute;
  const Instant stride = gameMs + season.bufferMs;
  std::unordered_map<int, std::vector<Span>> holds;
  int games = 0;
  for (const SeasonWindow& window : season.windows) {
    auto held = holds.find(window.field);
    if (held == holds.end())
      held = holds.emplace(window.field, fieldHolds(context, window.field)).first;
    std::vector<Span> free{{window.start, window.end}};
    for (const Span& hold : held->second) {
      const Instant blockedStart = hold.start - season.bufferMs;
      const Instant blockedEnd = hold.end + season.bufferMs;
      std::vector<Span> next;
      for (const Span& part : free) {
        if (blockedEnd <= part.start || part.end <= blockedStart) {
          next.push_back(part);
          continue;
        }
        if (blockedStart > part.start) next.push_back({part.start, blockedStart});
        if (blockedEnd < part.end) next.push_back({blockedEnd, part.end});
      }
      free = std::move(next);
    }
    for (const Span& part : free) {
      const Instant start = alignUp(part.start);
      if (start + gameMs <= part.end)
        games += static_cast<int>((part.end - start - gameMs) / stride) + 1;
    }
  }
  return games;
}

int teamCapacity(const SeasonContext& season, int team, bool ownTime) {
  const std::vector<uint8_t>* free = season.freeOf(team);
  const int perDay = season.settings().doubleheaders == Doubleheaders::Never
                         ? 1
                         : std::numeric_limits<int>::max();
  std::unordered_map<int64_t, int64_t> portions;
  if (ownTime)
    for (const WeeklyPoint& game : season.weeklyGames)
      if (std::find(game.teams.begin(), game.teams.end(), team) != game.teams.end())
        portions[gameWeekPart(game.point.day).key]++;
  std::vector<const Slot*> slots;
  for (size_t i = 0; i < season.slots.size(); ++i)
    if (season.fieldFree[i] == 1 && (!ownTime || (free != nullptr && (*free)[i] == 1)))
      slots.push_back(&season.slots[i]);
  std::stable_sort(slots.begin(), slots.end(), [](const Slot* a, const Slot* b) {
    if (a->point.day != b->point.day) return a->point.day < b->point.day;
    return a->end < b->end;
  });
  int games = 0;
  int date = std::numeric_limits<int>::min();
  int today = 0;
  Instant busyUntil = std::numeric_limits<Instant>::min();
  for (const Slot* slot : slots) {
    if (slot->point.day != date) {
      date = slot->point.day;
      today = 0;
      busyUntil = std::numeric_limits<Instant>::min();
    }
    const WeekPart part = gameWeekPart(slot->point.day);
    const int64_t used = portions[part.key];
    if (today < perDay && slot->start >= busyUntil &&
        used < weekPartMaximum(season.settings(), part.weekend)) {
      portions[part.key] = used + 1;
      ++today;
      ++games;
      busyUntil = slot->end;
    }
  }
  return games;
}

std::optional<int> blockedByManager(const RunContext& context,
                                    const SeasonContext& season,
                                    const std::vector<Matchup>& matchups,
                                    const Occupancy* occupied) {
  const Input& input = *context.input;
  for (const Matchup& matchup : matchups) {
    if (input.managerOf(matchup.home) < 0 && input.managerOf(matchup.away) < 0)
      continue;
    const std::vector<uint8_t>* home = season.freeOf(matchup.home);
    const std::vector<uint8_t>* away = season.freeOf(matchup.away);
    if (home == nullptr || away == nullptr) continue;
    int blockedTeam = -1;
    for (size_t i = 0; i < season.slots.size(); ++i) {
      const Slot& slot = season.slots[i];
      if (season.fieldFree[i] == 0 ||
          (occupied != nullptr && !occupied->fieldFits(season, slot)))
        continue;
      const uint8_t h = occupied != nullptr
                            ? occupied->teamAvailability(season, matchup.home, slot)
                            : (*home)[i];
      const uint8_t a = occupied != nullptr
                            ? occupied->teamAvailability(season, matchup.away, slot)
                            : (*away)[i];
      if (h == kBusy || a == kBusy) continue;
      if (h == kFree && a == kFree) {
        blockedTeam = -1;
        break;
      }
      if (blockedTeam < 0) blockedTeam = h == kManagerBusy ? matchup.home : matchup.away;
    }
    if (blockedTeam >= 0) return blockedTeam;
  }
  return std::nullopt;
}

bool weekPartCause(const RunContext& context, const SeasonContext& season,
                   const std::vector<Matchup>& matchups) {
  std::vector<std::pair<int, int>> needed;
  auto bump = [&](int team) {
    for (auto& entry : needed)
      if (entry.first == team) {
        entry.second++;
        return;
      }
    needed.emplace_back(team, 1);
  };
  for (const Matchup& game : matchups) {
    bump(game.home);
    bump(game.away);
  }
  std::shared_ptr<RunContext> withoutLimits;
  for (const auto& [team, count] : needed) {
    const int capped = teamCapacity(season, team, true);
    if (capped >= count) continue;
    // Rebuilt, availability too: zero or full caps make teamFree busy.
    if (withoutLimits == nullptr) {
      auto input = std::make_shared<Input>(*context.input);
      Settings& settings = input->seasons[season.index].settings;
      settings.maxGamesOnWeekdays = 9007199254740991LL;
      settings.maxGamesOnWeekend = 9007199254740991LL;
      withoutLimits = buildContext(input);
    }
    if (capped < teamCapacity(withoutLimits->seasons[season.index], team, true))
      return true;
  }
  return false;
}

Cause capacityCause(const RunContext& context, const SeasonContext& season,
                    GameKind kind, int requested) {
  const Cause fieldTime{season.index, kind, Rule::Capacity, -1, requested};
  const Targets targets = requestedTargets(season);
  const std::vector<Matchup> matchups =
      seasonMatchups(context, season, targets, toUint32(context.input->seed));
  if (const auto team = blockedByManager(context, season, matchups, nullptr))
    return managerCause(season, kind, requested, *team);
  if (static_cast<int>(matchups.size()) > fieldCapacity(context, season))
    return fieldTime;
  if (weekPartCause(context, season, matchups))
    return {season.index, kind, Rule::WeekParts, -1, requested};
  const auto needs = seasonNeeds(*season.season, targets,
                                 fixedCounts(*season.season, context), context);
  int shortTeam = -1;
  int shortBy = 0;
  for (const auto& [team, need] : needs) {
    const int total = need.regular + need.exhibition;
    if (total == 0) continue;
    const int open = teamCapacity(season, team, true);
    if (open >= total || open >= teamCapacity(season, team, false)) continue;
    if (shortTeam < 0 || total - open > shortBy) {
      shortTeam = team;
      shortBy = total - open;
    }
  }
  if (shortTeam < 0) return fieldTime;
  const std::vector<uint8_t>* free = season.freeOf(shortTeam);
  if (free != nullptr)
    for (size_t i = 0; i < free->size(); ++i)
      if ((*free)[i] == kManagerBusy && season.fieldFree[i] == 1)
        return managerCause(season, kind, requested, shortTeam);
  return {season.index, kind, Rule::TeamOpenDates, shortTeam, requested};
}

Cause requiredCause(const RunContext& context, const SeasonContext& season,
                    const std::vector<Matchup>& unplaced) {
  const std::vector<Matchup> required = requiredOf(context, season);
  const int count = static_cast<int>(required.size());
  const Cause fieldTime{season.index, GameKind::Required, Rule::RequiredUnplaced,
                        -1, count};
  if (const auto team = blockedByManager(context, season, unplaced, nullptr))
    return managerCause(season, GameKind::Required, count, *team);
  if (count > fieldCapacity(context, season)) return fieldTime;
  if (weekPartCause(context, season, required))
    return {season.index, GameKind::Required, Rule::WeekParts, -1, count};
  int fieldOpen = 0;
  for (const uint8_t free : season.fieldFree) fieldOpen += free;
  auto freeFor = [&](int team) {
    const std::vector<uint8_t>* free = season.freeOf(team);
    int open = 0;
    for (size_t i = 0; i < season.fieldFree.size(); ++i)
      open += season.fieldFree[i] & (free == nullptr ? 0 : (*free)[i]);
    return open;
  };
  for (const Matchup& matchup : unplaced) {
    if (fieldOpen == 0 || openSlots(season, matchup.home, matchup.away) > 0) continue;
    const int team = freeFor(matchup.home) <= freeFor(matchup.away) ? matchup.home
                                                                     : matchup.away;
    return {season.index, GameKind::Required, Rule::TeamOpenDates, team, count};
  }
  return fieldTime;
}

std::optional<Cause> blockingCause(const RunContext& context) {
  if (context.hasRequired) {
    if (context.required.empty()) return std::nullopt;
    for (const Matchup& matchup : context.required) {
      const SeasonContext* season = context.seasonOf(matchup.seasonId);
      if (season != nullptr && openSlots(*season, matchup.home, matchup.away) > 0)
        return std::nullopt;
    }
    for (const SeasonContext& season : context.seasons) {
      const std::vector<Matchup> own = requiredOf(context, season);
      if (!own.empty()) return requiredCause(context, season, own);
    }
    return std::nullopt;
  }
  const SeasonContext* blocked = nullptr;
  for (const SeasonContext& season : context.seasons) {
    const std::vector<Matchup> matchups = seasonMatchups(
        context, season, requestedTargets(season), toUint32(context.input->seed));
    if (matchups.empty()) continue;
    for (const Matchup& game : matchups)
      if (openSlots(season, game.home, game.away) > 0) return std::nullopt;
    if (blocked == nullptr) blocked = &season;
  }
  if (blocked == nullptr) return std::nullopt;
  const Targets targets = requestedTargets(*blocked);
  return targets.regular > 0
             ? capacityCause(context, *blocked, GameKind::Regular, targets.regular)
             : capacityCause(context, *blocked, GameKind::Exhibition,
                             targets.exhibition);
}

}  // namespace teamstation::scheduler
