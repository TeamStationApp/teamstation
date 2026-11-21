// A build's control and the builds a phone's module or the Node addon's
// environment has started (phone/BuildControl.h): when the owner goes, each
// build still running is stopped, a paused one included, and the one-build
// lock it held is free for the next.
#include <chrono>
#include <future>
#include <memory>
#include <mutex>
#include <thread>

#include "doctest.h"
#include "phone/BuildControl.h"

using teamstation::scheduler::Control;
using teamstation::scheduler::Decision;
using teamstation::scheduler::LiveBuilds;

TEST_CASE("a control answers a pause with the decision, or with cancel once stopped") {
  Control control;
  control.decide(Decision::Continue);
  // Said early, it answers the next pause; only the first answer counts.
  control.decide(Decision::Use);
  CHECK(control.wait() == Decision::Continue);
  control.stop();
  CHECK(control.cancel.load());
  CHECK(control.wait() == Decision::Cancel);
}

TEST_CASE("an owner that goes stops its paused build, which frees the one-build lock") {
  std::mutex building;
  auto live = std::make_unique<LiveBuilds>();
  auto control = std::make_shared<Control>();
  live->add(control);
  std::promise<void> holding;
  // A build paused at its time limit: it holds the lock while it waits.
  std::future<Decision> paused = std::async(std::launch::async, [&] {
    const std::lock_guard<std::mutex> lock(building);
    holding.set_value();
    return control->wait();
  });
  holding.get_future().wait();
  CHECK(paused.wait_for(std::chrono::milliseconds(50)) == std::future_status::timeout);
  // The runtime reloads, or the environment is torn down.
  live->stopAll();
  live.reset();
  REQUIRE(paused.wait_for(std::chrono::seconds(10)) == std::future_status::ready);
  CHECK(paused.get() == Decision::Cancel);
  // The next build gets the lock.
  CHECK(building.try_lock());
  building.unlock();
}

TEST_CASE("live builds pass over finished ones, and stop one started after the owner went") {
  LiveBuilds live;
  {
    auto finished = std::make_shared<Control>();
    live.add(finished);
  }
  auto running = std::make_shared<Control>();
  live.add(running);
  // The finished build is dropped as the next is added.
  CHECK(live.size() == 1);
  live.stopAll();
  CHECK(running->cancel.load());
  CHECK(live.size() == 0);
  auto late = std::make_shared<Control>();
  live.add(late);
  CHECK(late->cancel.load());
  CHECK(live.size() == 0);
}
