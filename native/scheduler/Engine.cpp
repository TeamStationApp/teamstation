// The build: context, blocking cause, exact settlement, the polish from every
// seed and weighting, and the options (index.ts `exactSteps`, `optionsOf`,
// and options.ts), written as the result JSON. Every user-facing sentence is
// left to TypeScript: causes, unmet counts and reasons travel structured.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <set>

#include "Engine.h"
#include "Highs.h"

namespace teamstation::scheduler {

namespace {

using json::Writer;

const char* kindName(GameKind kind) {
  return kind == GameKind::Regular      ? "regular"
         : kind == GameKind::Exhibition ? "exhibition"
                                        : "required";
}

const char* ruleName(Rule rule) {
  switch (rule) {
    case Rule::FieldTime:
      return "fieldTime";
    case Rule::WeekParts:
      return "weekParts";
    case Rule::Doubleheaders:
      return "doubleheaders";
    case Rule::Manager:
      return "manager";
    case Rule::RequiredUnplaced:
      return "requiredUnplaced";
    case Rule::TeamOpenDates:
      return "teamOpenDates";
    case Rule::TimeLimit:
      return "timeLimit";
    default:
      return "capacity";
  }
}

void writeCause(Writer& out, const RunContext& context, const Cause& cause) {
  const Input& input = *context.input;
  const SeasonContext& season = context.seasons[cause.season];
  out.beginObject();
  out.key("seasonId").string(season.season->id);
  out.key("kind").string(kindName(cause.kind));
  out.key("rule").string(ruleName(cause.rule));
  if (cause.team >= 0) {
    out.key("teamId").string(input.teams.name(cause.team));
    const int manager = input.managerOf(cause.team);
    if (cause.rule == Rule::Manager && manager >= 0)
      out.key("managerId").string(input.managers.name(manager));
  }
  out.key("requested").integer(cause.requested);
  out.key("size").string(input.sizes.name(season.settings().fieldSize));
  out.endObject();
}

double storedScore(double value) { return std::floor(value * 1e6 + 0.5) / 1e6; }

// ---------------------------------------------------------- the options

double differentShare(const Placement& candidate, const Placement& other) {
  std::set<std::pair<int, Instant>> theirs;
  for (const Slot* slot : other.slots)
    if (slot != nullptr) theirs.insert({slot->field, slot->start});
  int games = 0;
  int different = 0;
  for (const Slot* slot : candidate.slots) {
    if (slot == nullptr) continue;
    ++games;
    if (theirs.count({slot->field, slot->start}) == 0) ++different;
  }
  return games == 0 ? 0 : static_cast<double>(different) / games;
}

std::vector<const Placement*> chooseOptions(const std::vector<Placement>& candidates) {
  std::vector<const Placement*> ranked;
  for (const Placement& placement : candidates) ranked.push_back(&placement);
  std::stable_sort(ranked.begin(), ranked.end(), [](const Placement* a, const Placement* b) {
    return compareScores(a->score, b->score, kTrueOrder) < 0;
  });
  std::vector<const Placement*> chosen;
  if (ranked.empty()) return chosen;
  const Placement* best = ranked.front();
  chosen.push_back(best);
  for (size_t i = 1; i < ranked.size(); ++i) {
    if (chosen.size() >= kMaxOptions) break;
    const Placement* candidate = ranked[i];
    if (candidate->score[kUnplaced] > best->score[kUnplaced]) continue;
    bool differs = true;
    for (const Placement* option : chosen)
      if (differentShare(*candidate, *option) < kMinDifferent) differs = false;
    if (differs) chosen.push_back(candidate);
  }
  return chosen;
}

struct TeamView {
  int team;
  const TeamTally* tally;
  const Supply* supply;
};

std::vector<TeamView> teamViews(const Placement& placement) {
  std::vector<TeamView> views;
  for (const SeasonLedger& ledger : placement.ledgers)
    for (const auto& [team, tally] : ledger.tallies)
      views.push_back({team, &tally, &ledger.season->supply});
  return views;
}

struct Reason {
  std::string term;
  int team = -1;
  int count = 0;
  int games = 0;
  int index = 0;
  double more = 0;
  std::optional<int> days;
};

Reason named(const char* term) {
  Reason reason;
  reason.term = term;
  return reason;
}

std::optional<Reason> mixReason(const std::vector<TeamView>& views,
                                const std::vector<TeamView>& bestViews, bool weekdays) {
  auto counts = [&](const TeamView& view) {
    return weekdays ? view.tally->weekdays.data() : view.tally->timeOfDay.data();
  };
  auto supply = [&](const TeamView& view) {
    return weekdays ? view.supply->weekdays.data() : view.supply->timeOfDay.data();
  };
  const int length = weekdays ? 7 : 3;
  const TeamView* found = nullptr;
  double foundBy = 0;
  for (size_t i = 0; i < views.size() && i < bestViews.size(); ++i) {
    const TeamView& view = views[i];
    const TeamView& best = bestViews[i];
    const double by =
        mixDeviation(counts(view), length, view.tally->games, supply(view), view.supply->games) -
        mixDeviation(counts(best), length, best.tally->games, supply(best), view.supply->games);
    if (by > 1e-9 && (found == nullptr || by > foundBy)) {
      found = &view;
      foundBy = by;
    }
  }
  if (found == nullptr) return std::nullopt;
  int worst = 0;
  double excess = -INFINITY;
  for (int i = 0; i < length; ++i) {
    const double over = static_cast<double>(counts(*found)[i]) / found->tally->games -
                        static_cast<double>(supply(*found)[i]) /
                            std::max(1, found->supply->games);
    if (over > excess) {
      excess = over;
      worst = i;
    }
  }
  Reason reason;
  reason.term = weekdays ? "weekday" : "timeOfDay";
  reason.team = found->team;
  reason.count = counts(*found)[worst];
  reason.games = found->tally->games;
  reason.index = worst;
  return reason;
}

std::optional<Reason> spacingReason(const std::vector<TeamView>& views,
                                    const std::vector<TeamView>& bestViews) {
  size_t found = views.size();
  double foundBy = 0;
  for (size_t i = 0; i < views.size() && i < bestViews.size(); ++i) {
    const double by = views[i].tally->spacing() - bestViews[i].tally->spacing();
    if (by > 1e-9 && (found == views.size() || by > foundBy)) {
      found = i;
      foundBy = by;
    }
  }
  if (found == views.size()) return std::nullopt;
  const TeamView& view = views[found];
  Reason reason;
  reason.team = view.team;
  const int backToBack = view.tally->backToBack();
  if (backToBack > bestViews[found].tally->backToBack()) {
    reason.term = "backToBack";
    reason.count = backToBack;
    return reason;
  }
  reason.term = "gap";
  const std::vector<int> gaps = view.tally->gaps();
  if (!gaps.empty()) reason.days = *std::max_element(gaps.begin(), gaps.end());
  return reason;
}

int scarceGames(const Placement& placement) {
  int games = 0;
  for (const Slot* slot : placement.slots)
    if (slot != nullptr && slot->scarcity > 0) ++games;
  return games;
}

std::vector<Reason> optionReasons(const Placement& option, const Placement& best) {
  const std::vector<TeamView> views = teamViews(option);
  const std::vector<TeamView> bestViews = teamViews(best);
  std::vector<Reason> reasons;
  for (const int term : kTrueOrder) {
    if (option.score[term] - best.score[term] <= 1e-9) continue;
    std::optional<Reason> reason;
    if (term == kUnplaced) {
      reason = named("unplaced");
      reason->more = option.score[term] - best.score[term];
    } else if (term == kDoubleheaders) {
      reason = named("doubleheaders");
      reason->more = std::floor(option.score[term] - best.score[term] + 0.5);
    } else if (term == kPreference) {
      reason = named("preference");
    } else if (term == kTimeOfDay) {
      reason = mixReason(views, bestViews, false);
    } else if (term == kSpacing) {
      reason = spacingReason(views, bestViews);
    } else if (term == kWeekday) {
      reason = mixReason(views, bestViews, true);
    } else {
      reason = named("scarcity");
      reason->more = scarceGames(option) - scarceGames(best);
    }
    if (reason) reasons.push_back(*reason);
    if (reasons.size() == 2) break;
  }
  if (reasons.empty()) reasons.push_back(named("balanced"));
  return reasons;
}

void writeReason(Writer& out, const Input& input, const Reason& reason) {
  out.beginObject();
  out.key("term").string(reason.term);
  if (reason.team >= 0) out.key("teamId").string(input.teams.name(reason.team));
  if (reason.term == "timeOfDay" || reason.term == "weekday") {
    out.key("count").integer(reason.count);
    out.key("games").integer(reason.games);
    out.key("index").integer(reason.index);
  }
  if (reason.term == "backToBack") out.key("count").integer(reason.count);
  if (reason.term == "gap") {
    out.key("days");
    if (reason.days)
      out.integer(*reason.days);
    else
      out.null();
  }
  if (reason.term == "unplaced" || reason.term == "doubleheaders" || reason.term == "scarcity")
    out.key("more").number(reason.more);
  out.endObject();
}

void writeFairness(Writer& out, const RunContext& context, const Placement& placement) {
  const Input& input = *context.input;
  out.beginArray();
  for (const SeasonContext& season : context.seasons) {
    struct Entry {
      GamePoint point;
      bool exhibition;
    };
    std::unordered_map<int, std::vector<Entry>> games;
    for (const int team : season.teams) games[team];
    auto add = [&](int home, int away, const GamePoint& point, bool exhibition) {
      for (const int team : {home, away}) {
        const auto found = games.find(team);
        if (found != games.end()) found->second.push_back({point, exhibition});
      }
    };
    for (const FixedPoint& fixed : season.fixed) {
      const FixedGame& game = input.fixed[fixed.game];
      add(game.home, game.away, fixed.point, game.exhibition);
    }
    for (size_t i = 0; i < placement.matchups.size(); ++i) {
      const Matchup& matchup = placement.matchups[i];
      if (matchup.seasonId == season.season->id && placement.slots[i] != nullptr)
        add(matchup.home, matchup.away, placement.slots[i]->point, matchup.exhibition);
    }
    const std::vector<int>& exhibitionTeams = season.season->exhibitionTeams;
    const Settings& settings = season.settings();
    for (const int team : season.teams) {
      const std::vector<Entry>& list = games[team];
      std::vector<int> days;
      for (const Entry& entry : list)
        if (entry.point.day >= settings.startsOn && entry.point.day <= settings.endsOn)
          days.push_back(entry.point.day);
      std::sort(days.begin(), days.end());
      std::vector<int> gaps;
      for (size_t i = 1; i < days.size(); ++i) gaps.push_back(days[i] - days[i - 1]);
      std::map<int, int> perDay;
      std::array<int, 7> weekdays{};
      std::array<int, 3> parts{};
      int regular = 0;
      int exhibition = 0;
      for (const Entry& entry : list) {
        perDay[entry.point.day]++;
        weekdays[entry.point.weekday]++;
        parts[entry.point.timeOfDay]++;
        if (entry.exhibition)
          ++exhibition;
        else
          ++regular;
      }
      int doubleheaders = 0;
      for (const auto& [day, count] : perDay) doubleheaders += count - 1;
      out.beginObject();
      out.key("teamId").string(input.teams.name(team));
      out.key("seasonId").string(season.season->id);
      out.key("exhibitionTeam")
          .boolean(std::find(exhibitionTeams.begin(), exhibitionTeams.end(), team) !=
                   exhibitionTeams.end());
      out.key("regularGames").integer(regular);
      out.key("exhibitionGames").integer(exhibition);
      out.key("mornings").integer(parts[kMorning]);
      out.key("afternoons").integer(parts[kAfternoon]);
      out.key("evenings").integer(parts[kEvening]);
      out.key("weekdays").beginArray();
      for (const int count : weekdays) out.integer(count);
      out.endArray();
      out.key("shortestGapDays");
      if (gaps.empty())
        out.null();
      else
        out.integer(*std::min_element(gaps.begin(), gaps.end()));
      out.key("longestGapDays");
      if (gaps.empty())
        out.null();
      else
        out.integer(*std::max_element(gaps.begin(), gaps.end()));
      out.key("doubleheaders").integer(doubleheaders);
      out.endObject();
    }
  }
  out.endArray();
}

void writeGames(Writer& out, const RunContext& context, const Placement& placement) {
  const Input& input = *context.input;
  std::vector<size_t> order;
  for (size_t i = 0; i < placement.matchups.size(); ++i)
    if (placement.slots[i] != nullptr) order.push_back(i);
  // Earliest first; TypeScript orders games at one start by their keys.
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    if (placement.slots[a]->start != placement.slots[b]->start)
      return placement.slots[a]->start < placement.slots[b]->start;
    return placement.matchups[a].key < placement.matchups[b].key;
  });
  out.beginArray();
  for (const size_t i : order) {
    const Matchup& matchup = placement.matchups[i];
    const Slot& slot = *placement.slots[i];
    out.beginObject();
    out.key("key").string(matchup.key);
    out.key("seasonId").string(matchup.seasonId);
    out.key("homeTeamId").string(input.teams.name(matchup.home));
    out.key("awayTeamId").string(input.teams.name(matchup.away));
    out.key("exhibition").boolean(matchup.exhibition);
    out.key("fieldId").string(input.fieldNames.name(slot.field));
    out.key("size").string(input.sizes.name(slot.size));
    out.key("startAt").string(isoString(slot.start));
    out.key("endAt").string(isoString(slot.end));
    out.endObject();
  }
  out.endArray();
}

