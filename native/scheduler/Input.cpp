// Reads an EngineRequest (src/common/scheduler/engine.ts): the EngineInput of
// src/common/autoScheduler/types.ts, each zone's UTC offsets over the run's
// window, and the solver's time limit.
#include <cmath>
#include <stdexcept>

#include "Engine.h"

namespace teamstation::scheduler {

int Names::intern(const std::string& name) {
  const auto found = ids_.find(name);
  if (found != ids_.end()) return found->second;
  const int id = static_cast<int>(names_.size());
  names_.push_back(name);
  ids_.emplace(name, id);
  return id;
}

int Names::find(const std::string& name) const {
  const auto found = ids_.find(name);
  return found == ids_.end() ? -1 : found->second;
}

const ZoneOffsets& Input::zone(const std::string& name) const {
  const auto found = zones.find(name);
  if (found != zones.end()) return found->second;
  static const ZoneOffsets utc;
  if (name == "UTC" || name == "Etc/UTC") return utc;
  throw std::invalid_argument("No UTC offsets for the zone " + name);
}

std::string Input::teamName(int team) const {
  const auto found = teamNames.find(team);
  return found == teamNames.end() ? teams.name(team) : found->second;
}

namespace {

using json::Value;

[[noreturn]] void bad(const std::string& what) {
  throw std::invalid_argument("Bad request: " + what);
}

const Value& member(const Value& object, const char* key) {
  const Value* value = object.find(key);
  if (value == nullptr) bad(std::string("missing ") + key);
  return *value;
}

// A member that may be left out or null.
const Value* optional(const Value& object, const char* key) {
  const Value* value = object.find(key);
  return value == nullptr || value->isNull() ? nullptr : value;
}

const std::string& text(const Value& value, const char* what) {
  if (value.type != Value::Type::String) bad(std::string(what) + " is not text");
  return value.string;
}

double number(const Value& value, const char* what) {
  if (value.type != Value::Type::Number) bad(std::string(what) + " is not a number");
  return value.number;
}

int64_t whole(const Value& value, const char* what) {
  return static_cast<int64_t>(std::llround(number(value, what)));
}

bool flag(const Value& value, const char* what) {
  if (value.type != Value::Type::Bool) bad(std::string(what) + " is not true or false");
  return value.boolean;
}

const std::vector<Value>& list(const Value& value, const char* what) {
  if (value.type != Value::Type::Array) bad(std::string(what) + " is not a list");
  return value.array;
}

std::vector<WeekdayHours> readHours(const Value& value) {
  std::vector<WeekdayHours> out;
  for (const Value& entry : list(value, "hours"))
    out.push_back({static_cast<int>(whole(member(entry, "weekday"), "weekday")),
                   wallMinutes(text(member(entry, "start"), "start")),
                   wallMinutes(text(member(entry, "end"), "end"))});
  return out;
}

std::vector<WindowPeriod> readPeriods(const Value& value) {
  std::vector<WindowPeriod> out;
  for (const Value& entry : list(value, "windows")) {
    WindowPeriod period;
    period.from = parseDate(text(member(entry, "from"), "from"));
    if (const Value* until = optional(entry, "until"))
      period.until = parseDate(text(*until, "until"));
    period.hours = readHours(member(entry, "hours"));
    out.push_back(std::move(period));
  }
  return out;
}

std::vector<int> readDates(const Value& value) {
  std::vector<int> out;
  for (const Value& entry : list(value, "dates"))
    out.push_back(parseDate(text(entry, "date")));
  return out;
}

std::vector<int> readTeams(Input& input, const Value& value) {
  std::vector<int> out;
  for (const Value& entry : list(value, "teams"))
    out.push_back(input.teams.intern(text(entry, "team")));
  return out;
}

int readField(Input& input, const Value* value) {
  return value == nullptr ? -1 : input.fieldNames.intern(text(*value, "fieldId"));
}

int readSize(Input& input, const Value* value) {
  return value == nullptr ? -1 : input.sizes.intern(text(*value, "size"));
}

Settings readSettings(Input& input, const Value& value) {
  Settings settings;
  if (const Value* ids = optional(value, "fieldIds"))
    for (const Value& id : list(*ids, "fieldIds"))
      settings.fieldIds.push_back(input.fieldNames.intern(text(id, "fieldId")));
  settings.fieldSize = input.sizes.intern(text(member(value, "fieldSize"), "fieldSize"));
  settings.gameMinutes = static_cast<int>(whole(member(value, "gameMinutes"), "gameMinutes"));
  settings.bufferMinutes =
      static_cast<int>(whole(member(value, "bufferMinutes"), "bufferMinutes"));
  settings.regularGames = static_cast<int>(whole(member(value, "regularGames"), "regularGames"));
  settings.exhibitionGames =
      static_cast<int>(whole(member(value, "exhibitionGames"), "exhibitionGames"));
  if (settings.gameMinutes <= 0) bad("gameMinutes is not positive");
  // A negative buffer could leave no time between starts at all.
  if (settings.bufferMinutes < 0) bad("bufferMinutes is negative");
  const std::string& doubleheaders = text(member(value, "doubleheaders"), "doubleheaders");
  settings.doubleheaders = doubleheaders == "never"         ? Doubleheaders::Never
                           : doubleheaders == "ifNecessary" ? Doubleheaders::IfNecessary
                                                            : Doubleheaders::Allowed;
  if (const Value* max = optional(value, "maxGamesOnWeekdays"))
    settings.maxGamesOnWeekdays = whole(*max, "maxGamesOnWeekdays");
  if (const Value* max = optional(value, "maxGamesOnWeekend"))
    settings.maxGamesOnWeekend = whole(*max, "maxGamesOnWeekend");
  if (const Value* prefer = optional(value, "preferGameOn"))
    settings.preferWeekdays = text(*prefer, "preferGameOn") == "weekdays";
  settings.startsOn = parseDate(text(member(value, "startsOn"), "startsOn"));
  settings.endsOn = parseDate(text(member(value, "endsOn"), "endsOn"));
  settings.blackouts = readDates(member(value, "blackouts"));
  settings.windows = readPeriods(member(value, "windows"));
  return settings;
}

void readInput(Input& input, const Value& value) {
  // The run's fields take the first field numbers, so a field's number is
  // its place in `fields`.
  for (const Value& entry : list(member(value, "fields"), "fields")) {
    Field field;
    field.id = input.fieldNames.intern(text(member(entry, "id"), "id"));
    field.name = text(member(entry, "name"), "name");
    for (const Value& size : list(member(entry, "sizes"), "sizes"))
      field.sizes.push_back(input.sizes.intern(text(size, "size")));
    const Value& availability = member(entry, "availability");
    if (const Value* startsOn = optional(availability, "startsOn"))
      field.availability.startsOn = parseDate(text(*startsOn, "startsOn"));
    if (const Value* endsOn = optional(availability, "endsOn"))
      field.availability.endsOn = parseDate(text(*endsOn, "endsOn"));
    field.availability.hours = readHours(member(availability, "hours"));
    if (const Value* windows = availability.find("windows")) {
      field.availability.hasWindows = true;
      field.availability.windows = readPeriods(*windows);
    }
    field.availability.blackouts = readDates(member(availability, "blackouts"));
    field.availability.timezone = text(member(availability, "timezone"), "timezone");
    field.switchMinutes = static_cast<int>(whole(member(entry, "switchMinutes"), "switchMinutes"));
    if (field.id != static_cast<int>(input.fields.size())) bad("a field is listed twice");
    input.fields.push_back(std::move(field));
  }
  for (const Value& entry : list(member(value, "seasons"), "seasons")) {
    Season season;
    season.id = text(member(entry, "id"), "id");
    season.name = text(member(entry, "name"), "name");
    season.participants = readTeams(input, member(entry, "participants"));
    season.exhibitionTeams = readTeams(input, member(entry, "exhibitionTeams"));
    season.settings = readSettings(input, member(entry, "settings"));
    input.seasons.push_back(std::move(season));
  }
  for (const Value& entry : list(member(value, "bookings"), "bookings")) {
    Booking booking;
    if (const Value* only = optional(entry, "managerOnly"))
      booking.managerOnly = flag(*only, "managerOnly");
    booking.field = readField(input, optional(entry, "fieldId"));
    booking.size = readSize(input, optional(entry, "size"));
    booking.teams = readTeams(input, member(entry, "teamIds"));
    booking.start = whole(member(entry, "start"), "start");
    booking.end = whole(member(entry, "end"), "end");
    input.bookings.push_back(std::move(booking));
  }
  for (const Value& entry : list(member(value, "fixed"), "fixed")) {
    FixedGame game;
    game.key = text(member(entry, "key"), "key");
    game.seasonId = text(member(entry, "seasonId"), "seasonId");
    game.home = input.teams.intern(text(member(entry, "homeTeamId"), "homeTeamId"));
    game.away = input.teams.intern(text(member(entry, "awayTeamId"), "awayTeamId"));
    game.exhibition = flag(member(entry, "exhibition"), "exhibition");
    game.field = readField(input, optional(entry, "fieldId"));
    game.size = readSize(input, optional(entry, "size"));
    game.start = whole(member(entry, "start"), "start");
    game.end = whole(member(entry, "end"), "end");
    input.fixed.push_back(std::move(game));
  }
  if (const Value* weekly = optional(value, "weeklyGames")) {
    input.hasWeeklyGames = true;
    for (const Value& entry : list(*weekly, "weeklyGames")) {
      WeeklyGame game;
      game.seasonId = text(member(entry, "seasonId"), "seasonId");
      game.field = readField(input, optional(entry, "fieldId"));
      game.teams = readTeams(input, member(entry, "teamIds"));
      game.start = whole(member(entry, "start"), "start");
      input.weeklyGames.push_back(std::move(game));
    }
  }
  const Value& names = member(value, "teamNames");
  if (names.type != Value::Type::Object) bad("teamNames is not an object");
  for (const auto& [team, name] : names.object)
    input.teamNames[input.teams.intern(team)] = text(name, "team name");
  if (const Value* ids = optional(value, "teamIds")) {
    input.partial = true;
    input.teamIds = readTeams(input, *ids);
  }
  input.notBefore = whole(member(value, "notBefore"), "notBefore");
  input.seed = number(member(value, "seed"), "seed");
  if (const Value* required = optional(value, "required")) {
    input.hasRequired = true;
    for (const Value& entry : list(*required, "required")) {
      Matchup matchup;
      matchup.key = text(member(entry, "key"), "key");
      matchup.seasonId = text(member(entry, "seasonId"), "seasonId");
      matchup.home = input.teams.intern(text(member(entry, "homeTeamId"), "homeTeamId"));
      matchup.away = input.teams.intern(text(member(entry, "awayTeamId"), "awayTeamId"));
      matchup.exhibition = flag(member(entry, "exhibition"), "exhibition");
      input.required.push_back(std::move(matchup));
    }
  }
  std::vector<std::pair<int, int>> coaches;
  if (const Value* headCoaches = optional(value, "headCoaches")) {
    if (headCoaches->type != Value::Type::Object) bad("headCoaches is not an object");
    for (const auto& [team, manager] : headCoaches->object)
      coaches.emplace_back(input.teams.intern(team),
                           input.managers.intern(text(manager, "manager")));
  }
  input.headCoaches.assign(input.teams.size(), -1);
  for (const auto& [team, manager] : coaches) input.headCoaches[team] = manager;
}

void readOffsets(Input& input, const Value& value) {
  if (value.type != Value::Type::Object) bad("offsets is not an object");
  for (const auto& [zone, transitions] : value.object) {
    ZoneOffsets offsets;
    for (const Value& entry : list(transitions, "offsets")) {
      offsets.from.push_back(whole(member(entry, "fromUtc"), "fromUtc"));
      offsets.minutes.push_back(
          static_cast<int>(whole(member(entry, "offsetMinutes"), "offsetMinutes")));
    }
    if (offsets.from.empty()) bad("no offsets for " + zone);
    input.zones[zone] = std::move(offsets);
  }
}

}  // namespace

Request readRequest(const json::Value& document) {
  Request request;
  request.input = std::make_shared<Input>();
  readInput(*request.input, member(document, "input"));
  readOffsets(*request.input, member(document, "offsets"));
  if (const Value* limit = optional(document, "limitMs"))
    request.limitMs = number(*limit, "limitMs");
  if (const Value* max = optional(document, "maxColumns"))
    request.maxColumns = whole(*max, "maxColumns");
  // Teams named after the managers were read have no manager.
  request.input->headCoaches.resize(request.input->teams.size(), -1);
  return request;
}

}  // namespace teamstation::scheduler
