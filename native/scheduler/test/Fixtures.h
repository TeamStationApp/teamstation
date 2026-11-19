#pragma once

// Requests the engine's C++ tests build: invented teams on an invented
// field in Chicago's zone, the shapes of src/common/autoScheduler/
// fixtures.test.ts and the exact suites, written as EngineRequest JSON.
#include <string>
#include <utility>
#include <vector>

#include "Engine.h"
#include "Json.h"
#include "doctest.h"

namespace fixtures {

using teamstation::scheduler::json::Writer;

// Chicago's offsets from September 2026 to the end of 2027, as
// src/common/scheduler/engine.ts `zoneOffsets` reads them.
inline void chicago(Writer& out) {
  out.key("America/Chicago").beginArray();
  const std::pair<int64_t, int> offsets[] = {{1788220800000, -300},
                                             {1793516400000, -360},
                                             {1805011200000, -300},
                                             {1825570800000, -360}};
  for (const auto& [from, minutes] : offsets) {
    out.beginObject();
    out.key("fromUtc").integer(from);
    out.key("offsetMinutes").integer(minutes);
    out.endObject();
  }
  out.endArray();
}

struct Hours {
  std::vector<int> weekdays;
  std::string start;
  std::string end;
};

struct Period {
  std::string from;
  std::string until;  // empty: none
  std::vector<Hours> hours;
};

struct Season {
  std::string id = "sea_demo";
  std::vector<std::string> participants{"tem_hawks", "tem_owls", "tem_foxes", "tem_bears"};
  std::vector<std::string> exhibitionTeams;
  std::vector<std::string> fieldIds{"fld_one"};
  std::string fieldSize = "50/70";
  int gameMinutes = 90;
  int bufferMinutes = 10;
  int regularGames = 2;
  int exhibitionGames = 0;
  std::string doubleheaders = "ifNecessary";
  int maxWeekdays = 200;
  int maxWeekend = 200;
  std::string preferGameOn = "weekend";
  std::string startsOn = "2027-03-01";
  std::string endsOn = "2027-03-31";
  std::vector<std::string> blackouts;
  std::vector<Period> windows{{"2027-03-01", "2027-03-31", {{{6}, "08:00", "18:00"}}}};
};

struct Field {
  std::string id = "fld_one";
  std::vector<std::string> sizes{"46/60", "50/70"};
  std::vector<Hours> hours{{{1, 2, 3, 4, 5}, "17:30", "21:00"}, {{6}, "08:00", "18:00"}};
  bool windows = false;  // give `windows` as one period of the hours
  std::vector<std::string> blackouts;
  int switchMinutes = 30;
};

struct Game {
  std::string key;
  std::string season = "sea_demo";
  std::string home;
  std::string away;
  bool exhibition = false;
  std::string field = "fld_one";  // empty: null
  std::string size = "50/70";     // empty: null
  int64_t start = 0;
  int minutes = 90;
};

struct Booking {
  std::string field;  // empty: null
  std::vector<std::string> teams;
  bool managerOnly = false;
  int64_t start = 0;
  int64_t end = 0;
};

struct Required {
  std::string key;
  std::string season = "sea_demo";
  std::string home;
  std::string away;
  bool exhibition = false;
};

struct Run {
  std::vector<Season> seasons{Season{}};
  std::vector<Field> fields{Field{}};
  std::vector<Game> fixed;
  std::vector<Booking> bookings;
  std::vector<std::pair<std::string, std::string>> headCoaches;
  bool required = false;
  std::vector<Required> matchups;
  bool partial = false;
  std::vector<std::string> teamIds;
  int64_t notBefore = 1792558800000;  // 2026-10-22T05:00:00Z
  double seed = 7;
  double limitMs = 45000;
  int64_t maxColumns = -1;
};

// An instant: "2027-03-06T14:00:00Z".
inline int64_t at(const std::string& iso) {
  const int day = teamstation::scheduler::parseDate(iso.substr(0, 10));
  const int hour = std::stoi(iso.substr(11, 2));
  const int minute = std::stoi(iso.substr(14, 2));
  return static_cast<int64_t>(day) * 86'400'000 + (hour * 60 + minute) * 60'000;
}

inline void hours(Writer& out, const std::vector<Hours>& list) {
  out.beginArray();
  for (const Hours& entry : list)
    for (const int weekday : entry.weekdays) {
      out.beginObject();
      out.key("weekday").integer(weekday);
      out.key("start").string(entry.start);
      out.key("end").string(entry.end);
      out.endObject();
    }
  out.endArray();
}

inline void strings(Writer& out, const std::vector<std::string>& list) {
  out.beginArray();
  for (const std::string& value : list) out.string(value);
  out.endArray();
}

inline void nullable(Writer& out, const std::string& value) {
  if (value.empty())
    out.null();
  else
    out.string(value);
}

inline std::string request(const Run& run) {
  Writer out;
  out.beginObject();
  out.key("input").beginObject();
  out.key("seasons").beginArray();
  for (const Season& season : run.seasons) {
    out.beginObject();
    out.key("id").string(season.id);
    out.key("name").string(season.id);
    out.key("participants");
    strings(out, season.participants);
    out.key("exhibitionTeams");
    strings(out, season.exhibitionTeams);
    out.key("settings").beginObject();
    out.key("fieldIds");
    strings(out, season.fieldIds);
    out.key("fieldSize").string(season.fieldSize);
    out.key("gameMinutes").integer(season.gameMinutes);
    out.key("bufferMinutes").integer(season.bufferMinutes);
    out.key("regularGames").integer(season.regularGames);
    out.key("exhibitionGames").integer(season.exhibitionGames);
    out.key("doubleheaders").string(season.doubleheaders);
    out.key("maxGamesOnWeekdays").integer(season.maxWeekdays);
    out.key("maxGamesOnWeekend").integer(season.maxWeekend);
    out.key("preferGameOn").string(season.preferGameOn);
    out.key("startsOn").string(season.startsOn);
    out.key("endsOn").string(season.endsOn);
    out.key("blackouts");
    strings(out, season.blackouts);
    out.key("windows").beginArray();
    for (const Period& period : season.windows) {
      out.beginObject();
      out.key("from").string(period.from);
      if (!period.until.empty()) out.key("until").string(period.until);
      out.key("hours");
      hours(out, period.hours);
      out.endObject();
    }
    out.endArray();
    out.endObject();
    out.endObject();
  }
  out.endArray();
  out.key("fields").beginArray();
  for (const Field& field : run.fields) {
    out.beginObject();
    out.key("id").string(field.id);
    out.key("name").string(field.id);
    out.key("venueName").string("Demo Park");
    out.key("sizes");
    strings(out, field.sizes);
    out.key("availability").beginObject();
    out.key("startsOn").string("2026-10-01");
    out.key("endsOn").string("2027-09-30");
    out.key("hours");
    hours(out, field.hours);
    if (field.windows) {
      out.key("windows").beginArray().beginObject();
      out.key("from").string("0001-01-01");
      out.key("hours");
      hours(out, field.hours);
      out.endObject().endArray();
    }
    out.key("blackouts");
    strings(out, field.blackouts);
    out.key("timezone").string("America/Chicago");
    out.endObject();
    out.key("switchMinutes").integer(field.switchMinutes);
    out.endObject();
  }
  out.endArray();
  out.key("bookings").beginArray();
  for (const Booking& booking : run.bookings) {
    out.beginObject();
    if (booking.managerOnly) out.key("managerOnly").boolean(true);
    out.key("key").string("bkg");
    out.key("fieldId");
    nullable(out, booking.field);
    out.key("size").null();
    out.key("teamIds");
    strings(out, booking.teams);
    out.key("start").integer(booking.start);
    out.key("end").integer(booking.end);
    out.endObject();
  }
  out.endArray();
  out.key("fixed").beginArray();
  for (const Game& game : run.fixed) {
    out.beginObject();
    out.key("key").string(game.key);
    out.key("seasonId").string(game.season);
    out.key("homeTeamId").string(game.home);
    out.key("awayTeamId").string(game.away);
    out.key("exhibition").boolean(game.exhibition);
    out.key("fieldId");
    nullable(out, game.field);
    out.key("size");
    nullable(out, game.size);
    out.key("start").integer(game.start);
    out.key("end").integer(game.start + game.minutes * 60'000);
    out.endObject();
  }
  out.endArray();
  if (!run.headCoaches.empty()) {
    out.key("headCoaches").beginObject();
    for (const auto& [team, manager] : run.headCoaches) out.key(team).string(manager);
    out.endObject();
  }
  out.key("teamNames").beginObject();
  for (const char* team : {"tem_hawks", "tem_owls", "tem_foxes", "tem_bears", "tem_wolves",
                           "tem_lynx", "tem_otters"}) {
    std::string name = std::string(team).substr(4);
    name[0] = static_cast<char>(name[0] - 'a' + 'A');
    out.key(team).string("Demo " + name);
  }
  out.endObject();
  if (run.partial) {
    out.key("teamIds");
    strings(out, run.teamIds);
  }
  out.key("notBefore").integer(run.notBefore);
  out.key("seed").number(run.seed);
  if (run.required) {
    out.key("required").beginArray();
    for (const Required& matchup : run.matchups) {
      out.beginObject();
      out.key("key").string(matchup.key);
      out.key("seasonId").string(matchup.season);
      out.key("homeTeamId").string(matchup.home);
      out.key("awayTeamId").string(matchup.away);
      out.key("exhibition").boolean(matchup.exhibition);
      out.endObject();
    }
    out.endArray();
  }
  out.endObject();
  out.key("offsets").beginObject();
  chicago(out);
  out.endObject();
  out.key("limitMs").number(run.limitMs);
  if (run.maxColumns >= 0) out.key("maxColumns").integer(run.maxColumns);
  out.endObject();
  return out.text();
}

// The request read and its context built.
inline std::shared_ptr<teamstation::scheduler::RunContext> context(const Run& run) {
  using namespace teamstation::scheduler;
  return buildContext(readRequest(json::parse(request(run))).input);
}

inline teamstation::scheduler::json::Value result(const std::string& text) {
  return teamstation::scheduler::json::parse(text);
}

// A build's result, with the HiGHS solver or a stand-in.
inline teamstation::scheduler::json::Value build(
    const Run& run, const teamstation::scheduler::Solver* solve = nullptr,
    const teamstation::scheduler::ExactOptions* options = nullptr) {
  using namespace teamstation::scheduler;
  if (solve == nullptr && options == nullptr) return result(buildSchedule(request(run)));
  const Solver highs = highsSolver(run.seed);
  return result(buildSchedule(request(run), solve != nullptr ? *solve : highs, options));
}

inline std::string text(const teamstation::scheduler::json::Value* value) {
  REQUIRE(value != nullptr);
  return value->string;
}

inline double number(const teamstation::scheduler::json::Value* value) {
  REQUIRE(value != nullptr);
  return value->number;
}

// The first option's games.
inline const std::vector<teamstation::scheduler::json::Value>& games(
    const teamstation::scheduler::json::Value& built) {
  const auto* options = built.find("options");
  REQUIRE(options != nullptr);
  REQUIRE(!options->array.empty());
  return options->array.front().find("games")->array;
}

// The settled regular count of the first season.
inline int regular(const teamstation::scheduler::json::Value& built, size_t season = 0) {
  const auto* targets = built.find("targets");
  REQUIRE(targets != nullptr);
  REQUIRE(targets->array.size() > season);
  return static_cast<int>(targets->array[season].find("regular")->number);
}

}  // namespace fixtures
