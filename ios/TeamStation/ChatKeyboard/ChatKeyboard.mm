#import <UIKit/UIKit.h>
#import <react/renderer/components/textinput/TextInputEventEmitter.h>

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
  static_cast<const TextInputEventEmitter &>(*emitter).onKeyPress({
      .text = key.UTF8String,
      .eventCount = 0
  });
  return YES;
}
