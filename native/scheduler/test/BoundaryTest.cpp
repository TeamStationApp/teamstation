// The JSON boundary, the calendar and the request reader.
#include "Calendar.h"
#include "Engine.h"
#include "Fixtures.h"
#include "Json.h"
#include "doctest.h"

using namespace teamstation::scheduler;

TEST_CASE("JSON reads every value, escapes included, and refuses what is not JSON") {
  const json::Value value = json::parse(
      R"( {"a": [1, -2.5e1, true, false, null], "b": "x\n\"\\\/\b\f\r\t\u00e9\ud83d\ude00", "c": {}, "d": []} )");
  REQUIRE(value.type == json::Value::Type::Object);
  const json::Value* a = value.find("a");
  REQUIRE(a != nullptr);
  CHECK(a->array.size() == 5);
  CHECK(a->array[1].number == -25);
  CHECK(a->array[2].boolean);
  CHECK(!a->array[3].boolean);
  CHECK(a->array[4].isNull());
  CHECK(value.find("b")->string == "x\n\"\\/\b\f\r\t\xc3\xa9\xf0\x9f\x98\x80");
  CHECK(value.find("missing") == nullptr);
  CHECK(a->find("a") == nullptr);
  CHECK(json::parse("\"\\u0041\\u07ff\\uffff\"").string == "A\xdf\xbf\xef\xbf\xbf");
  // A surrogate pair counts only as one: a high surrogate before any other
  // escape, or a lone low one, is the replacement character, and the escape
  // after it is read as itself.
  const std::string replacement = "\xef\xbf\xbd";
  CHECK(json::parse("\"\\ud83d\\u0041\"").string == replacement + "A");
  CHECK(json::parse("\"\\ud83d\\ud83d\\ude00\"").string == replacement + "\xf0\x9f\x98\x80");
  CHECK(json::parse("\"\\ud83dx\"").string == replacement + "x");
  CHECK(json::parse("\"\\ud83d\"").string == replacement);
  CHECK(json::parse("\"\\ude00\"").string == replacement);
  CHECK(json::parse("\"\\udbff\\udfff\"").string == "\xf4\x8f\xbf\xbf");
  for (const char* bad : {"", "{", "[1,", "[1 2]", "{\"a\" 1}", "{1: 2}", "{\"a\": 1 \"b\"}",
                          "\"open", "\"bad \\q\"", "\"\\u12\"", "\"\\uzzzz\"", "tru", "-",
                          "1.2.3", "[] []", "\"\\"})
    CHECK_THROWS_AS(json::parse(bad), json::Error);
  std::string deep;
  for (int i = 0; i < 70; ++i) deep += "[";
  CHECK_THROWS_AS(json::parse(deep), json::Error);
}

TEST_CASE("the JSON writer separates values and escapes strings") {
  json::Writer out;
  out.beginObject();
  out.key("n").number(1.5);
  out.key("i").number(5);
  out.key("big").integer(-1792558800000);
  out.key("inf").number(1.0 / 0.0);
  out.key("s").string("a\"b\\c\nd\re\tf\x01");
  out.key("list").beginArray().boolean(true).boolean(false).null().endArray();
  out.endObject();
  CHECK(out.text() ==
        R"({"n":1.5,"i":5,"big":-1792558800000,"inf":null,"s":"a\"b\\c\nd\re\tf\u0001","list":[true,false,null]})");
}

TEST_CASE("calendar dates and wall times") {
  CHECK(parseDate("1970-01-01") == 0);
  CHECK(parseDate("1969-12-31") == -1);
  CHECK(dateString(parseDate("0001-01-01")) == "0001-01-01");
  CHECK(dateString(parseDate("2027-03-14")) == "2027-03-14");
  CHECK(dateString(parseDate("2400-02-29")) == "2400-02-29");
  CHECK(weekdayOf(parseDate("2027-03-06")) == 6);
  CHECK(weekdayOf(parseDate("1969-12-28")) == 0);
  for (const char* bad : {"2027-3-06", "2027-13-01", "2027-00-10", "2027-01-32", "20x7-01-01"})
    CHECK_THROWS_AS(parseDate(bad), std::invalid_argument);
  CHECK(wallMinutes("24:00") == 1440);
  CHECK(wallMinutes("08:05") == 485);
  for (const char* bad : {"8:00", "08-00", "0a:00"})
    CHECK_THROWS_AS(wallMinutes(bad), std::invalid_argument);
  CHECK(isoString(0) == "1970-01-01T00:00:00.000Z");
  CHECK(isoString(-1) == "1969-12-31T23:59:59.999Z");
  CHECK(isoString(fixtures::at("2027-03-06T14:05:00Z") + 7) == "2027-03-06T14:05:00.007Z");
  CHECK(floorDiv(-7, 2) == -4);
  CHECK(floorDiv(7, -2) == -4);
  CHECK(floorDiv(6, 3) == 2);
}

