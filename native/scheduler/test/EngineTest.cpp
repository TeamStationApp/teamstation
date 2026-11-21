// The build end to end, the seeded generator and matchups, the polish, the
// scores and the options, and the failures that replace the search.
#include <atomic>
#include <cmath>
#include <set>

#include "Engine.h"
#include "Fixtures.h"
#include "doctest.h"

using namespace teamstation::scheduler;
using fixtures::Run;

TEST_CASE("mulberry32, shuffles and seeds give random.ts's numbers") {
  const Random random = mulberry32(7);
  CHECK(random() == doctest::Approx(0.011704753153026104).epsilon(1e-15));
  CHECK(random() == doctest::Approx(0.06195825757458806).epsilon(1e-15));
  CHECK(random() == doctest::Approx(0.97690763277933).epsilon(1e-15));
  CHECK(nthSeed(7, 1) == 2654435776u);
  CHECK(nthSeed(4294967295u, 3) == 3668340010u);
  CHECK(shuffled({0, 1, 2, 3, 4}, mulberry32(3)) == std::vector<int>{2, 4, 1, 0, 3});
  CHECK(toUint32(-1) == 4294967295u);
  CHECK(toUint32(4294967297.0) == 1u);
  CHECK(toUint32(NAN) == 0u);
  CHECK(randomIndex([] { return 0.9999999999; }, 3) == 2);
}

TEST_CASE("regularPairs, orient and exhibitionOpponents give matchups.ts's answers") {
  std::map<std::pair<int, int>, int> met;
  const std::unordered_map<int, int> needs{{0, 3}, {1, 3}, {2, 3}, {3, 3}};
  CHECK(regularPairs({0, 1, 2, 3}, needs, met, 1) ==
        std::vector<std::pair<int, int>>{{0, 1}, {2, 3}, {0, 2}, {1, 3}, {0, 3}, {1, 2}});
  CHECK(orient({{0, 1}, {0, 2}, {0, 3}, {1, 2}}, {}) ==
        std::vector<std::pair<int, int>>{{0, 1}, {2, 0}, {0, 3}, {1, 2}});
  CHECK(orient({}, {}).empty());
  CHECK(exhibitionOpponents(1, 3, {10, 11}, {11}, 5) == std::vector<int>{10, 11});
  CHECK(exhibitionOpponents(0, 2, {}, {}, 2).empty());
  CHECK(exhibitionOpponents(0, 2, {10}, {}, 1) == std::vector<int>{10});
  // A pair over its cap swaps with another.
  std::map<std::pair<int, int>, int> seen{{{0, 1}, 2}};
  const auto swapped = regularPairs({0, 1, 2, 3}, {{0, 1}, {1, 1}, {2, 1}, {3, 1}}, seen, 1);
  CHECK(swapped.size() == 2);
  // A team leaning two ways hosts a chain of games.
  FixedGame home;
  home.home = 0;
  home.away = 5;
  const auto leaned = orient({{0, 1}, {1, 2}, {2, 3}}, {&home, &home});
  int hosted = 0;
  for (const auto& [h, a] : leaned)
    if (h == 0) ++hosted;
  CHECK(hosted == 0);
}

TEST_CASE("names compare as localeCompare orders plain names") {
  CHECK(localeLess("apple", "Banana"));
  CHECK(localeLess("Demo 9", "Demo A"));
  CHECK(localeLess("a b", "a1"));
  CHECK(localeLess("abc", "abcd"));
  CHECK(localeLess("abc", "Abc"));
  CHECK(!localeLess("Abc", "abc"));
  CHECK(localeLess("Zoë", "Zoë!"));
  CHECK(localeLess("a\xc3", "a\xc4"));
  CHECK(!localeLess("same", "same"));
}

