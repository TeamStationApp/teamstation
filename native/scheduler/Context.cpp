// The slots and the starting occupancy of a run: slots.ts, context.ts,
// seasonZones.ts and feasibility.ts.
#include <algorithm>
#include <set>
#include <tuple>
#include <stdexcept>

#include "Engine.h"

namespace teamstation::scheduler {

namespace {

constexpr Instant kStep = 5 * kMinute;

struct Interval {
  Instant start;
  Instant end;
};

Instant alignUp(Instant instant) {
  return -floorDiv(-instant, kStep) * kStep;
}

const WindowPeriod* periodOn(const std::vector<WindowPeriod>& periods, int day) {
  std::vector<const WindowPeriod*> sorted;
  for (const WindowPeriod& period : periods) sorted.push_back(&period);
  std::stable_sort(sorted.begin(), sorted.end(),
                   [](const WindowPeriod* a, const WindowPeriod* b) {
                     return a->from < b->from;
                   });
  const WindowPeriod* found = nullptr;
  for (const WindowPeriod* period : sorted)
    if (period->from <= day) found = period;
  if (found == nullptr || !found->until.has_value() || day <= *found->until)
    return found;
  return nullptr;
}

std::vector<Interval> hoursOn(const std::vector<WeekdayHours>& hours, int day,
                              const ZoneOffsets& zone) {
  const int weekday = weekdayOf(day);
  std::vector<Interval> out;
  for (const WeekdayHours& entry : hours)
    if (entry.weekday == weekday)
      out.push_back({wallInstant(day, entry.start, zone),
                     wallInstant(day, entry.end, zone)});
  return out;
}

std::vector<Interval> fieldWindows(const Availability& availability,
                                   const ZoneOffsets& zone, int day) {
  if (availability.startsOn.has_value() && availability.endsOn.has_value() &&
      (day < *availability.startsOn || day > *availability.endsOn))
    return {};
  if (std::find(availability.blackouts.begin(), availability.blackouts.end(),
                day) != availability.blackouts.end())
    return {};
  if (!availability.hasWindows) return hoursOn(availability.hours, day, zone);
  const WindowPeriod* period = periodOn(availability.windows, day);
  return period == nullptr ? std::vector<Interval>{}
                           : hoursOn(period->hours, day, zone);
}

std::vector<Interval> seasonWindows(const std::vector<WindowPeriod>& periods,
                                    const ZoneOffsets& zone, int day) {
  const WindowPeriod* period = periodOn(periods, day);
  return period == nullptr ? std::vector<Interval>{}
                           : hoursOn(period->hours, day, zone);
}

std::vector<Interval> mergeIntervals(std::vector<Interval> intervals) {
  std::stable_sort(intervals.begin(), intervals.end(),
                   [](const Interval& a, const Interval& b) {
                     return a.start < b.start;
                   });
  std::vector<Interval> out;
  for (const Interval& interval : intervals) {
    if (!out.empty() && interval.start <= out.back().end)
      out.back().end = std::max(out.back().end, interval.end);
    else
      out.push_back(interval);
  }
  return out;
}

std::vector<Interval> intersect(const std::vector<Interval>& a,
                                const std::vector<Interval>& b) {
  std::vector<Interval> out;
  for (const Interval& x : a)
    for (const Interval& y : b) {
      const Instant start = std::max(x.start, y.start);
      const Instant end = std::min(x.end, y.end);
      if (start < end) out.push_back({start, end});
    }
  std::stable_sort(out.begin(), out.end(),
                   [](const Interval& x, const Interval& y) {
                     return x.start < y.start;
                   });
  return out;
}

bool contains(const std::vector<int>& values, int value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

// seasonZones: the selected fields' zones, or the first field's, or UTC.
std::vector<std::string> seasonZones(const Input& input,
                                     const Settings& settings) {
  std::vector<const Field*> selected = seasonFields(input, settings);
  if (selected.empty() && !input.fields.empty())
    selected.push_back(&input.fields.front());
  std::vector<std::string> zones;
  for (const Field* field : selected)
    if (std::find(zones.begin(), zones.end(), field->availability.timezone) ==
        zones.end())
      zones.push_back(field->availability.timezone);
  if (zones.empty()) zones.push_back("UTC");
  return zones;
}

int firstOpenDate(const Season& season, Instant notBefore,
                  const ZoneOffsets& zone) {
  return std::max(calendarDay(notBefore, zone), season.settings.startsOn);
}

void seasonSlots(const Input& input, const Season& season, int seasonIndex,
                 LocalClock& clock, SeasonContext& out) {
  const Settings& settings = season.settings;
  const Instant gameMs = settings.gameMinutes * kMinute;
  const Instant stride = gameMs + settings.bufferMinutes * kMinute;
  const std::set<int> blackouts(settings.blackouts.begin(),
                                settings.blackouts.end());
  const std::vector<const Field*> fields = seasonFields(input, settings);
  for (const Field* field : fields) {
    int scarcity = 0;
    for (const Season& other : input.seasons)
      if (other.id != season.id && contains(other.settings.fieldIds, field->id) &&
          contains(field->sizes, other.settings.fieldSize))
        ++scarcity;
    const ZoneOffsets& zone = input.zone(field->availability.timezone);
    for (int day = firstOpenDate(season, input.notBefore, zone);
         day <= settings.endsOn; ++day) {
      if (blackouts.count(day) > 0) continue;
      const std::vector<Interval> open = seasonWindows(settings.windows, zone, day);
      if (open.empty()) continue;
      const std::vector<Interval> fieldOpen =
          fieldWindows(field->availability, zone, day);
      if (fieldOpen.empty()) continue;
      const int weekday = weekdayOf(day);
      for (const Interval& interval : mergeIntervals(intersect(fieldOpen, open))) {
        const Instant start = std::max(interval.start, input.notBefore);
        if (start >= interval.end) continue;
        out.windows.push_back({field->id, day, start, interval.end});
        for (Instant at = alignUp(start); at + gameMs <= interval.end; at += stride) {
          out.supply.games++;
          out.supply.timeOfDay[clock.timeOfDay(day, at, zone)]++;
          out.supply.weekdays[weekday]++;
        }
        const Instant first = alignUp(start);
        for (Instant at = first; at + gameMs <= interval.end; at += kStep) {
          Slot slot;
          slot.point = clock.pointOn(day, at, zone);
          slot.season = seasonIndex;
          slot.field = field->id;
          slot.size = settings.fieldSize;
          slot.start = at;
          slot.end = at + gameMs;
          slot.scarcity = scarcity;
          slot.onGrid = (at - first) % stride == 0;
          out.slots.push_back(slot);
        }
      }
    }
  }
  std::vector<int> fieldOrder(input.fieldNames.size(), 0);
  for (size_t i = 0; i < fields.size(); ++i)
    fieldOrder[fields[i]->id] = static_cast<int>(i);
  std::stable_sort(out.slots.begin(), out.slots.end(),
                   [&](const Slot& a, const Slot& b) {
                     if (a.start != b.start) return a.start < b.start;
                     return fieldOrder[a.field] < fieldOrder[b.field];
                   });
  for (size_t i = 0; i < out.slots.size(); ++i)
    out.slots[i].index = static_cast<int>(i);
}

void groupSlots(SeasonContext& season) {
  std::map<std::tuple<int, int, int>, int> groups;
  for (const Slot& slot : season.slots) {
    const auto key = std::make_tuple(slot.field, slot.point.day, slot.point.timeOfDay);
    auto found = groups.find(key);
    if (found == groups.end()) {
      found = groups.emplace(key, static_cast<int>(season.groups.size())).first;
      season.groups.push_back({found->second, {}});
    }
    season.groups[found->second].slots.push_back(slot.index);
  }
}

}  // namespace

std::vector<const Field*> seasonFields(const Input& input,
                                       const Settings& settings) {
  std::vector<const Field*> out;
  for (const Field& field : input.fields)
    if (contains(settings.fieldIds, field.id) &&
        contains(field.sizes, settings.fieldSize))
      out.push_back(&field);
  return out;
}

int LocalClock::timeOfDay(int day, Instant instant, const ZoneOffsets& zone) {
  const auto key = std::make_pair(&zone, day);
  auto found = cutoffs_.find(key);
  if (found == cutoffs_.end())
    found = cutoffs_
                .emplace(key, std::make_pair(wallInstant(day, 12 * 60, zone),
                                             wallInstant(day, 17 * 60, zone)))
                .first;
  return instant < found->second.first    ? kMorning
         : instant < found->second.second ? kAfternoon
                                          : kEvening;
}

GamePoint LocalClock::pointOf(Instant instant, const ZoneOffsets& zone) {
  return pointOn(calendarDay(instant, zone), instant, zone);
}

GamePoint LocalClock::pointOn(int day, Instant instant, const ZoneOffsets& zone) {
  return {day, weekdayOf(day), timeOfDay(day, instant, zone)};
}

const SeasonContext* RunContext::seasonOf(const std::string& id) const {
  const auto found = seasonById.find(id);
  return found == seasonById.end() ? nullptr : &seasons[found->second];
}

const Field* RunContext::fieldById(int field) const {
  return field >= 0 && field < static_cast<int>(input->fields.size())
             ? &input->fields[field]
             : nullptr;
}

const std::string& RunContext::zoneOf(const SeasonContext& season,
                                      int field) const {
  const Field* found = fieldById(field);
  return found != nullptr ? found->availability.timezone : season.zones.front();
}

std::shared_ptr<RunContext> buildContext(std::shared_ptr<Input> input) {
  auto context = std::make_shared<RunContext>();
  context->input = input;
  context->clock = std::make_shared<LocalClock>();
  LocalClock& clock = *context->clock;
  context->seasons.resize(input->seasons.size());
  for (size_t index = 0; index < input->seasons.size(); ++index) {
    const Season& season = input->seasons[index];
    SeasonContext& out = context->seasons[index];
    out.index = static_cast<int>(index);
    out.season = &season;
    out.teams = season.participants;
    out.teams.insert(out.teams.end(), season.exhibitionTeams.begin(),
                     season.exhibitionTeams.end());
    out.zones = seasonZones(*input, season.settings);
    out.bufferMs = season.settings.bufferMinutes * kMinute;
    seasonSlots(*input, season, static_cast<int>(index), clock, out);
    groupSlots(out);
    out.firstDay = INT32_MAX;
    for (const std::string& zone : out.zones)
      out.firstDay = std::min(
          out.firstDay, firstOpenDate(season, input->notBefore, input->zone(zone)));
    out.lastDay = season.settings.endsOn;
    context->seasonById.emplace(season.id, static_cast<int>(index));
  }
  for (SeasonContext& season : context->seasons) {
    for (size_t i = 0; i < input->fixed.size(); ++i) {
      const FixedGame& game = input->fixed[i];
      if (game.seasonId != season.season->id) continue;
      season.fixed.push_back(
          {static_cast<int>(i),
           clock.pointOf(game.start, input->zone(context->zoneOf(season, game.field)))});
    }
    if (input->hasWeeklyGames) {
      for (const WeeklyGame& game : input->weeklyGames)
        if (game.seasonId == season.season->id)
          season.weeklyGames.push_back(
              {game.teams,
               clock.pointOf(game.start, input->zone(context->zoneOf(season, game.field)))});
    } else {
      for (const FixedPoint& fixed : season.fixed) {
        const FixedGame& game = input->fixed[fixed.game];
        season.weeklyGames.push_back({{game.home, game.away}, fixed.point});
      }
    }
  }
  if (input->partial) {
    context->active.assign(input->teams.size(), false);
    for (const int team : input->teamIds) context->active[team] = true;
  }
  context->hasRequired = input->hasRequired;
  for (const Matchup& matchup : input->required)
    if (context->seasonById.count(matchup.seasonId) > 0)
      context->required.push_back(matchup);

  const Occupancy occupancy(*context);
  for (SeasonContext& season : context->seasons) {
    season.fieldFree.resize(season.slots.size());
    for (size_t i = 0; i < season.slots.size(); ++i)
      season.fieldFree[i] = occupancy.fieldFits(season, season.slots[i]) ? 1 : 0;
    // A required matchup may name a team outside the season's lists.
    std::vector<int> teams = season.teams;
    for (const Matchup& matchup : context->required)
      if (matchup.seasonId == season.season->id)
        for (const int team : {matchup.home, matchup.away})
          if (!contains(teams, team)) teams.push_back(team);
    season.teamFree.assign(input->teams.size(), {});
    for (const int team : teams) {
      std::vector<uint8_t> free(season.slots.size());
      for (size_t i = 0; i < season.slots.size(); ++i)
        free[i] = occupancy.teamAvailability(season, team, season.slots[i]);
      season.teamFree[team] = std::move(free);
    }
  }
  return context;
}

int openSlots(const SeasonContext& season, int home, int away) {
  const std::vector<uint8_t>* a = season.freeOf(home);
  const std::vector<uint8_t>* b = season.freeOf(away);
  if (a == nullptr || b == nullptr) return 0;
  int count = 0;
  for (size_t i = 0; i < season.slots.size(); ++i)
    count += season.fieldFree[i] & (*a)[i] & (*b)[i];
  return count;
}

// ------------------------------------------------------------ occupancy

WeekPart gameWeekPart(int day) {
  const int weekday = static_cast<int>(((static_cast<int64_t>(day) + 3) % 7 + 7) % 7);
  const int monday = day - weekday;
  const bool weekend = weekday >= 5;
  return {static_cast<int64_t>(monday) * 2 + (weekend ? 1 : 0), weekend,
          monday + (weekend ? 5 : 0), monday + (weekend ? 6 : 4)};
}

int64_t weekPartMaximum(const Settings& settings, bool weekend) {
  const std::optional<int64_t>& max =
      weekend ? settings.maxGamesOnWeekend : settings.maxGamesOnWeekdays;
  return max.value_or(1);
}

namespace {

int64_t firstDayOf(const Hold& hold) { return floorDiv(hold.start - kDay, kDay); }
int64_t lastDayOf(const Hold& hold) { return floorDiv(hold.end + kDay, kDay); }

const std::vector<Hold> kNone;

}  // namespace

void DayBuckets::add(const Hold& hold) {
  for (int64_t day = firstDayOf(hold); day <= lastDayOf(hold); ++day)
    days_[day].push_back(hold);
}

void DayBuckets::remove(const Hold& hold) {
  for (int64_t day = firstDayOf(hold); day <= lastDayOf(hold); ++day) {
    const auto found = days_.find(day);
    if (found == days_.end()) continue;
    auto& list = found->second;
    const auto at = std::find_if(list.begin(), list.end(), [&](const Hold& entry) {
      return entry.id == hold.id;
    });
    if (at != list.end()) list.erase(at);
  }
}

const std::vector<Hold>& DayBuckets::near(Instant instant) const {
  const auto found = days_.find(floorDiv(instant, kDay));
  return found == days_.end() ? kNone : found->second;
}

Occupancy::Occupancy(const RunContext& context) : context_(context) {
  const Input& input = *context.input;
  int64_t id = 0;
  for (const Booking& booking : input.bookings) {
    const Hold hold{id++, booking.start, booking.end, booking.size, -1};
    managerHolds(booking.teams, hold, true);
    if (booking.managerOnly) continue;
    if (booking.field >= 0) bucketsOf(fields_, booking.field).add(hold);
    for (const int team : booking.teams) bucketsOf(teams_, team).add(hold);
  }
  for (const FixedGame& game : input.fixed) {
    const SeasonContext* season = context.seasonOf(game.seasonId);
    const Hold hold{id++, game.start, game.end, game.size,
                    season != nullptr ? season->bufferMs : -1};
    if (game.field >= 0) bucketsOf(fields_, game.field).add(hold);
    managerHolds({game.home, game.away}, hold, true);
    for (const int team : {game.home, game.away}) bucketsOf(teams_, team).add(hold);
    if (season != nullptr) {
      const int day =
          context.clock
              ->pointOf(game.start, input.zone(context.zoneOf(*season, game.field)))
              .day;
      count(dayCounts_, *season, game.home, day, 1);
      count(dayCounts_, *season, game.away, day, 1);
    }
  }
  for (const SeasonContext& season : context.seasons)
    for (const WeeklyPoint& game : season.weeklyGames)
      for (const int team : game.teams)
        count(weeklyCounts_, season, team, game.point.day, 1);
}

void Occupancy::managerHolds(const std::vector<int>& teams, const Hold& hold,
                             bool add) {
  std::vector<int> seen;
  for (const int team : teams) {
    const int manager = context_.input->managerOf(team);
    if (manager < 0 || contains(seen, manager)) continue;
    seen.push_back(manager);
    DayBuckets& buckets = bucketsOf(managers_, manager);
    if (add)
      buckets.add(hold);
    else
      buckets.remove(hold);
  }
}

DayBuckets& Occupancy::bucketsOf(std::unordered_map<int, DayBuckets>& map,
                                 int key) {
  return map[key];
}

void Occupancy::count(
    std::unordered_map<int, std::unordered_map<int64_t, int>>& counts,
    const SeasonContext& season, int team, int day, int by) {
  counts[team][static_cast<int64_t>(season.index) * 1'000'000 + day] += by;
}

int Occupancy::gamesOn(const SeasonContext& season, int team, int day) const {
  const auto days = dayCounts_.find(team);
  if (days == dayCounts_.end()) return 0;
  const auto found =
      days->second.find(static_cast<int64_t>(season.index) * 1'000'000 + day);
  return found == days->second.end() ? 0 : found->second;
}

bool Occupancy::fieldFits(const SeasonContext& season, const Slot& slot) const {
  const auto buckets = fields_.find(slot.field);
  if (buckets == fields_.end()) return true;
  const Field* field = context_.fieldById(slot.field);
  const Instant switchMs = field == nullptr ? 0 : field->switchMinutes * kMinute;
  for (const Hold& hold : buckets->second.near(slot.start)) {
    const Instant switching = hold.size >= 0 && hold.size != slot.size ? switchMs : 0;
    const Instant before = season.bufferMs + switching;
    const Instant after = (hold.bufferMs >= 0 ? hold.bufferMs : season.bufferMs) + switching;
    if (hold.start < slot.end + after && slot.start < hold.end + before) return false;
  }
  return true;
}

uint8_t Occupancy::teamAvailability(const SeasonContext& season, int team,
                                    const Slot& slot) const {
  const auto buckets = teams_.find(team);
  if (buckets != teams_.end())
    for (const Hold& hold : buckets->second.near(slot.start))
      if (hold.start < slot.end && slot.start < hold.end) return kBusy;
  if (season.settings().doubleheaders == Doubleheaders::Never &&
      gamesOn(season, team, slot.point.day) > 0)
    return kBusy;
  const int manager = context_.input->managerOf(team);
  if (manager >= 0) {
    const auto held = managers_.find(manager);
    if (held != managers_.end())
      for (const Hold& hold : held->second.near(slot.start))
        if (hold.start < slot.end && slot.start < hold.end) return kManagerBusy;
  }
  const WeekPart portion = gameWeekPart(slot.point.day);
  int64_t games = 0;
  const auto weekly = weeklyCounts_.find(team);
  if (weekly != weeklyCounts_.end())
    for (int day = portion.first; day <= portion.last; ++day) {
      const auto found =
          weekly->second.find(static_cast<int64_t>(season.index) * 1'000'000 + day);
      if (found != weekly->second.end()) games += found->second;
    }
  if (games >= weekPartMaximum(season.settings(), portion.weekend)) return kBusy;
  return kFree;
}

bool Occupancy::fits(const SeasonContext& season, int home, int away,
                     const Slot& slot) const {
  return fieldFits(season, slot) && teamAvailability(season, home, slot) == kFree &&
         teamAvailability(season, away, slot) == kFree;
}

void Occupancy::place(int64_t id, const SeasonContext& season, int home,
                      int away, const Slot& slot) {
  const Hold hold{kPlacedId + id, slot.start, slot.end, slot.size, season.bufferMs};
  managerHolds({home, away}, hold, true);
  bucketsOf(fields_, slot.field).add(hold);
  bucketsOf(teams_, home).add(hold);
  bucketsOf(teams_, away).add(hold);
  for (auto* counts : {&dayCounts_, &weeklyCounts_}) {
    count(*counts, season, home, slot.point.day, 1);
    count(*counts, season, away, slot.point.day, 1);
  }
}

void Occupancy::unplace(int64_t id, const SeasonContext& season, int home,
                        int away, const Slot& slot) {
  const Hold hold{kPlacedId + id, slot.start, slot.end, slot.size, season.bufferMs};
  managerHolds({home, away}, hold, false);
  bucketsOf(fields_, slot.field).remove(hold);
  bucketsOf(teams_, home).remove(hold);
  bucketsOf(teams_, away).remove(hold);
  for (auto* counts : {&dayCounts_, &weeklyCounts_}) {
    count(*counts, season, home, slot.point.day, -1);
    count(*counts, season, away, slot.point.day, -1);
  }
}

}  // namespace teamstation::scheduler
