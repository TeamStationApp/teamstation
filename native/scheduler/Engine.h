#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "Calendar.h"
#include "Json.h"

// The Auto-Scheduler engine, exact only: the TypeScript engine that
// src/common/autoScheduler held (slots, context, feasibility, matchups,
// counts, capacity, exact, placement, score, options) in C++17, solving its
// models with HiGHS's C++ API on the calling thread. One JSON request in
// (`EngineRequest`, src/common/scheduler/wire.ts), one JSON result out. It
// runs as the Node addon (node/), the web's WebAssembly (wasm/) and the
// phones' NativeScheduler module (phone/).
namespace teamstation::scheduler {

// ---------------------------------------------------------------- input

// Strings the run names (teams, managers, fields, sizes) as small numbers.
class Names {
 public:
  int intern(const std::string& name);
  // -1 when the name was never interned.
  int find(const std::string& name) const;
  const std::string& name(int id) const { return names_[id]; }
  int size() const { return static_cast<int>(names_.size()); }

 private:
  std::vector<std::string> names_;
  std::unordered_map<std::string, int> ids_;
};

struct WeekdayHours {
  int weekday = 0;
  int start = 0;  // minutes after midnight
  int end = 0;
};

struct WindowPeriod {
  int from = 0;
  std::optional<int> until;
  std::vector<WeekdayHours> hours;
};

struct Availability {
  std::optional<int> startsOn;
  std::optional<int> endsOn;
  std::vector<WeekdayHours> hours;
  // Whether `windows` was given; without it the weekly hours apply.
  bool hasWindows = false;
  std::vector<WindowPeriod> windows;
  std::vector<int> blackouts;
  std::string timezone;
};

struct Field {
  int id = 0;
  std::string name;
  std::vector<int> sizes;
  Availability availability;
  int switchMinutes = 0;
};

enum class Doubleheaders { Never, IfNecessary, Allowed };

struct Settings {
  std::vector<int> fieldIds;
  int fieldSize = 0;
  int gameMinutes = 0;
  int bufferMinutes = 0;
  int regularGames = 0;
  int exhibitionGames = 0;
  Doubleheaders doubleheaders = Doubleheaders::IfNecessary;
  std::optional<int64_t> maxGamesOnWeekdays;
  std::optional<int64_t> maxGamesOnWeekend;
  bool preferWeekdays = false;
  int startsOn = 0;
  int endsOn = 0;
  std::vector<int> blackouts;
  std::vector<WindowPeriod> windows;
};

struct Season {
  std::string id;
  std::string name;
  Settings settings;
  std::vector<int> participants;
  std::vector<int> exhibitionTeams;
};

struct Booking {
  bool managerOnly = false;
  int field = -1;  // -1: on no field of the run
  int size = -1;   // -1: not known
  std::vector<int> teams;
  Instant start = 0;
  Instant end = 0;
};

struct FixedGame {
  std::string key;
  std::string seasonId;
  int home = 0;
  int away = 0;
  bool exhibition = false;
  int field = -1;
  int size = -1;
  Instant start = 0;
  Instant end = 0;
};

struct WeeklyGame {
  std::string seasonId;
  int field = -1;
  std::vector<int> teams;
  Instant start = 0;
};

struct Matchup {
  std::string key;
  std::string seasonId;
  int home = 0;
  int away = 0;
  bool exhibition = false;
};

struct Input {
  Names teams;
  Names managers;
  Names fieldNames;  // the run's fields first, in order
  Names sizes;
  std::vector<int> headCoaches;  // manager per team, -1 for none
  std::vector<Season> seasons;
  std::vector<Field> fields;
  std::vector<Booking> bookings;
  std::vector<FixedGame> fixed;
  bool hasWeeklyGames = false;
  std::vector<WeeklyGame> weeklyGames;
  std::unordered_map<int, std::string> teamNames;
  bool partial = false;
  std::vector<int> teamIds;
  Instant notBefore = 0;
  double seed = 0;
  bool hasRequired = false;
  std::vector<Matchup> required;
  std::unordered_map<std::string, ZoneOffsets> zones;

