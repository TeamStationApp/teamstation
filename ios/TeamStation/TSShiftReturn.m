#import <UIKit/UIKit.h>
#import <objc/runtime.h>

/**
 * Shift+Return on a hardware keyboard starts a new line in Tess's composer
 * (`src/app/tess/Composer.tsx`), on an iPad among others, whose Return sends
 * (`submitBehavior: 'submit'`).
 *
 * React Native's multi-line field sends on any line break typed, and iOS
 * tells it nothing of Shift. So the field takes the Shift+Return press
 * itself, before the text system sees it, and puts the line break in as
 * React Native takes a pasted one: kept in the text, not sent, and told to
 * JavaScript as a change. A line break the field refuses (one past its
 * `maxLength`) leaves the paste flag as it was, so the next Return still
 * sends. Return alone, and the on-screen keyboard's return key, reach the
 * text system as before, and send.
 *
 * Chat also claims an unmodified hardware Up or Escape when its focused
 * field advertises that shortcut. All other fields retain ordinary behavior.
 * The press handlers are replaced on React Native's multi-line field
 * class (`RCTUITextView`), so every multi-line field in the app runs them,
 * but they act only for the corresponding composer native IDs. Every other
 * multi-line field passes each press, Shift+Return included, straight on to
 * UITextView, as it did without this file.
 */
extern BOOL TSChatSendKey(UITextView *field, NSString *key);

typedef void (*TSPressesIMP)(id, SEL, NSSet<UIPress *> *, UIPressesEvent *);

@interface TSShiftReturn : NSObject
+ (void)handleBegan:(NSSet<UIPress *> *)presses field:(UITextView *)field
              event:(UIPressesEvent *)event forward:(TSPressesIMP)forward;
@end

/** UITextView's own handling of each phase of a press, before ours. */
static TSPressesIMP TSInheritedBegan;
static TSPressesIMP TSInheritedChanged;
static TSPressesIMP TSInheritedEnded;
static TSPressesIMP TSInheritedCancelled;

/** The `nativeID` Tess's composer gives its field (`Composer.tsx`). */
static NSString *const TSComposerNativeID = @"tessComposerField";

/** The presses a field took, so their later phases are not passed on either. */
static const void *TSTakenKey = &TSTakenKey;
static const void *TSLookupAfterUpKey = &TSLookupAfterUpKey;

static BOOL TSIsShiftReturn(UIPress *press)
{
  UIKey *key = press.key;
  if (key == nil) {
    return NO;
  }
  UIKeyModifierFlags held = key.modifierFlags &
      (UIKeyModifierShift | UIKeyModifierControl | UIKeyModifierAlternate | UIKeyModifierCommand);
  return held == UIKeyModifierShift &&
      (key.keyCode == UIKeyboardHIDUsageKeyboardReturnOrEnter || key.keyCode == UIKeyboardHIDUsageKeypadEnter);
}

/**
 * Returns the React Native host view's nativeID so key handling can identify
 * a chat or Tess composer. The text field is a subview of that host.
 */
static NSString *TSComposerID(UITextView *field)
{
  UIView *host = field.superview;
  if (host == nil || ![host respondsToSelector:NSSelectorFromString(@"nativeId")]) {
    return nil;
  }
  id nativeId = [host valueForKey:@"nativeId"];
  return [nativeId isKindOfClass:[NSString class]] ? nativeId : nil;
}

