#import <UIKit/UIKit.h>
#import <react/renderer/components/view/TouchEventEmitter.h>

using namespace facebook::react;

// RCTTextInputComponentView inherits the Fabric host's touch emitter accessor.
@protocol TSChatTextInputHost
- (SharedTouchEventEmitter)touchEventEmitterAtPoint:(CGPoint)point;
@end

extern "C" BOOL TSChatSendKey(UITextView *field, NSString *key)
{
  UIView *host = field.superview;
  if (![host isKindOfClass:NSClassFromString(@"RCTTextInputComponentView")]) return NO;
  auto emitter = [(id<TSChatTextInputHost>)host touchEventEmitterAtPoint:CGPointZero];
  if (!emitter) return NO;
  // UIKit text replacements also emit keyPress, including literal words such as "Escape".
  emitter->dispatchEvent("keyPress", folly::dynamic::object("key", key.UTF8String)("chatHardwareKey", true));
  return YES;
}
