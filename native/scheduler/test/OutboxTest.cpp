// The phones' outbox (phone/Outbox.h): a build's events, then its result,
// reach JavaScript in the order the build sent them, however the JS thread
// orders the deliveries posted for them.
#include <algorithm>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "doctest.h"
#include "phone/Outbox.h"

using teamstation::scheduler::Outbox;

namespace {

// A JS thread that runs what it is posted in an order of the test's own.
struct JsThread {
  Outbox outbox;
  std::vector<std::function<void()>> posted;
  std::vector<std::string> heard;

  void send(bool result, const std::string &text) {
    if (!outbox.send(result, text)) return;
    posted.emplace_back([this] {
      outbox.deliver([this](const std::string &event) { heard.push_back(event); },
                     [this](const std::string &answer) { heard.push_back("result " + answer); });
    });
  }
};

const std::vector<std::string> kLast = {
    R"({"kind":"phase","phase":"cause"})", R"({"kind":"phase-start","phase":"polish"})",
    R"({"kind":"phase","phase":"polish"})", R"({"kind":"phase-start","phase":"options"})",
    R"({"kind":"phase","phase":"options"})"};

}  // namespace

TEST_CASE("every event reaches JavaScript before the result, whatever order deliveries run in") {
  for (const bool reversed : {false, true}) {
    JsThread js;
    for (const std::string &event : kLast) js.send(false, event);
    js.send(true, "{}");
    REQUIRE(js.posted.size() == kLast.size() + 1);
    if (reversed) std::reverse(js.posted.begin(), js.posted.end());
    for (const auto &run : js.posted) run();
    std::vector<std::string> expected = kLast;
    expected.emplace_back("result {}");
    CHECK(js.heard == expected);
  }
}

TEST_CASE("nothing is sent after the result") {
  JsThread js;
  js.send(false, "a");
  js.send(true, "done");
  js.send(false, "late");
  js.send(true, "again");
  CHECK(js.posted.size() == 2);
  for (const auto &run : js.posted) run();
  CHECK(js.heard == std::vector<std::string>{"a", "result done"});
}

TEST_CASE("a delivery that runs between sends hands over what has come so far") {
  JsThread js;
  js.send(false, "a");
  js.posted[0]();
  CHECK(js.heard == std::vector<std::string>{"a"});
  js.send(false, "b");
  js.send(true, "done");
  js.posted[2]();
  js.posted[1]();
  CHECK(js.heard == std::vector<std::string>{"a", "b", "result done"});
}

TEST_CASE("a build thread's sends and the JS thread's deliveries keep the build's order") {
  Outbox outbox;
  std::vector<std::string> heard;
  bool answered = false;
  std::thread build([&outbox] {
    for (int i = 0; i < 1000; ++i) outbox.send(false, std::to_string(i));
    outbox.send(true, "done");
  });
  while (!answered)
    outbox.deliver([&heard](const std::string &event) { heard.push_back(event); },
                   [&answered](const std::string &) { answered = true; });
  build.join();
  REQUIRE(heard.size() == 1000);
  for (int i = 0; i < 1000; ++i) CHECK(heard[static_cast<size_t>(i)] == std::to_string(i));
}