  int managerOf(int team) const {
    return team >= 0 && team < static_cast<int>(headCoaches.size())
               ? headCoaches[team]
               : -1;
  }
  const ZoneOffsets& zone(const std::string& name) const;
  // The name a cause gives a team: its name, or its id.
  std::string teamName(int team) const;
};

struct Request {
  std::shared_ptr<Input> input;
  double limitMs = 45'000;
  int64_t maxColumns = 400'000;
};

// Reads an EngineRequest; throws json::Error or std::invalid_argument.
Request readRequest(const json::Value& document);

// ------------------------------------------------------------- the slots

constexpr int kMorning = 0;
constexpr int kAfternoon = 1;
constexpr int kEvening = 2;

struct GamePoint {
  int day = 0;
  int weekday = 0;
  int timeOfDay = 0;
};

struct Slot {
  GamePoint point;
  int index = 0;
  int season = 0;
  int field = 0;
  int size = 0;
  Instant start = 0;
  Instant end = 0;
  int scarcity = 0;
  bool onGrid = false;
};

struct SlotGroup {
  int index = 0;
  std::vector<int> slots;  // indexes into the season's slots
};

struct SeasonWindow {
  int field = 0;
  int day = 0;
  Instant start = 0;
  Instant end = 0;
};

struct Supply {
  int games = 0;
  std::array<int, 3> timeOfDay{};
  std::array<int, 7> weekdays{};
};

// Reads instants as calendar points in a zone, caching each date's cutoffs.
class LocalClock {
 public:
  int timeOfDay(int day, Instant instant, const ZoneOffsets& zone);
  GamePoint pointOf(Instant instant, const ZoneOffsets& zone);
  GamePoint pointOn(int day, Instant instant, const ZoneOffsets& zone);

 private:
  std::map<std::pair<const ZoneOffsets*, int>, std::pair<Instant, Instant>>
      cutoffs_;
};

// TeamAvailability in feasibility.ts.
constexpr uint8_t kBusy = 0;
constexpr uint8_t kFree = 1;
constexpr uint8_t kManagerBusy = 2;

struct FixedPoint {
  int game = 0;  // index into Input::fixed
  GamePoint point;
};

struct WeeklyPoint {
  std::vector<int> teams;
  GamePoint point;
};

struct SeasonContext {
  int index = 0;
  const Season* season = nullptr;
  std::vector<int> teams;  // participants, then exhibition teams
  std::vector<std::string> zones;
  std::vector<int> fieldZone;  // per field of the run: index into zoneNames
  Instant bufferMs = 0;
  std::vector<Slot> slots;
  std::vector<SlotGroup> groups;
  std::vector<SeasonWindow> windows;
  Supply supply;
  int firstDay = 0;
  int lastDay = 0;
  std::vector<FixedPoint> fixed;
  std::vector<WeeklyPoint> weeklyGames;
  std::vector<uint8_t> fieldFree;
  // Per team id; empty for a team the season does not know.
  std::vector<std::vector<uint8_t>> teamFree;

  const Settings& settings() const { return season->settings; }
  const std::vector<uint8_t>* freeOf(int team) const {
    return team >= 0 && team < static_cast<int>(teamFree.size()) &&
                   !teamFree[team].empty()
               ? &teamFree[team]
               : nullptr;
  }
};

struct RunContext {
  std::shared_ptr<Input> input;
  std::shared_ptr<LocalClock> clock;
  std::vector<SeasonContext> seasons;
  std::unordered_map<std::string, int> seasonById;
  std::vector<bool> active;  // per team, in a partial run
  bool hasRequired = false;
  std::vector<Matchup> required;  // those of the run's seasons

  bool isActive(int team) const {
    return !input->partial ||
           (team >= 0 && team < static_cast<int>(active.size()) && active[team]);
  }
  const SeasonContext* seasonOf(const std::string& id) const;
  const std::string& zoneOf(const SeasonContext& season, int field) const;
  const Field* fieldById(int field) const;
};

std::shared_ptr<RunContext> buildContext(std::shared_ptr<Input> input);
int openSlots(const SeasonContext& season, int home, int away);
// String.prototype.localeCompare's order for plain names.
bool localeLess(const std::string& a, const std::string& b);
// The selected fields that take the season's size, in the run's order.
std::vector<const Field*> seasonFields(const Input& input,
                                       const Settings& settings);

// ---------------------------------------------------------- occupancy

struct Hold {
  int64_t id = 0;
  Instant start = 0;
  Instant end = 0;
  int size = -1;
  Instant bufferMs = -1;  // -1: outside the run
};

class DayBuckets {
 public:
  void add(const Hold& hold);
  void remove(const Hold& hold);
  const std::vector<Hold>& near(Instant instant) const;

