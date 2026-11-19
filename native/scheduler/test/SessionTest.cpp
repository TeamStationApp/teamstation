// A build's session: its events, the time limit's pause and the answers to
// it, on a clock of the test's own and on the packed league at a 1 s limit.
// The packed league's request is written by scripts/schedulerBuild.mjs
// (test, coverage) from src/test/packedLeagueRun.ts, and named by
// SCHEDULER_PACKED_REQUEST.
#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iterator>
#include <limits>
#include <string>
#include <vector>

#include "Engine.h"
#include "Fixtures.h"
#include "doctest.h"

using namespace teamstation::scheduler;
using fixtures::Run;

namespace {

// Hears a build: each event, read, and the answers it gives, in turn.
struct Heard {
  std::vector<json::Value> events;
  std::vector<Decision> answers;
  size_t asked = 0;
  Reporter reporter() {
    Reporter out;
    out.emit = [this](const std::string& event) { events.push_back(json::parse(event)); };
    out.decide = [this] {
      const Decision answer = answers[std::min(asked, answers.size() - 1)];
      ++asked;
      return answer;
    };
    return out;
  }
  std::vector<std::string> kinds(const std::string& kind, const char* field) const {
    std::vector<std::string> out;
    for (const json::Value& event : events)
      if (fixtures::text(event.find("kind")) == kind) out.push_back(fixtures::text(event.find(field)));
    return out;
  }
  // Each phase's start (`+`) and end (`-`), with a cause's season: `+cause S5`.
  std::vector<std::string> steps() const {
    std::vector<std::string> out;
    for (const json::Value& event : events) {
      const std::string kind = fixtures::text(event.find("kind"));
      if (kind != "phase-start" && kind != "phase") continue;
      std::string step = (kind == "phase" ? "-" : "+") + fixtures::text(event.find("phase"));
      const json::Value* detail = event.find("detail");
      if (detail != nullptr && detail->find("seasonName") != nullptr)
        step += " " + fixtures::text(detail->find("seasonName"));
      out.push_back(step);
    }
    return out;
  }
  std::vector<const json::Value*> limits() const {
    std::vector<const json::Value*> out;
    for (const json::Value& event : events)
      if (fixtures::text(event.find("kind")) == "limit") out.push_back(&event);
    return out;
  }
};

std::string packedRequest(double limitMs) {
  const char* path = std::getenv("SCHEDULER_PACKED_REQUEST");
  REQUIRE_MESSAGE(path != nullptr, "run the tests through scripts/schedulerBuild.mjs test");
  std::ifstream in(path, std::ios::binary);
  std::string request((std::istreambuf_iterator<char>(in)), {});
  REQUIRE(!request.empty());
  // The request ends with its object's brace: give it the limit.
  request.pop_back();
  return request + ",\"limitMs\":" + std::to_string(static_cast<int>(limitMs)) + "}";
}

std::vector<int> targetsOf(const json::Value& result) {
  std::vector<int> out;
  for (const json::Value& season : result.find("targets")->array)
    out.push_back(static_cast<int>(fixtures::number(season.find("regular"))));
  return out;
}

std::vector<std::string> causeRules(const json::Value& result) {
  std::vector<std::string> out;
  for (const json::Value& line : result.find("options")->array[0].find("unmet")->array)
    out.push_back(fixtures::text(line.find("cause")->find("rule")));
  return out;
}

}  // namespace

