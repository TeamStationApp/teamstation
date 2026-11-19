#include "Json.h"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace teamstation::scheduler::json {

const Value* Value::find(const std::string& key) const {
  if (type != Type::Object) return nullptr;
  for (const auto& [name, value] : object)
    if (name == key) return &value;
  return nullptr;
}

namespace {

class Parser {
 public:
  explicit Parser(const std::string& text) : text_(text) {}

  Value document() {
    Value value = parseValue(0);
    skipSpace();
    if (at_ != text_.size()) fail("text after the document");
    return value;
  }

 private:
  [[noreturn]] void fail(const std::string& what) const {
    throw Error("Bad request JSON at " + std::to_string(at_) + ": " + what);
  }

  void skipSpace() {
    while (at_ < text_.size() &&
           (text_[at_] == ' ' || text_[at_] == '\n' || text_[at_] == '\r' ||
            text_[at_] == '\t'))
      ++at_;
  }

  char peek() {
    skipSpace();
    if (at_ >= text_.size()) fail("unexpected end");
    return text_[at_];
  }

  void expectWord(const char* word) {
    for (const char* c = word; *c != '\0'; ++c, ++at_)
      if (at_ >= text_.size() || text_[at_] != *c) fail("unknown word");
  }

  Value parseValue(int depth) {
    if (depth > 64) fail("nested too deeply");
    Value value;
    const char c = peek();
    if (c == '{') {
      value.type = Value::Type::Object;
      ++at_;
      if (peek() == '}') {
        ++at_;
        return value;
      }
      for (;;) {
        if (peek() != '"') fail("expected a key");
        std::string name = parseString();
        if (peek() != ':') fail("expected ':'");
        ++at_;
        value.object.emplace_back(std::move(name), parseValue(depth + 1));
        const char next = peek();
        ++at_;
        if (next == '}') return value;
        if (next != ',') fail("expected ',' or '}'");
      }
    }
    if (c == '[') {
      value.type = Value::Type::Array;
      ++at_;
      if (peek() == ']') {
        ++at_;
        return value;
      }
      for (;;) {
        value.array.push_back(parseValue(depth + 1));
        const char next = peek();
        ++at_;
        if (next == ']') return value;
        if (next != ',') fail("expected ',' or ']'");
      }
    }
    if (c == '"') {
      value.type = Value::Type::String;
      value.string = parseString();
      return value;
    }
    if (c == 't') {
      expectWord("true");
      value.type = Value::Type::Bool;
      value.boolean = true;
      return value;
    }
    if (c == 'f') {
      expectWord("false");
      value.type = Value::Type::Bool;
      return value;
    }
    if (c == 'n') {
      expectWord("null");
      return value;
    }
    value.type = Value::Type::Number;
    value.number = parseNumber();
    return value;
  }

  double parseNumber() {
    const size_t start = at_;
    if (at_ < text_.size() && text_[at_] == '-') ++at_;
    while (at_ < text_.size() &&
           ((text_[at_] >= '0' && text_[at_] <= '9') || text_[at_] == '.' ||
            text_[at_] == 'e' || text_[at_] == 'E' || text_[at_] == '+' ||
            text_[at_] == '-'))
      ++at_;
    const std::string digits = text_.substr(start, at_ - start);
    if (digits.empty() || digits == "-") fail("expected a value");
    char* end = nullptr;
    const double number = std::strtod(digits.c_str(), &end);
    if (end != digits.c_str() + digits.size()) fail("bad number");
    return number;
  }

  unsigned hex4() {
    if (at_ + 4 > text_.size()) fail("short escape");
    unsigned code = 0;
    for (int i = 0; i < 4; ++i) {
      const char h = text_[at_++];
      code <<= 4;
      if (h >= '0' && h <= '9')
        code |= static_cast<unsigned>(h - '0');
      else if (h >= 'a' && h <= 'f')
        code |= static_cast<unsigned>(h - 'a' + 10);
      else if (h >= 'A' && h <= 'F')
        code |= static_cast<unsigned>(h - 'A' + 10);
      else
        fail("bad escape");
    }
    return code;
  }