 private:
  std::unordered_map<int64_t, std::vector<Hold>> days_;
};

constexpr int64_t kPlacedId = 1'000'000'000;

// The hard rules, as an index of what holds each field and team.
class Occupancy {
 public:
  explicit Occupancy(const RunContext& context);
  bool fieldFits(const SeasonContext& season, const Slot& slot) const;
  uint8_t teamAvailability(const SeasonContext& season, int team,
                           const Slot& slot) const;
  bool fits(const SeasonContext& season, int home, int away,
            const Slot& slot) const;
  void place(int64_t id, const SeasonContext& season, int home, int away,
             const Slot& slot);
  void unplace(int64_t id, const SeasonContext& season, int home, int away,
               const Slot& slot);
  int gamesOn(const SeasonContext& season, int team, int day) const;

 private:
  void managerHolds(const std::vector<int>& teams, const Hold& hold, bool add);
  DayBuckets& bucketsOf(std::unordered_map<int, DayBuckets>& map, int key);
  void count(std::unordered_map<int, std::unordered_map<int64_t, int>>& counts,
             const SeasonContext& season, int team, int day, int by);

  const RunContext& context_;
  std::unordered_map<int, DayBuckets> fields_;
  std::unordered_map<int, DayBuckets> managers_;
  std::unordered_map<int, DayBuckets> teams_;
  std::unordered_map<int, std::unordered_map<int64_t, int>> dayCounts_;
  std::unordered_map<int, std::unordered_map<int64_t, int>> weeklyCounts_;
};

// gameWeekPart in src/common/gameWeekPart.ts.
struct WeekPart {
  int64_t key = 0;
  bool weekend = false;
  int first = 0;
  int last = 0;
};
WeekPart gameWeekPart(int day);
int64_t weekPartMaximum(const Settings& settings, bool weekend);

// ------------------------------------------------------------ matchups

using Random = std::function<double()>;
Random mulberry32(uint32_t seed);
int randomIndex(const Random& random, int length);
std::vector<int> shuffled(const std::vector<int>& items, const Random& random);
uint32_t nthSeed(uint32_t seed, uint32_t k);
uint32_t toUint32(double value);

struct Targets {
  int regular = 0;
  int exhibition = 0;
};

struct TeamCounts {
  int regular = 0;
  int exhibition = 0;
};

std::unordered_map<int, TeamCounts> fixedCounts(const Season& season,
                                                const RunContext& context);
std::vector<std::pair<int, TeamCounts>> seasonNeeds(
    const Season& season, const Targets& targets,
    const std::unordered_map<int, TeamCounts>& counts,
    const RunContext& context);
std::vector<std::pair<int, int>> regularPairs(
    const std::vector<int>& order, const std::unordered_map<int, int>& needs,
    std::map<std::pair<int, int>, int>& met, int cap);
std::vector<int> exhibitionOpponents(int index, int perTeam,
                                     const std::vector<int>& exhibitionTeams,
                                     const std::vector<int>& alreadyPlayed,
                                     int need);
std::vector<std::pair<int, int>> orient(
    const std::vector<std::pair<int, int>>& pairs,
    const std::vector<const FixedGame*>& fixed);
std::vector<Matchup> keyMatchups(const Input& input, const std::string& seasonId,
                                 const std::vector<std::pair<int, int>>& oriented,
                                 size_t regularCount);
std::vector<Matchup> seasonMatchups(const RunContext& context,
                                    const SeasonContext& season,
                                    const Targets& targets, uint32_t seed);

// -------------------------------------------------------------- counts

Targets requestedTargets(const SeasonContext& season);
Targets floorTargets(const RunContext& context, const SeasonContext& season);
bool oddTotal(const RunContext& context, const SeasonContext& season,
              const Targets& targets);
bool lowerTargets(const RunContext& context, const SeasonContext& season,
                  Targets& targets);
// From the request, or from `from` when given.
Targets startingTargets(const RunContext& context, const SeasonContext& season,
                        uint32_t seed, const Targets* from = nullptr);

// -------------------------------------------------------------- causes

enum class GameKind { Regular, Exhibition, Required };

enum class Rule {
  FieldTime,
  WeekParts,
  Doubleheaders,
  Manager,
  RequiredUnplaced,
  TeamOpenDates,
  Capacity,
  // Not proven: the admin took the best schedule found at the time limit.
  TimeLimit
};

// A structured cause, which TypeScript words (capacity.ts `causeLine`).
struct Cause {
  int season = 0;
  GameKind kind = GameKind::Regular;
  Rule rule = Rule::FieldTime;
  int team = -1;
  int requested = 0;
};

Cause fieldTimeCause(const SeasonContext& season, GameKind kind, int requested);
Cause managerCause(const SeasonContext& season, GameKind kind, int requested,
                   int team);
int fieldCapacity(const RunContext& context, const SeasonContext& season);
int teamCapacity(const SeasonContext& season, int team, bool ownTime);
std::optional<int> blockedByManager(const RunContext& context,
                                    const SeasonContext& season,
                                    const std::vector<Matchup>& matchups,
                                    const Occupancy* occupied);
bool weekPartCause(const RunContext& context, const SeasonContext& season,
                   const std::vector<Matchup>& matchups);
Cause capacityCause(const RunContext& context, const SeasonContext& season,
                    GameKind kind, int requested);
std::optional<Cause> blockingCause(const RunContext& context);
Cause requiredCause(const RunContext& context, const SeasonContext& season,
                    const std::vector<Matchup>& unplaced);

// ----------------------------------------------------------- placement

constexpr int kUnplaced = 0;
constexpr int kDoubleheaders = 1;
constexpr int kTimeOfDay = 2;
constexpr int kSpacing = 3;
constexpr int kWeekday = 4;
constexpr int kScarcity = 5;
constexpr int kPreference = 6;
constexpr int kTerms = 7;
using Score = std::array<double, kTerms>;
using Order = std::vector<int>;
extern const Order kTrueOrder;
extern const std::vector<Order> kWeightings;
constexpr int kSeeds = 6;
constexpr size_t kMaxOptions = 3;
constexpr double kMinDifferent = 0.25;

int compareScores(const Score& a, const Score& b, const Order& order);
double mixDeviation(const int* counts, int length, int games,
                    const int* supply, int supplyGames);

class TeamTally {
 public:
  TeamTally(int planned, int firstDay, int lastDay)
      : planned(planned), firstDay(firstDay), lastDay(lastDay) {}
  void add(const GamePoint& point);
  void remove(const GamePoint& point);
  std::vector<int> spanDays() const;
  int backToBack(const std::vector<int>& days) const;
  int backToBack() const { return backToBack(spanDays()); }
  std::vector<int> gaps() const;
  int unevenness(const std::vector<int>& days) const;
  int spacing() const;
  const std::array<double, 4>& terms(const Supply& supply);

