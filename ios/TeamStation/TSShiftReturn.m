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
 * Scope: the press handlers are replaced on React Native's multi-line field
 * class (`RCTUITextView`), so every multi-line field in the app runs them,
 * but they act only for the field whose host view carries the composer's
 * `nativeID` (`FIELD_NATIVE_ID`, "tessComposerField"). Every other
 * multi-line field passes each press, Shift+Return included, straight on to
 * UITextView, as it did without this file.
 */
@interface TSShiftReturn : NSObject
@end

typedef void (*TSPressesIMP)(id, SEL, NSSet<UIPress *> *, UIPressesEvent *);

/** UITextView's own handling of each phase of a press, before ours. */
static TSPressesIMP TSInheritedBegan;
static TSPressesIMP TSInheritedChanged;
static TSPressesIMP TSInheritedEnded;
static TSPressesIMP TSInheritedCancelled;

/** The `nativeID` Tess's composer gives its field (`Composer.tsx`). */
static NSString *const TSComposerNativeID = @"tessComposerField";

/** The presses a field took, so their later phases are not passed on either. */
static const void *TSTakenKey = &TSTakenKey;

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
 * Whether `field` is Tess's composer: React Native puts its `nativeID` on
 * the field's host view (`RCTTextInputComponentView`), whose subview it is.
 */
static BOOL TSIsComposer(UITextView *field)
{
  UIView *host = field.superview;
  if (host == nil || ![host respondsToSelector:NSSelectorFromString(@"nativeId")]) {
    return NO;
  }
  id nativeId = [host valueForKey:@"nativeId"];
  return [nativeId isKindOfClass:[NSString class]] && [nativeId isEqualToString:TSComposerNativeID];
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

static void TSPressesBegan(UITextView *self, SEL _cmd, NSSet<UIPress *> *presses, UIPressesEvent *event)
{
  if (!TSIsComposer(self)) {
    // Any other multi-line field: every press goes on as it came.
    TSInheritedBegan(self, _cmd, presses, event);
    return;
  }
  NSMutableSet<UIPress *> *rest = [NSMutableSet set];
  for (UIPress *press in presses) {
    if (TSIsShiftReturn(press)) {
      [TSTaken(self) addObject:press];
      TSInsertNewline(self);
    } else {
      [rest addObject:press];
    }
  }
  if (rest.count > 0) {
    TSInheritedBegan(self, _cmd, rest, event);
  }
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

@implementation TSShiftReturn

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