// managerCauseOfOption: replays the option through the occupancy rules to
// name a manager who blocks an unplaced game.
class PlacedCause {
 public:
  PlacedCause(const RunContext& context, const Placement& placement)
      : context_(context), placement_(placement) {}

  std::optional<int> operator()(const SeasonContext& season,
                                const std::vector<Matchup>& unplaced) {
    if (unplaced.empty()) return std::nullopt;
    if (!occupied_) {
      occupied_ = std::make_unique<Occupancy>(context_);
      for (size_t i = 0; i < placement_.slots.size(); ++i) {
        if (placement_.slots[i] == nullptr) continue;
        const Matchup& game = placement_.matchups[i];
        occupied_->place(static_cast<int64_t>(i), *context_.seasonOf(game.seasonId), game.home,
                         game.away, *placement_.slots[i]);
      }
    }
    return blockedByManager(context_, season, unplaced, occupied_.get());
  }

 private:
  const RunContext& context_;
  const Placement& placement_;
  std::unique_ptr<Occupancy> occupied_;
};

void writeUnmet(Writer& out, const RunContext& context, const Settlement& settlement,
                const Placement& placement,
                std::map<std::pair<int, GameKind>, Cause>& causeMemo) {
  const Input& input = *context.input;
  PlacedCause placedCause(context, placement);
  out.beginArray();
  for (const SeasonContext& season : context.seasons) {
    const std::string& id = season.season->id;
    if (context.hasRequired) {
      int required = 0;
      std::vector<Matchup> unplaced;
      for (size_t i = 0; i < placement.matchups.size(); ++i) {
        if (placement.matchups[i].seasonId != id) continue;
        ++required;
        if (placement.slots[i] == nullptr) unplaced.push_back(placement.matchups[i]);
      }
      if (unplaced.empty()) continue;
      Cause cause;
      const auto team =
          settlement.provenOptimal ? placedCause(season, unplaced) : std::nullopt;
      if (!settlement.provenOptimal) {
        cause = Cause{season.index, GameKind::Required, Rule::TimeLimit, -1, required};
      } else if (team) {
        cause = managerCause(season, GameKind::Required, required, *team);
      } else {
        const auto exact = settlement.causes.find({season.index, GameKind::Required});
        cause = exact != settlement.causes.end() ? exact->second
                                                 : requiredCause(context, season, unplaced);
      }
      out.beginObject();
      out.key("seasonId").string(id);
      out.key("kind").string("required");
      out.key("required").integer(required);
      out.key("unplaced").integer(static_cast<int64_t>(unplaced.size()));
      out.key("cause");
      writeCause(out, context, cause);
      out.endObject();
      continue;
    }
    const Targets requested = requestedTargets(season);
    const Targets target = settlement.targets.size() > static_cast<size_t>(season.index)
                               ? settlement.targets[season.index]
                               : requested;
    std::vector<int> teams;
    for (const int team : season.season->participants)
      if (context.isActive(team)) teams.push_back(team);
    for (const GameKind kind : {GameKind::Regular, GameKind::Exhibition}) {
      const bool exhibition = kind == GameKind::Exhibition;
      const int asked = exhibition ? requested.exhibition : requested.regular;
      const int reached = exhibition ? target.exhibition : target.regular;
      if (asked == 0) continue;
      std::unordered_map<int, int> totals;
      for (const int team : teams) totals[team] = 0;
      auto count = [&](int team) {
        const auto found = totals.find(team);
        if (found != totals.end()) found->second++;
      };
      for (const FixedPoint& fixed : season.fixed) {
        const FixedGame& game = input.fixed[fixed.game];
        if (game.exhibition != exhibition) continue;
        count(game.home);
        count(game.away);
      }
      std::vector<Matchup> unplaced;
      for (size_t i = 0; i < placement.matchups.size(); ++i) {
        const Matchup& matchup = placement.matchups[i];
        if (matchup.seasonId != id || matchup.exhibition != exhibition) continue;
        if (placement.slots[i] == nullptr) {
          unplaced.push_back(matchup);
        } else {
          count(matchup.home);
          count(matchup.away);
        }
      }
      if (teams.empty()) continue;
      if (unplaced.empty() && reached >= asked) continue;
      Cause cause;
      // A schedule not proven the best says so, and names no other cause.
      const auto team =
          settlement.provenOptimal ? placedCause(season, unplaced) : std::nullopt;
      if (!settlement.provenOptimal) {
        cause = Cause{season.index, kind, Rule::TimeLimit, -1, asked};
      } else if (team) {
        cause = managerCause(season, kind, asked, *team);
      } else {
        const auto key = std::make_pair(season.index, kind);
        auto memo = causeMemo.find(key);
        if (memo == causeMemo.end()) {
          const auto exact = settlement.causes.find(key);
          memo = causeMemo
                     .emplace(key, exact != settlement.causes.end()
                                       ? exact->second
                                       : capacityCause(context, season, kind, asked))
                     .first;
        }
        cause = memo->second;
      }
      out.beginObject();
      out.key("seasonId").string(id);
      out.key("kind").string(kindName(kind));
      out.key("requested").integer(asked);
      out.key("totals").beginArray();
      for (const int team : teams) {
        out.beginObject();
        out.key("teamId").string(input.teams.name(team));
        out.key("total").integer(totals[team]);
        out.endObject();
      }
      out.endArray();
      out.key("cause");
      writeCause(out, context, cause);
      out.endObject();
    }
  }
  out.endArray();
}