  int games = 0;
  std::array<int, 3> timeOfDay{};
  std::array<int, 7> weekdays{};
  std::vector<int> days;
  int doubleheaders = 0;
  int planned;
  int firstDay;
  int lastDay;

 private:
  bool cached_ = false;
  std::array<double, 4> terms_{};
};

class SeasonLedger {
 public:
  SeasonLedger(const RunContext& context, const SeasonContext& season,
               int games, const std::unordered_map<int, int>& planned);
  void add(int home, int away, const GamePoint& point, int scarcity);
  void remove(int home, int away, const GamePoint& point, int scarcity);
  Score score();
  TeamTally* tally(int team);

  const SeasonContext* season;
  int games;
  int placed = 0;
  int scarcity = 0;
  // In the season's team order.
  std::vector<std::pair<int, TeamTally>> tallies;

 private:
  std::unordered_map<int, size_t> at_;
};

// One schedule: where each matchup went (-1 for no slot), and its score.
struct Placement {
  std::vector<Matchup> matchups;
  std::vector<const Slot*> slots;
  Score score{};
  std::vector<SeasonLedger> ledgers;  // in run order
};

int searchBudget(int games);
// Places the matchups in the given slots (nullptr: none), then polishes from
// `seed`; nullopt when a slot breaks a hard rule.
std::optional<Placement> placeFrom(const RunContext& context,
                                   const std::vector<Matchup>& matchups,
                                   const std::vector<const Slot*>& slots,
                                   uint32_t seed, const Order& order);

// ------------------------------------------------------------- the model

// The exact settlement: the counts and the slots that reach them.
struct Settlement {
  std::vector<Targets> targets;  // per season
  std::vector<Matchup> matchups;
  std::vector<const Slot*> slots;
  // The exact cause of each short count, by season and kind.
  std::map<std::pair<int, GameKind>, Cause> causes;
  bool lowered = false;
  // False when a solve stopped at the time limit with its incumbent.
  bool provenOptimal = true;
};

enum class SolveStatus { Optimal, Infeasible, TimeLimit, Error };

// A model as HiGHS takes it, rows by row.
struct Model {
  std::vector<double> colCost, colLower, colUpper;
  std::vector<uint8_t> integer;
  std::vector<double> rowLower, rowUpper;
  std::vector<int> rowStart, rowIndex;
  std::vector<double> rowValue;
};

struct SolveResult {
  SolveStatus status = SolveStatus::Error;
  double objective = 0;
  std::vector<double> colValue;
  // False when the admin took the incumbent at the time limit: the answer
  // is a schedule, not proven the best.
  bool proven = true;
};

// ------------------------------------------------------------- the session

// What a build's solves are for. The targets and placement solves pause at
// the session's time limit; a cause solve never does.
enum class Stage { Targets, Placement, Cause };

// The answer to a pause at the time limit.
enum class Decision { Continue, Use, Cancel };

// How the caller hears a build and answers its pauses: `emit` takes each
// event's JSON; `decide` waits for the answer to the limit event just
// emitted. Without `decide`, a build at its limit takes the best it has.
struct Reporter {
  std::function<void(const std::string& event)> emit;
  std::function<Decision()> decide;
};

// What a phase event tells beside its time: the model's size, or the
// season a cause is for.
struct PhaseDetail {
  int64_t columns = -1;
  int64_t rows = -1;
  std::string seasonName;
};

// One build's clock, events and time limit. The limit is one deadline,
// `limitMs` after the first pausable solve starts. A solve that passes it
// pauses (`pause`): continue sets a new deadline `limitMs` after the answer,
// so the time spent waiting is not counted, and the solve carries on; use
// stops it with its incumbent, and the solve that follows gets a deadline
// of its own; cancel ends the build.
class Session {
 public:
  Session(const Reporter* reporter, double limitMs, std::function<double()> now = {});