TEST_CASE("scores: mixes, tallies, spacing and the comparison") {
  CHECK(compareScores({0, 0, 0, 0, 0, 0, 2}, {1, 0, 0, 0, 0, 0, 0}, kTrueOrder) == -1);
  CHECK(compareScores({0, 0, 0, 0, 0, 0, 0}, {0, 0, 0, 0, 0, 0, 1e-12}, kTrueOrder) == 0);
  const int counts[] = {1, 1};
  const int supply[] = {1, 3};
  CHECK(mixDeviation(counts, 2, 2, supply, 4) == doctest::Approx(0.5));
  CHECK(mixDeviation(counts, 2, 0, supply, 4) == 0);
  TeamTally tally(3, 100, 130);
  for (const int day : {101, 102, 102, 120}) tally.add({day, 0, 0});
  CHECK(tally.doubleheaders == 1);
  CHECK(tally.backToBack() == 3);
  CHECK(tally.gaps() == std::vector<int>{1, 1, 18, 10});
  CHECK(tally.unevenness(tally.spanDays()) == 3);
  tally.remove({102, 0, 0});
  CHECK(tally.doubleheaders == 0);
  tally.add({90, 0, 0});  // before the season can still get games
  CHECK(tally.spanDays().size() == 3);
  TeamTally none(0, 0, 10);
  CHECK(none.gaps().empty());
  none.add({5, 0, 0});
  CHECK(none.unevenness(none.spanDays()) == 1);
  CHECK(searchBudget(21) == 8400);
  CHECK(searchBudget(112) == 20'000);
}

TEST_CASE("placing from given slots: the polish keeps every game, and a slot that breaks a rule is refused") {
  Run run;
  const auto context = fixtures::context(run);
  const SeasonContext& season = context->seasons[0];
  const Input& input = *context->input;
  Matchup a{"a", "sea_demo", input.teams.find("tem_hawks"), input.teams.find("tem_owls"), false};
  Matchup b{"b", "sea_demo", input.teams.find("tem_foxes"), input.teams.find("tem_bears"), false};
  const Slot* first = &season.slots[0];
  const Slot* later = &season.slots[season.slots.size() / 2];
  const auto placed = placeFrom(*context, {a, b}, {first, later}, 5, kTrueOrder);
  REQUIRE(placed);
  CHECK(placed->score[kUnplaced] == 0);
  CHECK(placed->slots[0] != nullptr);
  CHECK(placed->slots[1] != nullptr);
  const auto clash = placeFrom(*context, {a, a}, {first, first}, 5, kTrueOrder);
  CHECK(!clash);
  // A game with no slot may be placed by the polish.
  const auto open = placeFrom(*context, {a, b}, {first, nullptr}, 5, kTrueOrder);
  REQUIRE(open);
  CHECK(open->score[kUnplaced] <= 1);
  Matchup stray{"c", "sea_none", a.home, a.away, false};
  CHECK_THROWS_AS(placeFrom(*context, {stray}, {nullptr}, 5, kTrueOrder), Failure);
}

TEST_CASE("the build: options, fairness, reasons and unmet lines in the result") {
  Run run;
  run.seasons[0].participants = {"tem_hawks", "tem_owls", "tem_foxes", "tem_bears",
                                 "tem_wolves", "tem_lynx"};
  run.seasons[0].exhibitionTeams = {"tem_otters"};
  run.seasons[0].regularGames = 4;
  run.seasons[0].exhibitionGames = 1;
  run.seasons[0].endsOn = "2027-05-31";
  run.seasons[0].windows = {{"2027-03-01", "2027-05-31",
                             {{{1, 2, 3, 4, 5}, "17:30", "21:00"}, {{6}, "08:00", "18:00"}}}};
  fixtures::Game played;
  played.key = "old";
  played.home = "tem_hawks";
  played.away = "tem_owls";
  played.start = fixtures::at("2026-10-10T15:00:00Z");
  run.fixed = {played};
  const auto built = fixtures::build(run);
  CHECK(fixtures::text(built.find("kind")) == "options");
  const auto& options = built.find("options")->array;
  REQUIRE(options.size() == 3);
  CHECK(options[0].find("reasons")->array.empty());
  CHECK(!options[1].find("reasons")->array.empty());
  CHECK(options[0].find("score")->array.size() == 7);
  const auto& fairness = options[0].find("fairness")->array;
  CHECK(fairness.size() == 7);
  for (const auto& row : fairness)
    if (row.find("teamId")->string == "tem_otters") CHECK(row.find("exhibitionTeam")->boolean);
  for (const auto& game : fixtures::games(built))
    CHECK(fixtures::text(game.find("startAt")).size() == 24);
  CHECK(built.find("blocking")->isNull());

  // The same through a stand-in that is HiGHS.
  const Solver highs = highsSolver(7);
  CHECK(fixtures::build(run, &highs).find("options")->array.size() == 3);
}

TEST_CASE("weekday and weekend preferences, and blackouts") {
  for (const char* prefer : {"weekend", "weekdays"}) {
    Run run;
    run.seasons[0].preferGameOn = prefer;
    run.seasons[0].regularGames = 1;
    run.seasons[0].blackouts = {"2027-03-13"};
    run.seasons[0].windows = {{"2027-03-01", "2027-03-31",
                               {{{1, 2, 3, 4, 5}, "17:30", "21:00"}, {{6}, "08:00", "18:00"}}}};
    run.fields[0].blackouts = {"2027-03-20"};
    const auto built = fixtures::build(run);
    for (const auto& game : fixtures::games(built)) {
      const std::string date = fixtures::text(game.find("startAt")).substr(0, 10);
      CHECK(date != "2027-03-13");
      CHECK(date != "2027-03-20");
    }
  }
}

TEST_CASE("stand-in solvers: a thrown model and an answer that breaks a hard rule are broken failures") {
  const Solver thrown = [](const Model&, double) -> SolveResult {
    throw std::runtime_error("out of memory");
  };
  const auto failed = fixtures::build(Run{}, &thrown);
  CHECK(fixtures::text(failed.find("failure")) == "broken");
  CHECK(fixtures::text(failed.find("message")) == "out of memory");
  const Solver strange = [](const Model&, double) -> SolveResult { throw 42; };
  CHECK(fixtures::text(fixtures::build(Run{}, &strange).find("message")) == "The engine failed");
  const Solver everything = [](const Model& model, double) {
    std::vector<double> values = model.colUpper;
    for (double& value : values)
      if (!std::isfinite(value)) value = 0;
    return SolveResult{SolveStatus::Optimal, 0, values};
  };
  CHECK(fixtures::text(fixtures::build(Run{}, &everything).find("message")) ==
        "An exact slot breaks a hard rule");
  // Every target at its floor and no game: a build with nothing placed.
  const Solver floors = [](const Model& model, double) {
    std::vector<double> values = model.colLower;
    for (double& value : values)
      if (!std::isfinite(value)) value = 0;
    return SolveResult{SolveStatus::Optimal, 0, values};
  };
  const auto none = fixtures::build(Run{}, &floors);
  CHECK(fixtures::games(none).empty());
  CHECK(fixtures::regular(none) == 0);
}

TEST_CASE("a blocked run answers its cause before any solve") {
  int calls = 0;
  const Solver counting = [&calls](const Model& model, double seconds) {
    ++calls;
    return highsSolver(7)(model, seconds);
  };
  Run run;
  run.seasons[0].windows.clear();
  const auto blocked = fixtures::build(run, &counting);
  CHECK(blocked.find("options")->array.empty());
  CHECK(fixtures::text(blocked.find("blocking")->find("rule")) == "capacity");
  CHECK(calls == 0);
  // Exhibitions only.
  run.seasons[0].regularGames = 0;
  run.seasons[0].exhibitionGames = 1;
  run.seasons[0].exhibitionTeams = {"tem_otters"};
  CHECK(fixtures::text(fixtures::build(run, &counting).find("blocking")->find("kind")) ==
        "exhibition");
  // A required matchup with no open slot, and the manager who blocks it.
  Run managed;
  managed.seasons[0].endsOn = "2027-03-06";
  managed.fields[0].hours = {{{6}, "08:00", "18:00"}};
  managed.headCoaches = {{"tem_hawks", "coach"}, {"tem_outside", "coach"}};
  managed.bookings = {{"", {"tem_outside"}, false, fixtures::at("2027-03-06T13:00:00Z"),
                       fixtures::at("2027-03-07T01:00:00Z")}};
  managed.required = true;
  managed.matchups = {{"r", "sea_demo", "tem_hawks", "tem_owls"}};
  const auto held = fixtures::build(managed);
  CHECK(fixtures::text(held.find("blocking")->find("rule")) == "manager");
  CHECK(fixtures::text(held.find("blocking")->find("managerId")) == "coach");
  CHECK(calls == 0);
}

TEST_CASE("a recalculation's unmet lines: placed elsewhere a manager is held, or field time") {
  Run run;
  run.seasons[0].endsOn = "2027-03-06";
  run.seasons[0].regularGames = 1;
  run.fields = {fixtures::Field{}, fixtures::Field{}};
  run.fields[1].id = "fld_two";
  run.fields[0].hours = run.fields[1].hours = {{{6}, "08:00", "09:30"}};
  run.seasons[0].fieldIds = {"fld_one", "fld_two"};
  run.headCoaches = {{"tem_hawks", "coach"}, {"tem_foxes", "coach"}};
  run.required = true;
  run.matchups = {{"r1", "sea_demo", "tem_hawks", "tem_owls"},
                  {"r2", "sea_demo", "tem_foxes", "tem_bears"}};
  const auto built = fixtures::build(run);
  const auto& unmet = built.find("options")->array.front().find("unmet")->array;
  REQUIRE(unmet.size() == 1);
  CHECK(fixtures::text(unmet[0].find("kind")) == "required");
  CHECK(fixtures::number(unmet[0].find("unplaced")) == 1);
  CHECK(fixtures::text(unmet[0].find("cause")->find("rule")) == "manager");
}

TEST_CASE("a lowered build's unmet lines and their causes, memoised across options") {
  Run run;
  run.seasons[0].participants = {"tem_hawks", "tem_owls", "tem_foxes", "tem_bears",
                                 "tem_wolves", "tem_lynx", "tem_otters"};
  run.seasons[0].regularGames = 8;
  const auto built = fixtures::build(run);
  for (const auto& option : built.find("options")->array) {
    const auto& unmet = option.find("unmet")->array;
    REQUIRE(unmet.size() == 1);
    CHECK(fixtures::text(unmet[0].find("cause")->find("rule")) == "fieldTime");
    CHECK(unmet[0].find("totals")->array.size() == 7);
  }
  // A short season whose heuristic cause names a team's own games.
  Run booked;
  booked.seasons[0].regularGames = 4;
  booked.bookings = {{"", {"tem_hawks"}, false, fixtures::at("2027-03-06T13:00:00Z"),
                      fixtures::at("2027-03-07T01:00:00Z")},
                     {"", {"tem_hawks"}, false, fixtures::at("2027-03-13T13:00:00Z"),
                      fixtures::at("2027-03-14T01:00:00Z")},
                     {"", {"tem_hawks"}, false, fixtures::at("2027-03-20T13:00:00Z"),
                      fixtures::at("2027-03-21T01:00:00Z")},
                     {"", {"tem_hawks"}, false, fixtures::at("2027-03-27T13:00:00Z"),
                      fixtures::at("2027-03-28T01:00:00Z")}};
  const auto own = fixtures::build(booked);
  REQUIRE(!own.find("options")->array.empty());
  const auto& lines = own.find("options")->array.front().find("unmet")->array;
  REQUIRE(!lines.empty());
  const auto& line = lines.front();
  CHECK(fixtures::text(line.find("cause")->find("rule")) == "teamOpenDates");
}

TEST_CASE("capacity heuristics: field time, team time and the weekly maximums") {
  Run run;
  run.seasons[0].regularGames = 4;
  run.seasons[0].doubleheaders = "never";
  run.bookings = {{"fld_one", {}, false, fixtures::at("2027-03-06T17:00:00Z"),
                   fixtures::at("2027-03-06T18:00:00Z")}};
  const auto context = fixtures::context(run);
  const SeasonContext& season = context->seasons[0];
  CHECK(fieldCapacity(*context, season) == 22);
  const int hawks = context->input->teams.find("tem_hawks");
  CHECK(teamCapacity(season, hawks, true) == 4);
  CHECK(teamCapacity(season, 999, true) == 0);
  const Cause cause = capacityCause(*context, season, GameKind::Regular, 4);
  CHECK(cause.rule == Rule::Capacity);
  CHECK(!blockingCause(*context));
  Run weekly = run;
  weekly.seasons[0].maxWeekend = 0;
  const auto capped = fixtures::context(weekly);
  CHECK(weekPartCause(*capped, capped->seasons[0],
                      seasonMatchups(*capped, capped->seasons[0], {4, 0}, 7)));
  CHECK(capacityCause(*capped, capped->seasons[0], GameKind::Regular, 4).rule == Rule::WeekParts);
  CHECK(weekPartMaximum(Settings{}, true) == 1);
  CHECK(gameWeekPart(parseDate("2027-03-13")).key == gameWeekPart(parseDate("2027-03-14")).key);
  CHECK(gameWeekPart(parseDate("2027-03-14")).key != gameWeekPart(parseDate("2027-03-15")).key);
  CHECK(gameWeekPart(parseDate("1969-12-27")).key == gameWeekPart(parseDate("1969-12-28")).key);
}

TEST_CASE("occupancy: fixed games on no run field, size switches and manager-only holds") {
  Run run;
  run.headCoaches = {{"tem_hawks", "coach"}, {"tem_outside", "coach"}};
  fixtures::Game away;
  away.key = "g";
  away.home = "tem_hawks";
  away.away = "tem_owls";
  away.field = "";
  away.size = "";
  away.start = fixtures::at("2027-03-06T14:00:00Z");
  fixtures::Game other = away;
  other.key = "h";
  other.season = "sea_none";
  other.field = "fld_elsewhere";
  run.fixed = {away, other};
  run.bookings = {{"fld_one", {"tem_outside"}, true, fixtures::at("2027-03-13T14:00:00Z"),
                   fixtures::at("2027-03-13T16:00:00Z")}};
  const auto context = fixtures::context(run);
  const SeasonContext& season = context->seasons[0];
  Occupancy occupancy(*context);
  const int hawks = context->input->teams.find("tem_hawks");
  const int owls = context->input->teams.find("tem_owls");
  CHECK(occupancy.gamesOn(season, hawks, parseDate("2027-03-06")) == 1);
  CHECK(occupancy.gamesOn(season, 999, 0) == 0);
  const Slot* thirteenth = nullptr;
  for (const Slot& slot : season.slots)
    if (slot.start == fixtures::at("2027-03-13T14:00:00Z")) thirteenth = &slot;
  REQUIRE(thirteenth != nullptr);
  CHECK(occupancy.fieldFits(season, *thirteenth));
  CHECK(occupancy.teamAvailability(season, hawks, *thirteenth) == kManagerBusy);
  occupancy.place(0, season, hawks, owls, *thirteenth);
  CHECK(!occupancy.fieldFits(season, *thirteenth));
  occupancy.unplace(0, season, hawks, owls, *thirteenth);
  CHECK(occupancy.fieldFits(season, *thirteenth));
  DayBuckets buckets;
  buckets.remove({1, 0, 10, -1, -1});
  CHECK(buckets.near(0).empty());
}

TEST_CASE("cancel: a build asked to stop answers the canceled failure") {
  // Asked before it starts: no solve.
  std::atomic<bool> stop{true};
  const auto before = fixtures::result(buildSchedule(fixtures::request(Run{}), stop));
  CHECK(fixtures::text(before.find("failure")) == "canceled");
  CHECK(fixtures::text(before.find("message")) == "The build was canceled");
  CHECK(!canceled());

  // Asked during a solve: HiGHS's interrupt callback stops it, and nothing
  // it answers is read.
  std::atomic<bool> during{false};
  int solves = 0;
  const Solver interrupted = [&](const Model& model, double seconds) {
    ++solves;
    during.store(true);
    return highsSolver(7)(model, seconds);
  };
  {
    const CancelScope scope(&during);
    const auto stopped = fixtures::build(Run{}, &interrupted);
    CHECK(fixtures::text(stopped.find("failure")) == "canceled");
    CHECK(canceled());
  }
  CHECK(solves == 1);
  CHECK(!canceled());

  // Scopes nest, and the outer flag comes back when the inner one ends.
  std::atomic<bool> outer{true};
  std::atomic<bool> inner{false};
  const CancelScope first(&outer);
  {
    const CancelScope second(&inner);
    CHECK(!canceled());
    CHECK_NOTHROW(throwIfCanceled());
  }
  CHECK(canceled());
  CHECK_THROWS_AS(throwIfCanceled(), Failure);
}