std::string failureJson(const Failure& failure) {
  Writer out;
  out.beginObject();
  out.key("kind").string("failure");
  out.key("failure").string(failure.failure);
  out.key("message").string(failure.what());
  if (failure.columns >= 0) out.key("columns").integer(failure.columns);
  if (failure.limit >= 0) out.key("limit").integer(failure.limit);
  out.endObject();
  return out.text();
}

std::string build(const std::string& text, const Solver* given, const ExactOptions* given_options,
                  const Reporter* reporter) {
  const Request request = readRequest(json::parse(text));
  Session session(reporter, request.limitMs);
  session.phaseStart("context");
  PhaseTimer phase(session);
  const std::shared_ptr<RunContext> context = buildContext(request.input);
  const Input& input = *context->input;
  Writer out;
  out.beginObject();
  out.key("kind").string("options");
  // A blocked run answers before any solve.
  const auto blocking = blockingCause(*context);
  session.phase("context", phase.ms());
  if (blocking) {
    out.key("options").beginArray().endArray();
    out.key("blocking");
    writeCause(out, *context, *blocking);
    out.key("provenOptimal").boolean(true);
    out.endObject();
    return out.text();
  }
  throwIfCanceled();
  ExactOptions options;
  if (given_options != nullptr) {
    options = *given_options;
  } else {
    options.deadlineMs = request.limitMs;
    options.maxColumns = request.maxColumns;
    options.session = &session;
  }
  const Solver solve =
      given != nullptr ? *given : highsSolver(input.seed, options.session);
  const Settlement settlement = exactSettle(*context, solve, options);

  // The exact placement, polished from every seed and weighting.
  session.phaseStart("polish");
  const PhaseTimer polish(session);
  std::vector<Placement> candidates;
  const uint32_t seed = toUint32(input.seed);
  for (uint32_t k = 0; k < static_cast<uint32_t>(kSeeds); ++k)
    for (size_t w = 0; w < kWeightings.size(); ++w) {
      throwIfCanceled();
      std::optional<Placement> placement =
          placeFrom(*context, settlement.matchups, settlement.slots,
                    nthSeed(nthSeed(seed, k), static_cast<uint32_t>(w)), kWeightings[w]);
      if (!placement) throw Failure("broken", "An exact slot breaks a hard rule");
      candidates.push_back(std::move(*placement));
    }
  const std::vector<const Placement*> chosen = chooseOptions(candidates);
  session.phase("polish", polish.ms());
  session.phaseStart("options");
  const PhaseTimer written(session);
  std::map<std::pair<int, GameKind>, Cause> causeMemo;
  out.key("options").beginArray();
  for (const Placement* placement : chosen) {
    throwIfCanceled();
    out.beginObject();
    out.key("games");
    writeGames(out, *context, *placement);
    out.key("fairness");
    writeFairness(out, *context, *placement);
    out.key("reasons").beginArray();
    if (placement != chosen.front())
      for (const Reason& reason : optionReasons(*placement, *chosen.front()))
        writeReason(out, input, reason);
    out.endArray();
    out.key("unmet");
    writeUnmet(out, *context, settlement, *placement, causeMemo);
    out.key("score").beginArray();
    for (const double value : placement->score) out.number(storedScore(value));
    out.endArray();
    out.endObject();
  }
  out.endArray();
  out.key("blocking").null();
  out.key("provenOptimal").boolean(settlement.provenOptimal);
  // What the settlement reached, each season: for tests and the log.
  out.key("targets").beginArray();
  for (size_t s = 0; s < context->seasons.size() && s < settlement.targets.size(); ++s) {
    out.beginObject();
    out.key("seasonId").string(context->seasons[s].season->id);
    out.key("regular").integer(settlement.targets[s].regular);
    out.key("exhibition").integer(settlement.targets[s].exhibition);
    out.endObject();
  }
  out.endArray();
  out.endObject();
  session.phase("options", written.ms());
  return out.text();
}

}  // namespace