  double now() const { return now_(); }
  double limitMs() const { return limitMs_; }
  void emit(const std::string& event) const;
  // A phase starts: the modal shows it running until its `phase` event.
  void phaseStart(const char* name, const PhaseDetail& detail = {}) const;
  // A phase that took `ms` of solving and building, not counting pauses.
  void phase(const char* name, double ms, const PhaseDetail& detail = {}) const;
  void progress(int incumbentGames, int boundGames) const;

  // A pausable solve starts: the first sets the deadline, as does the
  // first after a use.
  void startSolve();
  bool due() const { return deadline_ >= 0 && now() >= deadline_; }
  // Emits the limit event and waits for the answer.
  Decision pause(Stage stage, std::optional<int> bestGames, int boundGames);
  // The solves' time so far, less the time spent paused.
  double solvedMs() const;
  // Milliseconds left before the deadline; 0 when it is gone or not set.
  double remainingMs() const;
  // Milliseconds paused since the session began.
  double pausedMs() const { return paused_; }
  bool canceled() const { return canceled_; }

 private:
  const Reporter* reporter_;
  double limitMs_;
  std::function<double()> now_;
  double firstStart_ = -1;
  double deadline_ = -1;
  double paused_ = 0;
  bool fresh_ = false;
  bool canceled_ = false;
};

// Times a phase in a session's clock, leaving out the time it spent paused.
class PhaseTimer {
 public:
  explicit PhaseTimer(const Session& session)
      : session_(session), start_(session.now()), paused_(session.pausedMs()) {}
  double ms() const { return session_.now() - start_ - (session_.pausedMs() - paused_); }