TEST_CASE("a session: one deadline, paused time left out, a fresh deadline after a use") {
  double clock = 0;
  Heard heard;
  heard.answers = {Decision::Continue, Decision::Use, Decision::Cancel};
  const Reporter reporter = heard.reporter();
  Session session(&reporter, 1000, [&clock] { return clock; });
  CHECK(!session.due());
  CHECK(session.remainingMs() == 0);
  CHECK(session.solvedMs() == 0);
  clock = 50;
  session.startSolve();
  CHECK(session.remainingMs() == 1000);
  clock = 1050;
  CHECK(session.due());
  // Continue: the admin's 5 s are not the solver's, and the new deadline is
  // a whole limit after the answer.
  Reporter slow = reporter;
  slow.decide = [&clock, &heard] {
    clock += 5000;
    return heard.reporter().decide();
  };
  Session timed(&slow, 1000, [&clock] { return clock; });
  clock = 0;
  timed.startSolve();
  clock = 1200;
  CHECK(timed.pause(Stage::Targets, std::nullopt, 344) == Decision::Continue);
  CHECK(timed.pausedMs() == 5000);
  CHECK(timed.solvedMs() == 1200);
  CHECK(!timed.due());
  CHECK(timed.remainingMs() == 1000);
  // The same solve goes on: its deadline holds.
  timed.startSolve();
  CHECK(timed.remainingMs() == 1000);
  clock += 1000;
  CHECK(timed.pause(Stage::Placement, 330, 338) == Decision::Use);
  // After a use, the next solve has a deadline of its own.
  clock += 300;
  timed.startSolve();
  CHECK(timed.remainingMs() == 1000);
  CHECK(timed.pause(Stage::Placement, 330, 338) == Decision::Cancel);
  CHECK(timed.canceled());
  const auto limits = heard.limits();
  REQUIRE(limits.size() == 3);
  CHECK(fixtures::text(limits[0]->find("stage")) == "targets");
  CHECK(limits[0]->find("bestGames")->isNull());
  CHECK(fixtures::number(limits[0]->find("boundGames")) == 344);
  CHECK(fixtures::number(limits[0]->find("solvedMs")) == 1200);
  CHECK(fixtures::text(limits[1]->find("stage")) == "placement");
  CHECK(fixtures::number(limits[1]->find("bestGames")) == 330);
  CHECK(fixtures::number(limits[1]->find("solvedMs")) == 2200);

  // Phases and progress, with and without detail; a timer leaves pauses out.
  heard.events.clear();
  PhaseDetail model;
  model.columns = 23776;
  model.rows = 10685;
  session.phase("model", 9.4, model);
  PhaseDetail cause;
  cause.seasonName = "S5";
  session.phase("cause", 3999.6, cause);
  session.phase("polish", -1);
  session.progress(330, 338);
  session.progress(0, 0);
  session.progress(12, 10);
  session.phaseStart("cause", cause);
  session.phaseStart("polish");
  REQUIRE(heard.events.size() == 8);
  CHECK(fixtures::text(heard.events[6].find("kind")) == "phase-start");
  CHECK(fixtures::text(heard.events[6].find("phase")) == "cause");
  CHECK(heard.events[6].find("ms") == nullptr);
  CHECK(fixtures::text(heard.events[6].find("detail")->find("seasonName")) == "S5");
  CHECK(heard.events[7].find("detail") == nullptr);
  CHECK(fixtures::number(heard.events[0].find("ms")) == 9);
  CHECK(fixtures::number(heard.events[0].find("detail")->find("columns")) == 23776);
  CHECK(fixtures::number(heard.events[0].find("detail")->find("rows")) == 10685);
  CHECK(fixtures::text(heard.events[1].find("detail")->find("seasonName")) == "S5");
  CHECK(fixtures::number(heard.events[1].find("ms")) == 4000);
  CHECK(heard.events[2].find("detail") == nullptr);
  CHECK(fixtures::number(heard.events[2].find("ms")) == 0);
  CHECK(fixtures::number(heard.events[3].find("gap")) == doctest::Approx(8.0 / 338));
  CHECK(fixtures::number(heard.events[4].find("gap")) == 0);
  CHECK(fixtures::number(heard.events[5].find("boundGames")) == 12);
  const PhaseTimer timer(timed);
  clock += 100;
  CHECK(timer.ms() == 100);

  // Without a reporter nothing is heard, and the limit takes the best.
  Session quiet(nullptr, 1000, [&clock] { return clock; });
  quiet.phase("context", 1);
  quiet.phaseStart("context");
  quiet.progress(1, 2);
  quiet.startSolve();
  CHECK(quiet.pause(Stage::Targets, 1, 2) == Decision::Use);
  Session defaultClock(nullptr, 1000);
  CHECK(defaultClock.now() >= 0);
}