// ------------------------------------------------------------- the session

Session::Session(const Reporter* reporter, double limitMs, std::function<double()> now)
    : reporter_(reporter), limitMs_(limitMs), now_(std::move(now)) {
  if (!now_) {
    const auto started = std::chrono::steady_clock::now();
    now_ = [started] {
      return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
          .count();
    };
  }
}

void Session::emit(const std::string& event) const {
  if (reporter_ != nullptr && reporter_->emit) reporter_->emit(event);
}

namespace {

void writeDetail(Writer& out, const PhaseDetail& detail) {
  if (detail.columns < 0 && detail.rows < 0 && detail.seasonName.empty()) return;
  out.key("detail").beginObject();
  if (detail.columns >= 0) out.key("columns").integer(detail.columns);
  if (detail.rows >= 0) out.key("rows").integer(detail.rows);
  if (!detail.seasonName.empty()) out.key("seasonName").string(detail.seasonName);
  out.endObject();
}

}  // namespace

void Session::phaseStart(const char* name, const PhaseDetail& detail) const {
  if (reporter_ == nullptr || !reporter_->emit) return;
  Writer out;
  out.beginObject();
  out.key("kind").string("phase-start");
  out.key("phase").string(name);
  writeDetail(out, detail);
  out.endObject();
  emit(out.text());
}