static NSMutableSet<UIPress *> *TSTaken(UITextView *field)
{
  NSMutableSet<UIPress *> *taken = objc_getAssociatedObject(field, TSTakenKey);
  if (taken == nil) {
    taken = [NSMutableSet set];
    objc_setAssociatedObject(field, TSTakenKey, taken, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }
  return taken;
}

static void TSInsertNewline(UITextView *field)
{
  BOOL flagged = NO;
  @try {
    // The flag a paste sets, which React Native clears once the text has
    // changed: a pasted line break is kept rather than sent.
    [field setValue:@YES forKey:@"textWasPasted"];
    flagged = YES;
  } @catch (NSException *exception) {
    // A React Native without the flag: Shift+Return sends, as Return does.
  }
  NSString *before = [field.text copy];
  [field insertText:@"\n"];
  if (flagged && [field.text isEqualToString:before]) {
    // Refused (at its `maxLength`): no change clears the flag, which would
    // keep the next plain Return from sending.
    [field setValue:@NO forKey:@"textWasPasted"];
  }
}

@implementation TSShiftReturn

+ (void)handleBegan:(NSSet<UIPress *> *)presses field:(UITextView *)field
              event:(UIPressesEvent *)event forward:(TSPressesIMP)forward
{
  NSString *identifier = TSComposerID(field);
  BOOL tess = [identifier isEqualToString:TSComposerNativeID];
  BOOL up = [identifier isEqualToString:@"chatComposerEditLatest"];
  BOOL escape = [identifier isEqualToString:@"chatComposerCancelEdit"];
  if (!tess && !up && !escape) {
    forward(field, @selector(pressesBegan:withEvent:), presses, event);
    return;
  }
  NSMutableSet<UIPress *> *rest = [NSMutableSet set];
  for (UIPress *press in presses) {
    UIKey *key = press.key;
    UIKeyModifierFlags modifiers = UIKeyModifierShift | UIKeyModifierControl |
        UIKeyModifierAlternate | UIKeyModifierCommand;
    if (key != nil && objc_getAssociatedObject(field, TSLookupAfterUpKey) != nil &&
        ![TSTaken(field) containsObject:press]) {
      objc_setAssociatedObject(field, TSLookupAfterUpKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      if (up && field.isFirstResponder && field.text.length == 0) {
        BOOL plainEscape = key.keyCode == UIKeyboardHIDUsageKeyboardEscape && (key.modifierFlags & modifiers) == 0;
        TSChatSendKey(field, plainEscape ? @"Escape" : @"Unidentified");
      }
    }
    if (tess && TSIsShiftReturn(press)) {
      [TSTaken(field) addObject:press];
      TSInsertNewline(field);
    } else if (!tess && key != nil && field.isFirstResponder && field.editable &&
               field.markedTextRange == nil && (key.modifierFlags & modifiers) == 0 &&
               ((up && field.text.length == 0 && key.keyCode == UIKeyboardHIDUsageKeyboardUpArrow) ||
                (escape && key.keyCode == UIKeyboardHIDUsageKeyboardEscape)) &&
               ([TSTaken(field) containsObject:press] || TSChatSendKey(field, up ? @"ArrowUp" : @"Escape"))) {
      [TSTaken(field) addObject:press];
      if (up) objc_setAssociatedObject(field, TSLookupAfterUpKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    } else {
      [rest addObject:press];
    }
  }
  if (rest.count > 0) {
    forward(field, @selector(pressesBegan:withEvent:), rest, event);
  }
}

static void TSPressesBegan(UITextView *self, SEL _cmd, NSSet<UIPress *> *presses, UIPressesEvent *event)
{
  [TSShiftReturn handleBegan:presses field:self event:event forward:TSInheritedBegan];
}

/** A later phase: passed on but for the presses the field took. */
static void TSPassOn(TSPressesIMP inherited, UITextView *self, SEL _cmd, NSSet<UIPress *> *presses, UIPressesEvent *event)
{
  NSMutableSet<UIPress *> *taken = objc_getAssociatedObject(self, TSTakenKey);
  if (taken.count == 0) {
    // Nothing taken, as for every field but the composer: all passed on.
    inherited(self, _cmd, presses, event);
    return;
  }
  NSMutableSet<UIPress *> *rest = [presses mutableCopy];
  [rest minusSet:taken];
  if (rest.count > 0) {
    inherited(self, _cmd, rest, event);
  }
}

static void TSPressesChanged(UITextView *self, SEL _cmd, NSSet<UIPress *> *presses, UIPressesEvent *event)
{
  TSPassOn(TSInheritedChanged, self, _cmd, presses, event);
}

static void TSPressesEnded(UITextView *self, SEL _cmd, NSSet<UIPress *> *presses, UIPressesEvent *event)
{
  TSPassOn(TSInheritedEnded, self, _cmd, presses, event);
  [(NSMutableSet<UIPress *> *)objc_getAssociatedObject(self, TSTakenKey) minusSet:presses];
}

static void TSPressesCancelled(UITextView *self, SEL _cmd, NSSet<UIPress *> *presses, UIPressesEvent *event)
{
  TSPassOn(TSInheritedCancelled, self, _cmd, presses, event);
  [(NSMutableSet<UIPress *> *)objc_getAssociatedObject(self, TSTakenKey) minusSet:presses];
}

/** Puts `replacement` in place of the field's `selector`; answers what it had. */
static TSPressesIMP TSReplace(Class field, SEL selector, IMP replacement)
{
  Method inherited = class_getInstanceMethod(field, selector);
  TSPressesIMP previous = (TSPressesIMP)method_getImplementation(inherited);
  if (!class_addMethod(field, selector, replacement, method_getTypeEncoding(inherited))) {
    // The field has its own: ours calls it.
    method_setImplementation(inherited, replacement);
  }
  return previous;
}

+ (void)load
{
  Class field = NSClassFromString(@"RCTUITextView");
  if (field == nil) {
    return;
  }
  TSInheritedBegan = TSReplace(field, @selector(pressesBegan:withEvent:), (IMP)TSPressesBegan);
  TSInheritedChanged = TSReplace(field, @selector(pressesChanged:withEvent:), (IMP)TSPressesChanged);
  TSInheritedEnded = TSReplace(field, @selector(pressesEnded:withEvent:), (IMP)TSPressesEnded);
  TSInheritedCancelled = TSReplace(field, @selector(pressesCancelled:withEvent:), (IMP)TSPressesCancelled);
}

@end
