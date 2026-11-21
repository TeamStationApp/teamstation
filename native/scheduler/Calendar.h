#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

// Calendar dates as day numbers, and instants read in a zone. The engine
// holds no time-zone database: JavaScript sends, for each zone a run uses,
// the UTC offsets in force over the run's window (src/common/scheduler/
// engine.ts), and these functions read wall times through them the way
// src/common/gameTime.ts and fieldAvailability.ts do with Intl.
namespace teamstation::scheduler {

using Instant = int64_t;  // epoch milliseconds
constexpr Instant kMinute = 60'000;
constexpr Instant kDay = 86'400'000;

int64_t floorDiv(int64_t a, int64_t b);

// Days since 1970-01-01 of a proleptic Gregorian date, and back.
int dayFromCivil(int year, int month, int day);
void civilFromDay(int days, int& year, int& month, int& day);
// "YYYY-MM-DD" as a day number; throws std::invalid_argument on anything else.
int parseDate(const std::string& text);
std::string dateString(int day);
// 0 is Sunday.
int weekdayOf(int day);
// "HH:MM" as minutes after midnight, "24:00" being 1440.
int wallMinutes(const std::string& text);
// The instant as Date.prototype.toISOString writes it.
std::string isoString(Instant instant);

// A zone's offsets: from each `from` instant on, `minutes` east of UTC.
// Before the first, the first applies.
struct ZoneOffsets {
  std::vector<Instant> from;
  std::vector<int> minutes;
  int offsetAt(Instant instant) const;
};

// A wall time that a daylight-saving change skips.
class SkippedTime : public std::runtime_error {
 public:
  SkippedTime() : std::runtime_error("That time does not exist in this zone") {}
};

// The wall clock of an instant in a zone, as an instant read as UTC, to the
// minute (Intl's parts).
Instant wallClock(Instant instant, const ZoneOffsets& zone);
// gameTime: the instant of `minutes` after midnight on `day`; throws
// SkippedTime when the zone skips it.
Instant gameTime(int day, int minutes, const ZoneOffsets& zone);
// wallInstant: the same, 1440 being the next day's midnight, and a skipped
// time becoming the first 5-minute step after the gap.
Instant wallInstant(int day, int minutes, const ZoneOffsets& zone);
// gameCalendarDay: the date of an instant in a zone.
int calendarDay(Instant instant, const ZoneOffsets& zone);

}  // namespace teamstation::scheduler