void Session::phase(const char* name, double ms, const PhaseDetail& detail) const {
  if (reporter_ == nullptr || !reporter_->emit) return;
  Writer out;
  out.beginObject();
  out.key("kind").string("phase");
  out.key("phase").string(name);
  out.key("ms").integer(static_cast<int64_t>(std::llround(std::max(0.0, ms))));
  writeDetail(out, detail);
  out.endObject();
  emit(out.text());
}

void Session::progress(int incumbentGames, int boundGames) const {
  if (reporter_ == nullptr || !reporter_->emit) return;
  const int bound = std::max(incumbentGames, boundGames);
  Writer out;
  out.beginObject();
  out.key("kind").string("progress");
  out.key("incumbentGames").integer(incumbentGames);
  out.key("boundGames").integer(bound);
  out.key("gap").number(bound > 0 ? static_cast<double>(bound - incumbentGames) / bound : 0);
  out.endObject();
  emit(out.text());
}

void Session::startSolve() {
  const double at = now();
  if (firstStart_ < 0) firstStart_ = at;
  if (deadline_ < 0 || fresh_) deadline_ = at + limitMs_;
  fresh_ = false;
}

Decision Session::pause(Stage stage, std::optional<int> bestGames, int boundGames) {
  Writer out;
  out.beginObject();
  out.key("kind").string("limit");
  out.key("stage").string(stage == Stage::Targets ? "targets" : "placement");
  out.key("bestGames");
  if (bestGames)
    out.integer(*bestGames);
  else
    out.null();
  out.key("boundGames").integer(bestGames ? std::max(*bestGames, boundGames) : boundGames);
  out.key("solvedMs").integer(static_cast<int64_t>(std::llround(solvedMs())));
  out.endObject();
  emit(out.text());
  Decision decision = Decision::Use;
  const double asked = now();
  if (reporter_ != nullptr && reporter_->decide) decision = reporter_->decide();
  const double answered = now();
  paused_ += answered - asked;
  switch (decision) {
    case Decision::Continue:
      deadline_ = answered + limitMs_;
      break;
    case Decision::Use:
      fresh_ = true;
      break;
    default:
      canceled_ = true;
  }
  return decision;
}

