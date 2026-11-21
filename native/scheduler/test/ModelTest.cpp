// The exact model: its rows, the settle, placement and cause solves,
// lowering, required matchups and exhibition games, with HiGHS and with
// stand-in solvers.
#include <cmath>
#include <map>
#include <set>

#include <sys/resource.h>

#include "Engine.h"
#include "Fixtures.h"
#include "doctest.h"

using namespace teamstation::scheduler;
using fixtures::Run;

namespace {

const std::vector<std::string> kFour{"tem_hawks", "tem_owls", "tem_foxes", "tem_bears"};
const std::vector<std::string> kThree{"tem_hawks", "tem_owls", "tem_foxes"};

// Replays a settlement through the engine's own rules: every game fits as it
// is placed; each team's new games.
std::map<std::string, int> replay(const RunContext& context, const Settlement& settlement) {
  Occupancy occupancy(context);
  std::map<std::string, int> teams;
  for (size_t i = 0; i < settlement.matchups.size(); ++i) {
    const Matchup& matchup = settlement.matchups[i];
    const Slot* slot = settlement.slots[i];
    if (slot == nullptr) continue;
    const SeasonContext* season = context.seasonOf(matchup.seasonId);
    REQUIRE(season != nullptr);
    CHECK(occupancy.fits(*season, matchup.home, matchup.away, *slot));
    occupancy.place(static_cast<int64_t>(i), *season, matchup.home, matchup.away, *slot);
    teams[context.input->teams.name(matchup.home)]++;
    teams[context.input->teams.name(matchup.away)]++;
  }
  return teams;
}

Settlement settle(const Run& run, const Solver* solve = nullptr,
                  const ExactOptions& options = ExactOptions{}) {
  const auto context = fixtures::context(run);
  return exactSettle(*context, solve != nullptr ? *solve : highsSolver(run.seed), options);
}

struct Settled {
  std::shared_ptr<RunContext> context;
  Settlement settlement;
  std::map<std::string, int> teams;
};

Settled settled(const Run& run, const Solver* solve = nullptr) {
  Settled out;
  out.context = fixtures::context(run);
  out.settlement =
      exactSettle(*out.context, solve != nullptr ? *solve : highsSolver(run.seed), ExactOptions{});
  out.teams = replay(*out.context, out.settlement);
  return out;
}

Run small(const std::vector<std::string>& teams, int games = 2) {
  Run run;
  run.seasons[0].participants = teams;
  run.seasons[0].regularGames = games;
  return run;
}

// Two Saturdays, Hawks against Owls, never two a day.
Run twoSaturdays() {
  Run run = small({"tem_hawks", "tem_owls"}, 2);
  run.seasons[0].doubleheaders = "never";
  run.seasons[0].startsOn = "2027-03-06";
  run.seasons[0].endsOn = "2027-03-13";
  run.seasons[0].windows = {{"2027-03-06", "2027-03-13", {{{6}, "08:00", "18:00"}}}};
  return run;
}

fixtures::Booking firstSaturday(const std::vector<std::string>& teams, bool managerOnly = false) {
  return {"", teams, managerOnly, fixtures::at("2027-03-06T13:00:00Z"),
          fixtures::at("2027-03-07T01:00:00Z")};
}

std::string cause(const Settlement& settlement, int season = 0,
                  GameKind kind = GameKind::Regular) {
  const auto found = settlement.causes.find({season, kind});
  if (found == settlement.causes.end()) return "none";
  switch (found->second.rule) {
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
    default:
      return "capacity";
  }
}

// Answers like HiGHS, counting the calls.
Solver counted(int& calls, std::function<std::optional<SolveResult>(int, const Model&)> stand) {
  return [&calls, stand](const Model& model, double seconds) {
    ++calls;
    if (const auto answer = stand(calls, model)) return *answer;
    return highsSolver(7)(model, seconds);
  };
}

SolveResult answer(SolveStatus status) { return {status, 0, {}}; }

// Two two-team seasons on two fields, each asked for three, and a stand-in
// that settles both at two, which tightens their pair caps, then answers the
// given calls infeasible.
Run tightened() {
  Run run;
  run.fields.push_back(fixtures::Field{});
  run.fields[1].id = "fld_two";
  fixtures::Season a = run.seasons[0];
  a.participants = {"tem_hawks", "tem_owls"};
  a.regularGames = 3;
  a.startsOn = "2027-03-06";
  a.endsOn = "2027-03-13";
  a.windows = {{"2027-03-06", "2027-03-13", {{{6}, "08:00", "18:00"}}}};
  fixtures::Season b = a;
  b.id = "sea_other";
  b.participants = {"tem_foxes", "tem_bears"};
  b.fieldIds = {"fld_two"};
  run.seasons = {a, b};
  return run;
}

Solver tightening(int& calls, std::vector<int> infeasible, std::vector<std::string>* asked) {
  return counted(calls, [infeasible, asked](int call, const Model& model) -> std::optional<SolveResult> {
    if (asked != nullptr) {
      std::string bounds;
      for (size_t j = 0; j < model.colLower.size(); ++j)
        bounds += std::to_string(model.colLower[j]) + ":" + std::to_string(model.colUpper[j]) + ",";
      asked->push_back(bounds);
    }
    if (call == 1) {
      Model lower = model;
      for (size_t j = 0; j < lower.colCost.size(); ++j)
        if (lower.colCost[j] == 1) lower.colUpper[j] -= 1;
      return highsSolver(7)(lower, 30);
    }
    for (const int each : infeasible)
      if (each == call) return answer(SolveStatus::Infeasible);
    return std::nullopt;
  });
}

// A settle under a session on a clock of the test's own, which each solve
// moves on 100 ms: each phase's start (`+`) and end (`-`), the time the ends
// report together, and the time the settle took.
struct Stepped {
  std::vector<std::string> steps;
  double reportedMs = 0;
  double spanMs = 0;
};

Stepped stepped(const Run& run, const Solver& inner) {
  Stepped out;
  double clock = 0;
  const auto now = [&clock] { return clock; };
  Reporter reporter;
  reporter.emit = [&out](const std::string& text) {
    const json::Value event = json::parse(text);
    const std::string kind = fixtures::text(event.find("kind"));
    if (kind != "phase-start" && kind != "phase") return;
    out.steps.push_back((kind == "phase" ? "-" : "+") + fixtures::text(event.find("phase")));
    if (kind == "phase") out.reportedMs += fixtures::number(event.find("ms"));
  };
  Session session(&reporter, 600'000, now);
  ExactOptions options;
  options.session = &session;
  options.now = now;
  const Solver solve = [&clock, &inner](const Model& model, const Limits& limits) {
    clock += 100;
    return inner(model, limits.seconds);
  };
  const auto context = fixtures::context(run);
  exactSettle(*context, solve, options);
  out.spanMs = clock;
  return out;
}

}  // namespace

TEST_CASE("the first model: a target per season, the parity column, short columns for an odd ask") {
  const auto context = fixtures::context(small(kFour));
  const auto model = targetModel(*context, 400'000);
  REQUIRE(model);
  REQUIRE(model->targetCols.size() == 1);
  const int g = model->targetCols[0];
  CHECK(model->model.colUpper[g] == 2);
  CHECK(model->model.colCost[g] == 1);
  int free = 0;
  for (size_t j = 0; j < model->model.colLower.size(); ++j)
    if (std::isinf(model->model.colLower[j]) && std::isinf(model->model.colUpper[j])) ++free;
  CHECK(free == 1);  // the parity row's `half`
  CHECK(model->model.rowStart.size() == model->model.rowLower.size() + 1);
  CHECK(!targetModel(*context, 1));
  Run required = small(kFour);
  required.required = true;
  CHECK(!targetModel(*fixtures::context(required), 400'000));
  Run none = small(kFour);
  none.seasons.clear();
  CHECK(!targetModel(*fixtures::context(none), 400'000));
  // Three teams asked for one game: one team may stay short.
  const auto odd = targetModel(*fixtures::context(small(kThree, 1)), 400'000);
  REQUIRE(odd);
  int shortCols = 0;
  for (size_t j = 0; j < odd->model.colLower.size(); ++j)
    if (j != static_cast<size_t>(odd->targetCols[0]) && odd->model.colUpper[j] == 1 &&
        odd->model.colCost[j] == 0 && j + 1 < odd->model.colLower.size() &&
        std::isinf(odd->model.colUpper.back()))
      ++shortCols;
  CHECK(shortCols > 0);
}

TEST_CASE("need, parity and pair-cap rows: every team its need, pairs within the cap") {
  const Settled four = settled(small(kFour));
  CHECK(four.settlement.targets[0].regular == 2);
  for (const auto& team : kFour) CHECK(four.teams.at(team) == 2);
  const Settled three = settled(small(kThree, 4));
  std::map<std::pair<int, int>, int> pairs;
  for (const Matchup& matchup : three.settlement.matchups)
    pairs[{std::min(matchup.home, matchup.away), std::max(matchup.home, matchup.away)}]++;
  for (const auto& [pair, count] : pairs) CHECK(count <= 2);
  const Settled odd = settled(small(kThree, 1));
  CHECK(odd.settlement.matchups.size() == 1);
  Run partial = small(kThree, 1);
  partial.partial = true;
  partial.teamIds = {"tem_hawks", "tem_owls"};
  CHECK(settled(partial).settlement.matchups.size() == 1);
  // Keys as buildMatchups gives them.
  for (const Matchup& matchup : settled(small(kFour, 3)).settlement.matchups)
    CHECK(matchup.key.rfind("sea_demo:", 0) == 0);
}

TEST_CASE("fixed games count toward needs, and a team past its request gets none") {
  Run run = small(kFour);
  for (int day = 1; day <= 3; ++day) {
    fixtures::Game game;
    game.key = "fixed" + std::to_string(day);
    game.home = "tem_hawks";
    game.away = "tem_owls";
    game.start = fixtures::at("2027-02-0" + std::to_string(day) + "T15:00:00Z");
    run.fixed.push_back(game);
  }
  const Settled result = settled(run);
  CHECK(result.teams.count("tem_hawks") == 0);
  CHECK(result.teams.at("tem_foxes") == 2);
}

TEST_CASE("field rows: one game at a time with buffers and the switch time between sizes") {
  Run run;
  fixtures::Season a = run.seasons[0];
  a.participants = {"tem_hawks", "tem_owls"};
  a.regularGames = 1;
  a.startsOn = a.endsOn = "2027-03-06";
  a.windows = {{"2027-03-06", "2027-03-06", {{{6}, "08:00", "12:00"}}}};
  fixtures::Season b = a;
  b.id = "sea_other";
  b.participants = {"tem_foxes", "tem_bears"};
  b.fieldSize = "46/60";
  run.seasons = {a, b};
  const Settled result = settled(run);
  CHECK(result.settlement.matchups.size() == 2);
  // Without the switch time, the same.
  run.fields[0].switchMinutes = 0;
  CHECK(settled(run).settlement.matchups.size() == 2);
}

TEST_CASE("team rows: one game at a time across seasons, doubleheaders and week parts") {
  Run run;
  run.fields.push_back(fixtures::Field{});
  run.fields[1].id = "fld_two";
  fixtures::Season a = run.seasons[0];
  a.participants = {"tem_hawks", "tem_owls"};
  a.startsOn = "2027-03-06";
  a.endsOn = "2027-03-13";
  a.windows = {{"2027-03-06", "2027-03-13", {{{6}, "08:00", "09:30"}}}};
  fixtures::Season b = a;
  b.id = "sea_other";
  b.participants = {"tem_hawks", "tem_foxes"};
  b.fieldIds = {"fld_two"};
  run.seasons = {a, b};
  CHECK(settled(run).teams.at("tem_hawks") == 2);

  Run doubles = small(kFour, 4);
  doubles.seasons[0].doubleheaders = "never";
  doubles.seasons[0].startsOn = "2027-03-06";
  doubles.seasons[0].endsOn = "2027-03-13";
  doubles.seasons[0].windows = {{"2027-03-06", "2027-03-13", {{{6}, "08:00", "18:00"}}}};
  const Settled held = settled(doubles);
  CHECK(held.settlement.targets[0].regular == 2);
  CHECK(cause(held.settlement) == "doubleheaders");

  Run weekly = small(kFour, 4);
  weekly.seasons[0].maxWeekdays = 0;
  weekly.seasons[0].maxWeekend = 1;
  weekly.seasons[0].startsOn = "2027-03-06";
  weekly.seasons[0].endsOn = "2027-03-21";
  weekly.seasons[0].windows = {{"2027-03-06", "2027-03-21", {{{0, 1, 2, 3, 4, 5, 6}, "08:00", "18:00"}}}};
  weekly.fields[0].hours = {{{0, 1, 2, 3, 4, 5, 6}, "08:00", "18:00"}};
  weekly.fields[0].windows = true;
  const Settled parts = settled(weekly);
  CHECK(parts.settlement.targets[0].regular == 3);
  CHECK(cause(parts.settlement) == "weekParts");
}

TEST_CASE("manager rows and causes: a manager busy elsewhere, or their own booking") {
  Run busy = twoSaturdays();
  busy.headCoaches = {{"tem_hawks", "coach:one"}, {"tem_outside", "coach:one"}};
  busy.bookings = {firstSaturday({"tem_outside"})};
  const Settled one = settled(busy);
  CHECK(one.settlement.targets[0].regular == 1);
  CHECK(cause(one.settlement) == "manager");
  CHECK(one.context->input->teams.name(one.settlement.causes.begin()->second.team) == "tem_hawks");

  Run own = twoSaturdays();
  own.headCoaches = {{"tem_owls", "coach:one"}};
  own.bookings = {firstSaturday({"tem_owls"}, true)};
  CHECK(cause(settled(own).settlement) == "manager");

  // Both managed, and Owls' manager coaches the booked team too: ties of
  // games held go to the name, and only the held team counts.
  Run held = twoSaturdays();
  held.headCoaches = {{"tem_hawks", "coach:hawks"}, {"tem_owls", "coach:owls"}, {"tem_outside", "coach:owls"}};
  held.bookings = {firstSaturday({"tem_outside"})};
  const Settled named = settled(held);
  CHECK(named.context->input->teams.name(named.settlement.causes.begin()->second.team) == "tem_owls");

  // The teams' own bookings, not a rule, hold them: no exact cause.
  Run booked = twoSaturdays();
  booked.seasons[0].windows = {{"2027-03-06", "2027-03-13", {{{6}, "08:00", "09:30"}}}};
  booked.bookings = {firstSaturday({"tem_hawks"})};
  CHECK(cause(settled(booked).settlement) == "none");

  // Two seasons on one field sharing a head coach.
  Run sharedCoach;
  fixtures::Season a = sharedCoach.seasons[0];
  a.participants = {"tem_hawks", "tem_owls", "tem_foxes"};
  a.bufferMinutes = 0;
  a.windows = {{"2027-03-01", "2027-03-31", {{{6}, "08:00", "11:00"}}}};
  fixtures::Season b = a;
  b.id = "sea_b";
  b.participants = {"tem_bears", "tem_wolves", "tem_lynx"};
  b.regularGames = 4;
  sharedCoach.seasons = {a, b};
  sharedCoach.headCoaches = {{"tem_hawks", "coach:shared"}, {"tem_bears", "coach:shared"}};
  // Which season stays short is a tie; its cause is field time.
  const Settled full = settled(sharedCoach);
  const int shortSeason = full.settlement.targets[0].regular < 2 ? 0 : 1;
  CHECK(cause(full.settlement, shortSeason) == "fieldTime");
}

TEST_CASE("a stand-in cause solve whose answer holds no game names no team") {
  Run run = twoSaturdays();
  run.headCoaches = {{"tem_hawks", "coach:one"}, {"tem_outside", "coach:one"}};
  run.bookings = {firstSaturday({"tem_outside"})};
  int calls = 0;
  const Solver solve = counted(calls, [](int call, const Model& model) -> std::optional<SolveResult> {
    if (call == 2) return SolveResult{SolveStatus::Optimal, 0, std::vector<double>(model.colCost.size(), 0)};
    return std::nullopt;
  });
  const Settlement settlement = settle(run, &solve);
  CHECK(settlement.targets[0].regular == 1);
  CHECK(cause(settlement) == "none");
}

TEST_CASE("the first answer is the placement when no pair cap tightened") {
  int calls = 0;
  const Solver solve = counted(calls, [](int call, const Model&) -> std::optional<SolveResult> {
    if (call > 1) return answer(SolveStatus::TimeLimit);
    return std::nullopt;
  });
  const Settled result = settled(small(kFour), &solve);
  CHECK(result.settlement.targets[0].regular == 2);
  CHECK(calls == 1);
}

TEST_CASE("a cause solve out of time keeps the settlement, with no exact cause") {
  Run run = small(kFour, 4);
  run.seasons[0].doubleheaders = "never";
  run.seasons[0].startsOn = "2027-03-06";
  run.seasons[0].endsOn = "2027-03-13";
  run.seasons[0].windows = {{"2027-03-06", "2027-03-13", {{{6}, "08:00", "18:00"}}}};
  int calls = 0;
  const Solver solve = counted(calls, [](int call, const Model&) -> std::optional<SolveResult> {
    if (call > 2) return answer(SolveStatus::TimeLimit);
    return std::nullopt;
  });
  const Settlement settlement = settle(run, &solve);
  CHECK(settlement.targets[0].regular == 2);
  CHECK(settlement.causes.empty());
}

TEST_CASE("lowering: the first tightened season that lets the placement through") {
  int calls = 0;
  const Solver first = tightening(calls, {2}, nullptr);
  const Settlement one = settle(tightened(), &first);
  CHECK(one.targets[0].regular == 1);
  CHECK(one.targets[1].regular == 2);

  calls = 0;
  const Solver second = tightening(calls, {2, 3}, nullptr);
  const Settlement two = settle(tightened(), &second);
  CHECK(two.targets[0].regular == 2);
  CHECK(two.targets[1].regular == 1);

  // No lone trial helps: the first stays lowered, its trial is not solved
  // again, and the next trial lowers it once more.
  calls = 0;
  std::vector<std::string> asked;
  const Solver third = tightening(calls, {2, 3, 4}, &asked);
  const Settlement three = settle(tightened(), &third);
  CHECK(three.targets[0].regular == 0);
  CHECK(three.targets[1].regular == 2);
  REQUIRE(asked.size() >= 5);
  const std::set<std::string> distinct(asked.begin(), asked.begin() + 5);
  CHECK(distinct.size() == 5);

  // Nothing left to lower: the most games that fit at the floors.
  calls = 0;
  std::vector<int> every;
  for (int call = 2; call < 40; ++call) every.push_back(call);
  const Solver none = tightening(calls, every, nullptr);
  CHECK_THROWS_AS(settle(tightened(), &none), Failure);
  calls = 0;
  std::vector<int> placements;
  for (int call = 2; call < 9; ++call) placements.push_back(call);
  const Solver floors = tightening(calls, placements, nullptr);
  const Settlement atFloors = settle(tightened(), &floors);
  CHECK(atFloors.lowered);
  CHECK(atFloors.targets[0].regular == 0);

  // A placement solve that fails another way is broken.
  calls = 0;
  const Solver error = counted(calls, [](int call, const Model& model) -> std::optional<SolveResult> {
    if (call == 1) {
      Model lower = model;
      for (size_t j = 0; j < lower.colCost.size(); ++j)
        if (lower.colCost[j] == 1) lower.colUpper[j] -= 1;
      return highsSolver(7)(lower, 30);
    }
    return answer(SolveStatus::Error);
  });
  CHECK_THROWS_AS(settle(tightened(), &error), Failure);
  calls = 0;
  const Solver trialError = counted(calls, [](int call, const Model& model) -> std::optional<SolveResult> {
    if (call == 1) {
      Model lower = model;
      for (size_t j = 0; j < lower.colCost.size(); ++j)
        if (lower.colCost[j] == 1) lower.colUpper[j] -= 1;
      return highsSolver(7)(lower, 30);
    }
    if (call == 2) return answer(SolveStatus::Infeasible);
    return answer(SolveStatus::Error);
  });
  CHECK_THROWS_AS(settle(tightened(), &trialError), Failure);
}

TEST_CASE("falling back to the floors ends the step it falls back from, once") {
  // From the placement, when no lowering lets it through.
  int calls = 0;
  std::vector<int> placements;
  for (int call = 2; call < 9; ++call) placements.push_back(call);
  const Stepped placing = stepped(tightened(), tightening(calls, placements, nullptr));
  CHECK(placing.steps == std::vector<std::string>{"+model", "-model", "+targets", "-targets",
                                                  "+placement", "-placement"});
  CHECK(placing.reportedMs == placing.spanMs);

  // From the targets, when their first solve is infeasible.
  calls = 0;
  const Solver infeasible = counted(calls, [](int call, const Model&) -> std::optional<SolveResult> {
    if (call == 1) return answer(SolveStatus::Infeasible);
    return std::nullopt;
  });
  const Stepped settling = stepped(small(kFour), infeasible);
  CHECK(settling.steps == std::vector<std::string>{"+model", "-model", "+targets", "-targets"});
  CHECK(settling.reportedMs == settling.spanMs);
}

TEST_CASE("the first solve: out of time or failed is broken; infeasible places the most at the floors") {
  for (const SolveStatus status : {SolveStatus::TimeLimit, SolveStatus::Error}) {
    int calls = 0;
    const Solver solve = counted(calls, [status](int, const Model&) -> std::optional<SolveResult> {
      return answer(status);
    });
    CHECK_THROWS_AS(settle(small(kFour), &solve), Failure);
  }
  int calls = 0;
  const Solver infeasible = counted(calls, [](int call, const Model&) -> std::optional<SolveResult> {
    if (call == 1) return answer(SolveStatus::Infeasible);
    return std::nullopt;
  });
  const Settled floors = settled(small(kFour), &infeasible);
  CHECK(floors.settlement.lowered);
  CHECK(floors.settlement.targets[0].regular == 0);
  calls = 0;
  const Solver never = counted(calls, [](int, const Model&) -> std::optional<SolveResult> {
    return answer(SolveStatus::Infeasible);
  });
  CHECK_THROWS_WITH_AS(settle(small(kFour), &never), "The floor solve found no schedule", Failure);
  // The deadline already gone.
  ExactOptions late;
  double clock = 0;
  late.now = [&clock] { return clock += 60'000; };
  CHECK_THROWS_WITH_AS(settle(small(kFour), nullptr, late), "The targets solve ran out of time",
                       Failure);
  // Too many columns.
  ExactOptions narrow;
  narrow.maxColumns = 1;
  try {
    settle(small(kFour), nullptr, narrow);
    FAIL("expected a failure");
  } catch (const Failure& failure) {
    CHECK(failure.failure == "broken");
    CHECK(failure.columns == 144);
    CHECK(failure.limit == 1);
  }
}

namespace {
// The process's peak resident memory so far, in bytes.
int64_t peakBytes() {
  rusage usage{};
  getrusage(RUSAGE_SELF, &usage);
#ifdef __APPLE__
  return static_cast<int64_t>(usage.ru_maxrss);
#else
  return static_cast<int64_t>(usage.ru_maxrss) * 1024;
#endif
}
}  // namespace

TEST_CASE("a model far over the column limit is counted, not allocated, and is broken") {
  // Sixty teams on every evening and weekend of half a year: millions of
  // game columns, which would take gigabytes to allocate.
  std::vector<std::string> teams;
  for (int i = 0; i < 60; ++i) teams.push_back("tem_" + std::to_string(i));
  Run run = small(teams, 20);
  run.seasons[0].startsOn = "2027-03-01";
  run.seasons[0].endsOn = "2027-08-31";
  run.seasons[0].gameMinutes = 30;
  run.seasons[0].bufferMinutes = 0;
  run.seasons[0].windows = {
      {"2027-03-01", "2027-08-31", {{{0, 1, 2, 3, 4, 5, 6}, "00:00", "24:00"}}}};
  run.fields[0].hours = {{{0, 1, 2, 3, 4, 5, 6}, "06:00", "23:00"}};
  const int64_t before = peakBytes();
  try {
    settle(run);
    FAIL("expected a failure");
  } catch (const Failure& failure) {
    CHECK(failure.failure == "broken");
    CHECK(failure.limit == 400'000);
    CHECK(failure.columns > 10 * failure.limit);
  }
  // Well under what the columns would take, about 50 bytes each.
  CHECK(peakBytes() - before < 256 * 1024 * 1024);
}

TEST_CASE("at the floors, the most games that fit: uneven totals when floors cannot all be reached") {
  Run run = small(std::vector<std::string>{"tem_hawks", "tem_owls", "tem_foxes", "tem_bears",
                                           "tem_wolves", "tem_lynx", "tem_elks"},
                  30);
  run.seasons[0].endsOn = "2027-03-06";
  run.seasons[0].exhibitionGames = 1;
  run.seasons[0].exhibitionTeams = {"tem_otters"};
  run.seasons[0].windows = {{"2027-03-01", "2027-03-31", {{{6}, "08:00", "18:00"}}}};
  run.fields[0].hours = {{{6}, "08:00", "09:30"}};
  fixtures::Game played;
  played.key = "g1";
  played.home = "tem_hawks";
  played.away = "tem_owls";
  played.field = "";
  played.start = fixtures::at("2027-03-07T15:00:00Z");
  run.fixed = {played};
  const Settled result = settled(run);
  CHECK(result.settlement.lowered);
  CHECK(result.settlement.targets[0].regular == 1);
  CHECK(result.settlement.matchups.size() == 1);  // the one slot
}

TEST_CASE("required matchups: the most placed, each once, and the cause of the rest") {
  Run run;
  run.seasons[0].endsOn = "2027-04-30";
  run.seasons[0].windows = {{"2027-03-01", "2027-04-30", {{{6}, "08:00", "18:00"}}}};
  run.required = true;
  run.matchups = {{"row_1", "sea_demo", "tem_hawks", "tem_owls"},
                  {"row_2", "sea_demo", "tem_bears", "tem_foxes"},
                  {"row_x", "sea_other", "tem_hawks", "tem_owls"}};
  const Settled all = settled(run);
  REQUIRE(all.settlement.matchups.size() == 2);
  CHECK(all.settlement.slots[0] != nullptr);
  CHECK(all.settlement.slots[1] != nullptr);
  CHECK(all.settlement.matchups[0].key == "row_1");

  // One Saturday with room for one game: field time.
  Run one = run;
  one.seasons[0].endsOn = "2027-03-06";
  one.fields[0].hours = {{{6}, "08:00", "09:30"}};
  const Settled tight = settled(one);
  CHECK((tight.settlement.slots[0] == nullptr) != (tight.settlement.slots[1] == nullptr));
  CHECK(cause(tight.settlement, 0, GameKind::Required) == "requiredUnplaced");

  // A manager booked all of the one Saturday.
  Run managed = one;
  managed.fields[0].hours = {{{6}, "08:00", "18:00"}};
  managed.matchups.resize(1);
  managed.headCoaches = {{"tem_hawks", "coach:one"}, {"tem_outside", "coach:one"}};
  managed.bookings = {firstSaturday({"tem_outside"})};
  managed.matchups.push_back({"row_2", "sea_demo", "tem_bears", "tem_foxes"});
  const Settled held = settled(managed);
  CHECK(held.settlement.slots[0] == nullptr);
  CHECK(cause(held.settlement, 0, GameKind::Required) == "manager");

  // A team busy all season: no column at all, no single rule to blame.
  Run busy = run;
  busy.bookings = {{"", {"tem_hawks"}, false, fixtures::at("2027-02-01T00:00:00Z"),
                    fixtures::at("2027-08-01T00:00:00Z")}};
  const Settled away = settled(busy);
  CHECK(away.settlement.slots[0] == nullptr);
  CHECK(away.settlement.slots[1] != nullptr);
  CHECK(cause(away.settlement, 0, GameKind::Required) == "none");

  // A stand-in placement solve that fails is broken; nothing to place is fine.
  const Solver failing = [](const Model&, double) { return answer(SolveStatus::TimeLimit); };
  CHECK_THROWS_AS(settle(run, &failing), Failure);
  Run nothing = run;
  nothing.matchups.clear();
  CHECK(settled(nothing).settlement.matchups.empty());
}

TEST_CASE("required matchups: the model's time starts with the settle, so the steps add up") {
  Run run;
  run.seasons[0].endsOn = "2027-04-30";
  run.seasons[0].windows = {{"2027-03-01", "2027-04-30", {{{6}, "08:00", "18:00"}}}};
  run.required = true;
  run.matchups = {{"row_1", "sea_demo", "tem_hawks", "tem_owls"},
                  {"row_2", "sea_demo", "tem_bears", "tem_foxes"}};
  const Stepped placed = stepped(run, highsSolver(7));
  CHECK(placed.steps == std::vector<std::string>{"+model", "-model", "+placement", "-placement"});
  CHECK(placed.spanMs == 100);
  CHECK(placed.reportedMs == placed.spanMs);

  // Nothing to place: the model's step, started before its candidates were
  // found, still ends.
  Run nothing = run;
  nothing.matchups.clear();
  const Stepped none = stepped(nothing, highsSolver(7));
  CHECK(none.steps == std::vector<std::string>{"+model", "-model"});
  CHECK(none.reportedMs == 0);
}

TEST_CASE("required matchups packed against what already holds the field and the teams") {
  Run run;
  run.seasons[0].regularGames = 1;
  run.seasons[0].endsOn = "2027-03-06";
  run.seasons[0].windows = {{"2027-03-01", "2027-03-06", {{{6}, "08:00", "14:20"}}}};
  run.fields[0].hours = {{{6}, "08:00", "14:20"}};
  fixtures::Game fixed;
  fixed.key = "f1";
  fixed.home = "tem_wolves";
  fixed.away = "tem_lynx";
  fixed.start = fixtures::at("2027-03-06T15:25:00Z");
  run.fixed = {fixed};
  run.bookings = {{"fld_one", {}, false, fixtures::at("2027-03-06T13:00:00Z"),
                   fixtures::at("2027-03-06T13:50:00Z")},
                  {"", {"tem_hawks"}, false, fixtures::at("2027-03-06T14:00:00Z"),
                   fixtures::at("2027-03-06T14:10:00Z")}};
  run.required = true;
  run.matchups = {{"row_1", "sea_demo", "tem_hawks", "tem_owls"},
                  {"row_2", "sea_demo", "tem_bears", "tem_foxes"}};
  const Settled result = settled(run);
  CHECK(result.settlement.slots[0] != nullptr);
  CHECK(result.settlement.slots[1] != nullptr);
}

TEST_CASE("exhibition games: each participant its need over its assignments, regular first") {
  Run run;
  run.seasons[0].participants = {"tem_hawks", "tem_owls", "tem_foxes", "tem_bears", "tem_wolves"};
  run.seasons[0].exhibitionTeams = {"tem_otters", "tem_lynx"};
  run.seasons[0].regularGames = 2;
  run.seasons[0].exhibitionGames = 2;
  run.seasons[0].endsOn = "2027-04-30";
  run.seasons[0].windows = {{"2027-03-01", "2027-04-30", {{{6}, "08:00", "18:00"}}}};
  const Settled result = settled(run);
  CHECK(result.settlement.targets[0].exhibition == 2);
  int exhibitions = 0;
  for (const Matchup& matchup : result.settlement.matchups)
    if (matchup.exhibition) ++exhibitions;
  CHECK(exhibitions == 10);

  // A participant with a fixed exhibition game against an assigned opponent.
  Run played = run;
  fixtures::Game game;
  game.key = "x1";
  game.home = "tem_hawks";
  game.away = "tem_otters";
  game.exhibition = true;
  game.start = fixtures::at("2027-03-06T14:00:00Z");
  played.fixed = {game, game};
  played.fixed[1].key = "x2";
  played.fixed[1].start = fixtures::at("2027-03-13T14:00:00Z");
  const Settled full = settled(played);
  CHECK(full.teams.at("tem_hawks") == 2);  // its regular games only

  // A partial run whose exhibition teams sit out: short only by that.
  Run partial = run;
  partial.partial = true;
  partial.teamIds = {"tem_hawks", "tem_owls"};
  const Settled sitting = settled(partial);
  for (const Matchup& matchup : sitting.settlement.matchups) CHECK(!matchup.exhibition);

  // Exhibition games lowered and their cause.
  Run tight = run;
  tight.seasons[0].endsOn = "2027-03-13";
  tight.fields[0].hours = {{{6}, "08:00", "14:50"}};
  const Settled lowered = settled(tight);
  CHECK(lowered.settlement.targets[0].regular == 2);
  CHECK(lowered.settlement.targets[0].exhibition < 2);
  CHECK(cause(lowered.settlement, 0, GameKind::Exhibition) != "none");
}

TEST_CASE("a model's rows hold through the build: switch time, buffers, managers across seasons") {
  // Managers who coach in two seasons on two fields.
  Run run;
  run.fields.push_back(fixtures::Field{});
  run.fields[1].id = "fld_two";
  fixtures::Season a = run.seasons[0];
  a.participants = {"tem_hawks", "tem_owls"};
  a.regularGames = 3;
  a.windows = {{"2027-03-01", "2027-03-31", {{{6}, "08:00", "12:00"}}}};
  fixtures::Season b = a;
  b.id = "sea_other";
  b.participants = {"tem_foxes", "tem_bears"};
  b.fieldIds = {"fld_two"};
  run.seasons = {a, b};
  run.headCoaches = {{"tem_hawks", "coach:x"}, {"tem_foxes", "coach:x"}};
  const Settled result = settled(run);
  CHECK(result.teams.at("tem_hawks") == 3);
  CHECK(result.teams.at("tem_foxes") == 3);
}