TEST_CASE("wall times read through a zone's offsets, across a daylight-saving change") {
  ZoneOffsets chicago;
  chicago.from = {1788220800000, 1793516400000, 1805011200000, 1825570800000};
  chicago.minutes = {-300, -360, -300, -360};
  CHECK(ZoneOffsets{}.offsetAt(0) == 0);
  CHECK(chicago.offsetAt(0) == -300);
  const int march14 = parseDate("2027-03-14");
  // 02:30 does not exist on March 14: it becomes the first step after the gap.
  CHECK_THROWS_AS(gameTime(march14, 150, chicago), SkippedTime);
  CHECK(wallInstant(march14, 150, chicago) == fixtures::at("2027-03-14T08:00:00Z"));
  CHECK(wallInstant(march14, 60, chicago) == fixtures::at("2027-03-14T07:00:00Z"));
  CHECK(wallInstant(march14, 1440, chicago) == fixtures::at("2027-03-15T05:00:00Z"));
  CHECK(calendarDay(fixtures::at("2027-03-07T01:00:00Z"), chicago) == parseDate("2027-03-06"));
  CHECK_THROWS_AS(gameTime(march14, 1440, chicago), SkippedTime);
  // A zone that skips longer than two hours has no such wall time at all.
  ZoneOffsets jump;
  jump.from = {0, fixtures::at("2027-03-14T02:00:00Z")};
  jump.minutes = {0, 240};
  CHECK_THROWS_AS(wallInstant(march14, 150, jump), SkippedTime);
}

TEST_CASE("a request that is not an EngineRequest is a broken failure") {
  for (const char* bad :
       {"[]", "{\"input\": {}}", "{\"input\": {\"fields\": 1}}",
        R"({"input": {"fields": [], "seasons": [], "bookings": [], "fixed": [], "teamNames": [], "notBefore": 0, "seed": 1}, "offsets": {}})",
        R"({"input": {"fields": [], "seasons": [], "bookings": [], "fixed": [], "teamNames": {}, "notBefore": "x", "seed": 1}, "offsets": {}})",
        R"({"input": {"fields": [], "seasons": [], "bookings": [], "fixed": [], "teamNames": {}, "notBefore": 0, "seed": 1, "headCoaches": []}, "offsets": {}})",
        R"({"input": {"fields": [], "seasons": [], "bookings": [], "fixed": [], "teamNames": {}, "notBefore": 0, "seed": 1}, "offsets": []})",
        R"({"input": {"fields": [], "seasons": [], "bookings": [], "fixed": [], "teamNames": {}, "notBefore": 0, "seed": 1}, "offsets": {"Z": []}})",
        R"({"input": {"fields": [], "seasons": [], "bookings": [{"teamIds": [1]}], "fixed": [], "teamNames": {}, "notBefore": 0, "seed": 1}, "offsets": {}})",
        R"({"input": {"fields": [], "seasons": [], "bookings": [{"managerOnly": 1, "teamIds": []}], "fixed": [], "teamNames": {}, "notBefore": 0, "seed": 1}, "offsets": {}})"}) {
    const json::Value answer = fixtures::result(buildSchedule(bad));
    CHECK(fixtures::text(answer.find("kind")) == "failure");
    CHECK(fixtures::text(answer.find("failure")) == "broken");
  }
  // A field's zone the request sends no offsets for.
  fixtures::Run run;
  std::string request = fixtures::request(run);
  const std::string zone = "\"America/Chicago\"";
  request.replace(request.find(zone), zone.size(), "\"Europe/Nowhere\"");
  const json::Value nowhere = fixtures::result(buildSchedule(request));
  CHECK(fixtures::text(nowhere.find("message")).find("Europe/Nowhere") != std::string::npos);
  // A field listed twice.
  fixtures::Run twice;
  twice.fields.push_back(fixtures::Field{});
  CHECK(fixtures::text(fixtures::build(twice).find("message")).find("twice") != std::string::npos);
  // A season with games of no length.
  fixtures::Run empty;
  empty.seasons[0].gameMinutes = 0;
  CHECK(fixtures::text(fixtures::build(empty).find("kind")) == "failure");
  // A negative buffer between games, which could leave no time between
  // starts, is refused rather than run.
  for (const int buffer : {-1, -90, -200}) {
    fixtures::Run negative;
    negative.seasons[0].bufferMinutes = buffer;
    const json::Value answer = fixtures::build(negative);
    CHECK(fixtures::text(answer.find("failure")) == "broken");
    CHECK(fixtures::text(answer.find("message")).find("bufferMinutes") != std::string::npos);
  }
}

TEST_CASE("the request's optional parts: weekly games, no head coaches, the UTC fallback") {
  fixtures::Run run;
  run.fields.clear();
  const auto context = fixtures::context(run);
  REQUIRE(context->seasons.size() == 1);
  CHECK(context->seasons[0].zones == std::vector<std::string>{"UTC"});
  CHECK(context->seasons[0].slots.empty());
  CHECK(context->input->teamName(context->input->teams.intern("tem_new")) == "tem_new");
  CHECK(context->input->teamName(context->input->teams.find("tem_hawks")) == "Demo Hawks");
  CHECK(context->input->managerOf(-1) == -1);
  CHECK(context->input->managerOf(1000) == -1);
  CHECK(context->fieldById(-1) == nullptr);
  CHECK(context->seasonOf("sea_none") == nullptr);
  CHECK(Names{}.find("x") == -1);
}