double Session::solvedMs() const {
  return firstStart_ < 0 ? 0 : std::max(0.0, now() - firstStart_ - paused_);
}

double Session::remainingMs() const {
  return deadline_ < 0 ? 0 : std::max(0.0, deadline_ - now());
}

std::string buildSchedule(const std::string& request, const Solver& solve,
                          const ExactOptions* options) {
  try {
    return build(request, &solve, options, nullptr);
  } catch (const Failure& failure) {
    return failureJson(failure);
  } catch (const std::exception& error) {
    return failureJson(Failure("broken", error.what()));
  } catch (...) {
    return failureJson(Failure("broken", "The engine failed"));
  }
}

namespace {

thread_local const std::atomic<bool>* cancelFlag = nullptr;

}  // namespace

CancelScope::CancelScope(const std::atomic<bool>* flag) : previous_(cancelFlag) {
  cancelFlag = flag;
}

CancelScope::~CancelScope() { cancelFlag = previous_; }

bool canceled() {
  return cancelFlag != nullptr && cancelFlag->load(std::memory_order_relaxed);
}

void throwIfCanceled() {
  if (canceled()) throw Failure("canceled", "The build was canceled");
}

namespace {

std::string reported(const std::string& request, const Reporter* reporter) {
  std::string out;
  try {
    out = build(request, nullptr, nullptr, reporter);
  } catch (const Failure& failure) {
    out = failureJson(failure);
  } catch (const std::exception& error) {
    out = failureJson(Failure("broken", error.what()));
  } catch (...) {
    out = failureJson(Failure("broken", "The engine failed"));
  }
  // HiGHS keeps a scheduler per thread; the next build may come on another.
  Highs::resetGlobalScheduler(true);
  return out;
}

}  // namespace

std::string buildSchedule(const std::string& request, const std::atomic<bool>& cancel) {
  const CancelScope scope(&cancel);
  return buildSchedule(request);
}

std::string buildSchedule(const std::string& request, const std::atomic<bool>& cancel,
                          const Reporter& reporter) {
  const CancelScope scope(&cancel);
  return reported(request, &reporter);
}

std::string buildSchedule(const std::string& request) { return reported(request, nullptr); }

}  // namespace teamstation::scheduler
