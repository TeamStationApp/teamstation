#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// The engine's JSON boundary: a small reader for the request and a writer
// for the result. Objects keep their keys in document order.
namespace teamstation::scheduler::json {

struct Value {
  enum class Type { Null, Bool, Number, String, Array, Object };
  Type type = Type::Null;
  bool boolean = false;
  double number = 0;
  std::string string;
  std::vector<Value> array;
  std::vector<std::pair<std::string, Value>> object;

  bool isNull() const { return type == Type::Null; }
  // The member named `key`, or nullptr when there is none.
  const Value* find(const std::string& key) const;
};

// A request that is not the JSON the engine reads.
class Error : public std::runtime_error {
 public:
  explicit Error(const std::string& what) : std::runtime_error(what) {}
};

Value parse(const std::string& text);

// Writes JSON text as it is built: values, arrays and objects, each object
// member preceded by its key.
class Writer {
 public:
  Writer& beginObject();
  Writer& endObject();
  Writer& beginArray();
  Writer& endArray();
  Writer& key(const std::string& name);
  Writer& string(const std::string& value);
  Writer& number(double value);
  Writer& integer(int64_t value);
  Writer& boolean(bool value);
  Writer& null();
  const std::string& text() const { return out_; }

 private:
  void separate();
  std::string out_;
  // Per open container: whether a value has been written in it yet.
  std::vector<bool> written_;
  bool afterKey_ = false;
};

}  // namespace teamstation::scheduler::json
