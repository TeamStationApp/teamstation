#import <React/RCTTextInputComponentView.h>
#import <React/RCTUITextView.h>
#import <XCTest/XCTest.h>
#import <react/renderer/components/textinput/TextInputEventEmitter.h>

using namespace facebook::react;

@interface ChatTestKey : UIKey
@property(nonatomic) UIKeyboardHIDUsage testCode;
@property(nonatomic) UIKeyModifierFlags testFlags;
@end
@implementation ChatTestKey
- (UIKeyboardHIDUsage)keyCode { return self.testCode; }
- (UIKeyModifierFlags)modifierFlags { return self.testFlags; }
@end

@interface ChatTestPress : UIPress
@property(nonatomic,strong) ChatTestKey *testKey;
@end
@implementation ChatTestPress
- (UIKey *)key { return self.testKey; }
@end

@interface ChatTestField : RCTUITextView
@property(nonatomic) BOOL focusedForTest;
@property(nonatomic,strong) UITextRange *compositionForTest;
@end
@implementation ChatTestField
- (BOOL)isFirstResponder { return self.focusedForTest; }
- (UITextRange *)markedTextRange { return self.compositionForTest; }
@end

@interface ChatTestHost : RCTTextInputComponentView
@property(nonatomic,copy) NSString *identifierForTest;
@property(nonatomic) NSUInteger emissions;
@property(nonatomic) BOOL emitterReady;
@end
@implementation ChatTestHost
- (NSString *)nativeId { return self.identifierForTest; }
- (SharedTouchEventEmitter)touchEventEmitterAtPoint:(CGPoint)point {
  self.emissions++;
  if (!self.emitterReady) return nullptr;
  return std::make_shared<TextInputEventEmitter>(nullptr, EventDispatcher::Weak{});
}
@end

@interface ChatHardwareKeysTests : XCTestCase
@end
@implementation ChatHardwareKeysTests
- (ChatTestPress *)key:(UIKeyboardHIDUsage)code flags:(UIKeyModifierFlags)flags {
  ChatTestPress *press = [ChatTestPress new];
  press.testKey = [ChatTestKey new];
  press.testKey.testCode = code;
  press.testKey.testFlags = flags;
  return press;
}

- (void)testFocusedChatClaimsOnlyItsAdvertisedShortcut {
  ChatTestHost *host = [ChatTestHost new];
  ChatTestField *field = [[ChatTestField alloc] initWithFrame:CGRectZero];
  [host addSubview:field];
  field.focusedForTest = YES;
  host.emitterReady = YES;
  host.identifierForTest = @"chatComposerEditLatest";
  ChatTestPress *up = [self key:UIKeyboardHIDUsageKeyboardUpArrow flags:0];
  NSSet *press = [NSSet setWithObject:up];
  [field pressesBegan:press withEvent:nil];
  [field pressesChanged:press withEvent:nil];
  [field pressesBegan:press withEvent:nil];
  XCTAssertEqual(host.emissions, 1u);
  [field pressesEnded:press withEvent:nil];
  field.attributedText = [[NSAttributedString alloc] initWithString:@" "];
  [field pressesBegan:press withEvent:nil];
  field.attributedText = [[NSAttributedString alloc] initWithString:@""];
  up.testKey.testFlags = UIKeyModifierShift;
  [field pressesBegan:press withEvent:nil];
  up.testKey.testFlags = 0;
  field.focusedForTest = NO;
  [field pressesBegan:press withEvent:nil];
  field.focusedForTest = YES;
  field.editable = NO;
  [field pressesBegan:press withEvent:nil];
  field.editable = YES;
  field.compositionForTest = [field textRangeFromPosition:field.beginningOfDocument toPosition:field.endOfDocument];
  [field pressesBegan:press withEvent:nil];
  field.compositionForTest = nil;
  host.identifierForTest = @"chatComposerCancelEdit";
  [field pressesBegan:press withEvent:nil];
  XCTAssertEqual(host.emissions, 1u);
  up.testKey.testCode = UIKeyboardHIDUsageKeyboardEscape;
  [field pressesBegan:press withEvent:nil];
  [field pressesCancelled:press withEvent:nil];
  XCTAssertEqual(host.emissions, 2u);
  host.emitterReady = NO;
  [field pressesBegan:press withEvent:nil];
  XCTAssertEqual(host.emissions, 3u);
  host.identifierForTest = @"otherField";
  [field pressesBegan:press withEvent:nil];
  [field pressesChanged:press withEvent:nil];
  [field pressesEnded:press withEvent:nil];
  XCTAssertEqual(host.emissions, 3u);
}

- (void)testDetachedFieldKeepsItsTextWhenTheHostHasGoneAway {
  ChatTestField *field = [[ChatTestField alloc] initWithFrame:CGRectZero];
  field.focusedForTest = YES;
  field.attributedText = [[NSAttributedString alloc] initWithString:@"Practice"];
  NSSet *press = [NSSet setWithObject:[self key:UIKeyboardHIDUsageKeyboardEscape flags:0]];
  [field pressesBegan:press withEvent:nil];
  [field pressesEnded:press withEvent:nil];
  XCTAssertEqualObjects(field.attributedText.string, @"Practice");
}

- (void)testTessShiftReturnStillInsertsOneNewline {
  ChatTestHost *host = [ChatTestHost new];
  host.identifierForTest = @"tessComposerField";
  ChatTestField *field = [[ChatTestField alloc] initWithFrame:CGRectZero];
  [host addSubview:field];
  field.focusedForTest = YES;
  NSSet *shiftReturn = [NSSet setWithObject:[self key:UIKeyboardHIDUsageKeyboardReturnOrEnter flags:UIKeyModifierShift]];
  [field pressesBegan:shiftReturn withEvent:nil];
  [field pressesEnded:shiftReturn withEvent:nil];
  XCTAssertEqualObjects(field.attributedText.string, @"\n");
  NSSet *plainReturn = [NSSet setWithObject:[self key:UIKeyboardHIDUsageKeyboardReturnOrEnter flags:0]];
  [field pressesBegan:plainReturn withEvent:nil];
  XCTAssertEqual(host.emissions, 0u);
}
@end