  static void appendUtf8(std::string& out, unsigned code) {
    if (code < 0x80) {
      out += static_cast<char>(code);
    } else if (code < 0x800) {
      out += static_cast<char>(0xC0 | (code >> 6));
      out += static_cast<char>(0x80 | (code & 0x3F));
    } else if (code < 0x10000) {
      out += static_cast<char>(0xE0 | (code >> 12));
      out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (code & 0x3F));
    } else {
      out += static_cast<char>(0xF0 | (code >> 18));
      out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
      out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
      out += static_cast<char>(0x80 | (code & 0x3F));
    }
  }

  std::string parseString() {
    ++at_;  // the opening quote
    std::string out;
    for (;;) {
      if (at_ >= text_.size()) fail("unterminated string");
      const char c = text_[at_++];
      if (c == '"') return out;
      if (c != '\\') {
        out += c;
        continue;
      }
      if (at_ >= text_.size()) fail("unterminated string");
      const char e = text_[at_++];
      switch (e) {
        case '"':
        case '\\':
        case '/':
          out += e;
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          unsigned code = hex4();
          if (code >= 0xD800 && code < 0xDC00) {
            // A high surrogate counts only with a low one after it; the
            // escape after it is otherwise read as itself.
            const size_t saved = at_;
            unsigned low = 0;
            if (at_ + 1 < text_.size() && text_[at_] == '\\' && text_[at_ + 1] == 'u') {
              at_ += 2;
              low = hex4();
            }
            if (low >= 0xDC00 && low < 0xE000) {
              code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
            } else {
              at_ = saved;
              code = 0xFFFD;
            }
          } else if (code >= 0xDC00 && code < 0xE000) {
            // A lone low surrogate is no character: the replacement is.
            code = 0xFFFD;
          }
          appendUtf8(out, code);
          break;
        }
        default:
          fail("bad escape");
      }
    }
  }

  const std::string& text_;
  size_t at_ = 0;
};

}  // namespace

Value parse(const std::string& text) { return Parser(text).document(); }

void Writer::separate() {
  if (afterKey_) {
    afterKey_ = false;
    return;
  }
  if (!written_.empty()) {
    if (written_.back()) out_ += ',';
    written_.back() = true;
  }
}

Writer& Writer::beginObject() {
  separate();
  out_ += '{';
  written_.push_back(false);
  return *this;
}

Writer& Writer::endObject() {
  out_ += '}';
  written_.pop_back();
  return *this;
}

Writer& Writer::beginArray() {
  separate();
  out_ += '[';
  written_.push_back(false);
  return *this;
}

Writer& Writer::endArray() {
  out_ += ']';
  written_.pop_back();
  return *this;
}

Writer& Writer::key(const std::string& name) {
  string(name);
  out_ += ':';
  afterKey_ = true;
  return *this;
}

Writer& Writer::string(const std::string& value) {
  separate();
  out_ += '"';
  for (const char c : value) {
    switch (c) {
      case '"':
        out_ += "\\\"";
        break;
      case '\\':
        out_ += "\\\\";
        break;
      case '\n':
        out_ += "\\n";
        break;
      case '\r':
        out_ += "\\r";
        break;
      case '\t':
        out_ += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char escaped[8];
          std::snprintf(escaped, sizeof(escaped), "\\u%04x",
                        static_cast<unsigned>(static_cast<unsigned char>(c)));
          out_ += escaped;
        } else {
          out_ += c;
        }
    }
  }
  out_ += '"';
  return *this;
}

Writer& Writer::number(double value) {
  if (!std::isfinite(value)) return null();
  separate();
  // The shortest text that reads back as the same double, as JavaScript
  // prints numbers.
  char buffer[64];
  const auto result = std::to_chars(buffer, buffer + sizeof(buffer), value);
  out_.append(buffer, result.ptr);
  return *this;
}

Writer& Writer::integer(int64_t value) {
  separate();
  out_ += std::to_string(value);
  return *this;
}

Writer& Writer::boolean(bool value) {
  separate();
  out_ += value ? "true" : "false";
  return *this;
}

Writer& Writer::null() {
  separate();
  out_ += "null";
  return *this;
}

}  // namespace teamstation::scheduler::json