 private:
  const Session& session_;
  double start_;
  double paused_;
};

// What a solve is for, beside its model. A plain number of seconds is a
// solve with HiGHS's own time limit and no pause, as a cause solve is.
struct Limits {
  // NOLINTNEXTLINE(google-explicit-constructor): a stand-in takes seconds
  Limits(double seconds = 0) : seconds(seconds) {}
  // NOLINTNEXTLINE(google-explicit-constructor)
  operator double() const { return seconds; }

  double seconds;
  Stage stage = Stage::Cause;
  // The model's first `gameColumns` columns are games.
  int gameColumns = 0;
  // The most games an objective bound allows.
  std::function<int(double)> boundGames;
};

// Solves a model; a stand-in lets tests answer as a solver would.
using Solver = std::function<SolveResult(const Model&, const Limits&)>;
// HiGHS on this thread. With a session, the targets and placement solves
// report their progress and pause at its deadline instead of HiGHS's time
// limit.
Solver highsSolver(double seed, Session* session = nullptr);

// A typed failure: the engine answers it instead of options.
class Failure : public std::runtime_error {
 public:
  Failure(std::string failure, const std::string& message)
      : std::runtime_error(message), failure(std::move(failure)) {}
  std::string failure;
  int64_t columns = -1;
  int64_t limit = -1;
};

struct ExactOptions {
  // Without a session: the target and placement solves' deadline, and the
  // cause solves' own budget after them.
  double deadlineMs = 45'000;
  double causeBudgetMs = 30'000;
  int64_t maxColumns = 400'000;
  std::function<double()> now;  // milliseconds; defaults to a steady clock
  // With one, its deadline governs every solve (causes get what is left,
  // at least kCauseMinimumMs each), and the phases are reported to it.
  Session* session = nullptr;
};

// The least time a cause solve gets, however little the session has left.
constexpr double kCauseMinimumMs = 5'000;

// Settles and places a run exactly: targets and placement for a full or
// partial build (regular and exhibition games), or the most of the
// required matchups for a recalculation. Throws Failure.
Settlement exactSettle(const RunContext& context, const Solver& solve,
                       const ExactOptions& options);

// The first solve's model, for tests: its columns and each season's target
// column.
struct TargetModel {
  Model model;
  std::vector<int> targetCols;
};
std::optional<TargetModel> targetModel(const RunContext& context,
                                       int64_t maxColumns);

// ------------------------------------------------------------- cancel

// A build's cancel flag on the thread that runs it, for as long as the
// scope lives. Whoever asked for the build sets the flag from any thread;
// HiGHS's interrupt callbacks (MIP, simplex and IPM) read it, as do the
// engine's own steps, and the build answers the `canceled` failure.
class CancelScope {
 public:
  explicit CancelScope(const std::atomic<bool>* flag);
  ~CancelScope();
  CancelScope(const CancelScope&) = delete;
  CancelScope& operator=(const CancelScope&) = delete;

 private:
  const std::atomic<bool>* previous_;
};

// Whether this thread's build has been asked to stop.
bool canceled();
// Throws the `canceled` failure when it has.
void throwIfCanceled();

// ------------------------------------------------------------- options

// The whole build as JSON, for a request; never throws. At the time limit
// it takes the best schedule found.
std::string buildSchedule(const std::string& request);
// The same, stopped with the `canceled` failure once `cancel` is set.
std::string buildSchedule(const std::string& request, const std::atomic<bool>& cancel);
// The same, telling `reporter` each event and asking it at the time limit.
std::string buildSchedule(const std::string& request, const std::atomic<bool>& cancel,
                          const Reporter& reporter);
// The same with a stand-in solver, for tests.
std::string buildSchedule(const std::string& request, const Solver& solve,
                          const ExactOptions* options);

}  // namespace teamstation::scheduler