TEST_CASE("a schedule not proven the best: every short count says the time limit, and no cause is solved") {
  // A stand-in that answers as HiGHS stopped with its incumbent does.
  int solves = 0;
  const Solver used = [&solves](const Model& model, const Limits& limits) {
    ++solves;
    CHECK(limits.stage != Stage::Cause);
    SolveResult result = highsSolver(7)(model, 30);
    result.proven = false;
    return result;
  };
  Session session(nullptr, 45'000);
  ExactOptions options;
  options.session = &session;
  Run run;
  run.seasons[0].regularGames = 60;
  const auto built = fixtures::build(run, &used, &options);
  CHECK(!built.find("provenOptimal")->boolean);
  CHECK(causeRules(built) == std::vector<std::string>{"timeLimit"});
  CHECK(solves >= 1);

  // A recalculation that leaves a required matchup unplaced, the same way.
  Run required;
  required.required = true;
  required.fields[0].hours = {{{6}, "08:00", "09:40"}};
  required.seasons[0].windows = {{"2027-03-06", "2027-03-06", {{{6}, "08:00", "09:40"}}}};
  required.seasons[0].startsOn = "2027-03-06";
  required.seasons[0].endsOn = "2027-03-06";
  required.matchups = {{"m1", "sea_demo", "tem_hawks", "tem_owls", false},
                       {"m2", "sea_demo", "tem_foxes", "tem_bears", false}};
  solves = 0;
  Session again(nullptr, 45'000);
  options.session = &again;
  const auto recalculated = fixtures::build(required, &used, &options);
  CHECK(!recalculated.find("provenOptimal")->boolean);
  CHECK(causeRules(recalculated) == std::vector<std::string>{"timeLimit"});
  CHECK(solves == 1);
}

TEST_CASE("the packed league at a 1 s limit: continuing until proven reaches the optimum") {
  Heard heard;
  heard.answers = {Decision::Continue};
  const std::atomic<bool> cancel{false};
  const json::Value result =
      fixtures::result(buildSchedule(packedRequest(1000), cancel, heard.reporter()));
  REQUIRE(fixtures::text(result.find("kind")) == "options");
  const auto limits = heard.limits();
  REQUIRE(!limits.empty());
  CHECK(fixtures::text(limits[0]->find("stage")) == "targets");
  CHECK(targetsOf(result) == std::vector<int>{10, 10, 12, 14, 16, 16});
  CHECK(result.find("provenOptimal")->boolean);
  CHECK(result.find("options")->array[0].find("games")->array.size() == 338);
  // Causes get at least 5 s each, the limit long spent, and never pause.
  CHECK(causeRules(result) == std::vector<std::string>{"fieldTime", "weekParts"});
  CHECK(heard.kinds("phase", "phase") ==
        std::vector<std::string>{"context", "model", "targets", "placement", "cause", "cause",
                                 "polish", "options"});
  // Each step is heard starting, then ending, one at a time; a cause names
  // its season both times.
  CHECK(heard.steps() ==
        std::vector<std::string>{"+context", "-context", "+model", "-model", "+targets",
                                 "-targets", "+placement", "-placement", "+cause S5",
                                 "-cause S5", "+cause S6", "-cause S6", "+polish", "-polish",
                                 "+options", "-options"});
  CHECK(heard.asked == limits.size());
}

TEST_CASE("the packed league at a 1 s limit: use takes the incumbent, then a placement") {
  Heard heard;
  const std::atomic<bool> cancel{false};
  // Use once there is a schedule to take: with none, Use would wait only
  // one more limit for the first.
  Reporter reporter = heard.reporter();
  reporter.decide = [&heard] {
    ++heard.asked;
    return heard.limits().back()->find("bestGames")->isNull() ? Decision::Continue
                                                              : Decision::Use;
  };
  const json::Value result =
      fixtures::result(buildSchedule(packedRequest(1000), cancel, reporter));
  REQUIRE(fixtures::text(result.find("kind")) == "options");
  const auto limits = heard.limits();
  REQUIRE(!limits.empty());
  CHECK(fixtures::text(limits[0]->find("stage")) == "targets");
  CHECK(!result.find("provenOptimal")->boolean);
  // The placement after the use came within its own limit, or paused there.
  const auto phases = heard.kinds("phase", "phase");
  const bool placementLimit =
      limits.size() > 1 && fixtures::text(limits.back()->find("stage")) == "placement";
  CHECK((placementLimit || std::find(phases.begin(), phases.end(), "placement") != phases.end()));
  CHECK(std::find(phases.begin(), phases.end(), "cause") == phases.end());
  CHECK(!result.find("options")->array[0].find("games")->array.empty());
  for (const std::string& rule : causeRules(result)) CHECK(rule == "timeLimit");
}

TEST_CASE("the packed league at a 1 s limit: cancel answers the canceled failure") {
  Heard heard;
  heard.answers = {Decision::Cancel};
  const std::atomic<bool> cancel{false};
  const json::Value result =
      fixtures::result(buildSchedule(packedRequest(1000), cancel, heard.reporter()));
  CHECK(fixtures::text(result.find("failure")) == "canceled");
  CHECK(heard.asked == 1);
}

namespace {

// A clock that moves a second each time it is read, so that every check
// after a solve starts finds its deadline gone.
struct Ticking {
  double at = 0;
  std::function<double()> clock() {
    return [this] { return at += 1000; };
  }
};

// A transportation LP, `n` by `n`, with no integer column: HiGHS solves it
// by simplex, whose callbacks are all it hears.
Model transport(int n) {
  Model model;
  for (int i = 0; i < n; ++i)
    for (int j = 0; j < n; ++j) {
      model.colCost.push_back(static_cast<double>((i * 7 + j * 13) % 17 + 1));
      model.colLower.push_back(0);
      model.colUpper.push_back(1);
      model.integer.push_back(0);
    }
  model.rowStart.push_back(0);
  for (int i = 0; i < n; ++i) {
    for (int j = 0; j < n; ++j) {
      model.rowIndex.push_back(i * n + j);
      model.rowValue.push_back(1);
    }
    model.rowLower.push_back(-std::numeric_limits<double>::infinity());
    model.rowUpper.push_back(1);
    model.rowStart.push_back(static_cast<int>(model.rowIndex.size()));
  }
  for (int j = 0; j < n; ++j) {
    for (int i = 0; i < n; ++i) {
      model.rowIndex.push_back(i * n + j);
      model.rowValue.push_back(1);
    }
    model.rowLower.push_back(-std::numeric_limits<double>::infinity());
    model.rowUpper.push_back(1);
    model.rowStart.push_back(static_cast<int>(model.rowIndex.size()));
  }
  return model;
}

// Forty binary items under three knapsacks: a MIP that branch and bound
// checks in on more than once.
Model knapsacks() {
  Model model;
  const int n = 40;
  for (int i = 0; i < n; ++i) {
    model.colCost.push_back(static_cast<double>((i * 37) % 23 + 5));
    model.colLower.push_back(0);
    model.colUpper.push_back(1);
    model.integer.push_back(1);
  }
  model.rowStart.push_back(0);
  for (int k = 0; k < 3; ++k) {
    for (int i = 0; i < n; ++i) {
      model.rowIndex.push_back(i);
      model.rowValue.push_back(static_cast<double>((i * (k + 3) * 11) % 31 + 7));
    }
    model.rowLower.push_back(-std::numeric_limits<double>::infinity());
    model.rowUpper.push_back(203 + 17 * k);
    model.rowStart.push_back(static_cast<int>(model.rowIndex.size()));
  }
  return model;
}

}  // namespace

TEST_CASE("an LP under a session pauses at its deadline: going on or canceling, with no best yet") {
  Ticking ticking;
  Heard heard;
  heard.answers = {Decision::Continue, Decision::Cancel};
  const Reporter reporter = heard.reporter();
  Session session(&reporter, 500, ticking.clock());
  Limits limits(std::numeric_limits<double>::infinity());
  limits.stage = Stage::Targets;
  limits.gameColumns = 0;
  limits.boundGames = [](double) { return 7; };
  highsSolver(1, &session)(transport(30), limits);
  // The simplex callbacks read the deadline: two pauses, the second canceled.
  CHECK(heard.asked == 2);
  CHECK(session.canceled());
  const auto paused = heard.limits();
  REQUIRE(paused.size() == 2);
  CHECK(paused[0]->find("bestGames")->isNull());
  CHECK(fixtures::number(paused[0]->find("boundGames")) == 7);
  CHECK(fixtures::text(paused[0]->find("stage")) == "targets");
}

TEST_CASE("use with no schedule yet waits one more limit for the first, then is the time limit") {
  Ticking ticking;
  Heard heard;
  heard.answers = {Decision::Use};
  const Reporter reporter = heard.reporter();
  Session session(&reporter, 500, ticking.clock());
  Limits limits(std::numeric_limits<double>::infinity());
  limits.stage = Stage::Placement;
  // No column is a game, so no schedule is ever one to offer.
  limits.gameColumns = 0;
  const SolveResult result = highsSolver(1, &session)(knapsacks(), limits);
  // One pause: the wait for a first schedule ends at its own deadline,
  // with no second question and no open-ended solve.
  CHECK(heard.asked == 1);
  CHECK(result.status == SolveStatus::TimeLimit);
  CHECK(!session.canceled());
  // Without a session the same model solves to its optimum.
  CHECK(highsSolver(1)(knapsacks(), 30).status == SolveStatus::Optimal);
}
