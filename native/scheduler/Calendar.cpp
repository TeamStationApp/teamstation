#include "Calendar.h"

#include <cstdio>
#include <optional>

namespace teamstation::scheduler {

int64_t floorDiv(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
  return q;
}

// Howard Hinnant's days_from_civil and civil_from_days.
int dayFromCivil(int year, int month, int day) {
  year -= month <= 2 ? 1 : 0;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const int yoe = year - era * 400;
  const int doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  const int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

void civilFromDay(int days, int& year, int& month, int& day) {
  days += 719468;
  const int era = (days >= 0 ? days : days - 146096) / 146097;
  const int doe = days - era * 146097;
  const int yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const int mp = (5 * doy + 2) / 153;
  day = doy - (153 * mp + 2) / 5 + 1;
  month = mp < 10 ? mp + 3 : mp - 9;
  year = yoe + era * 400 + (month <= 2 ? 1 : 0);
}

int parseDate(const std::string& text) {
  auto digits = [&](size_t from, size_t count) {
    int value = 0;
    for (size_t i = from; i < from + count; ++i) {
      if (text[i] < '0' || text[i] > '9')
        throw std::invalid_argument("Not a date: " + text);
      value = value * 10 + (text[i] - '0');
    }
    return value;
  };
  if (text.size() != 10 || text[4] != '-' || text[7] != '-')
    throw std::invalid_argument("Not a date: " + text);
  const int month = digits(5, 2);
  const int day = digits(8, 2);
  if (month < 1 || month > 12 || day < 1 || day > 31)
    throw std::invalid_argument("Not a date: " + text);
  return dayFromCivil(digits(0, 4), month, day);
}

std::string dateString(int day) {
  int y = 0, m = 0, d = 0;
  civilFromDay(day, y, m, d);
  char buffer[16];
  std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d", y, m, d);
  return buffer;
}

int weekdayOf(int day) {
  // 1970-01-01 was a Thursday.
  return static_cast<int>(((static_cast<int64_t>(day) + 4) % 7 + 7) % 7);
}

int wallMinutes(const std::string& text) {
  if (text.size() != 5 || text[2] != ':')
    throw std::invalid_argument("Not a time: " + text);
  for (const size_t i : {0, 1, 3, 4})
    if (text[i] < '0' || text[i] > '9')
      throw std::invalid_argument("Not a time: " + text);
  return ((text[0] - '0') * 10 + (text[1] - '0')) * 60 +
         (text[3] - '0') * 10 + (text[4] - '0');
}

std::string isoString(Instant instant) {
  const int day = static_cast<int>(floorDiv(instant, kDay));
  const int64_t ms = instant - static_cast<int64_t>(day) * kDay;
  char buffer[40];
  std::snprintf(buffer, sizeof(buffer), "%sT%02d:%02d:%02d.%03dZ",
                dateString(day).c_str(), static_cast<int>(ms / 3'600'000),
                static_cast<int>(ms / 60'000 % 60),
                static_cast<int>(ms / 1000 % 60), static_cast<int>(ms % 1000));
  return buffer;
}

int ZoneOffsets::offsetAt(Instant instant) const {
  if (minutes.empty()) return 0;
  size_t found = 0;
  // Few transitions: a scan from the last.
  for (size_t i = from.size(); i-- > 0;)
    if (from[i] <= instant) {
      found = i;
      break;
    }
  return minutes[found];
}

Instant wallClock(Instant instant, const ZoneOffsets& zone) {
  const Instant local = instant + zone.offsetAt(instant) * kMinute;
  return floorDiv(local, kMinute) * kMinute;
}

namespace {

// gameTime without the throw: nothing when the zone skips that time.
std::optional<Instant> existingTime(int day, int minutes, const ZoneOffsets& zone) {
  if (minutes < 0 || minutes > 23 * 60 + 59) return std::nullopt;
  const Instant wanted = static_cast<Instant>(day) * kDay + minutes * kMinute;
  Instant instant = wanted;
  for (int pass = 0; pass < 3; ++pass) instant += wanted - wallClock(instant, zone);
  if (wallClock(instant, zone) != wanted) return std::nullopt;
  return instant;
}

}  // namespace

Instant gameTime(int day, int minutes, const ZoneOffsets& zone) {
  const std::optional<Instant> instant = existingTime(day, minutes, zone);
  if (!instant) throw SkippedTime();
  return *instant;
}

Instant wallInstant(int day, int minutes, const ZoneOffsets& zone) {
  if (minutes == 24 * 60) return wallInstant(day + 1, 0, zone);
  // A gap is never over two hours. (No exception carries the scan from
  // one try to the next: LLVM's WebAssembly exceptions miscompile a throw
  // caught and rethrown inside a loop.)
  for (int at = minutes; at <= minutes + 120; at += 5)
    if (const std::optional<Instant> instant = existingTime(day, at, zone)) return *instant;
  throw SkippedTime();
}

int calendarDay(Instant instant, const ZoneOffsets& zone) {
  return static_cast<int>(floorDiv(wallClock(instant, zone), kDay));
}

}  // namespace teamstation::scheduler
