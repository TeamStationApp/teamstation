#import <React/RCTViewManager.h>
#import <React/RCTComponent.h>
#import <React/UIView+React.h>
#import <UIKit/UIKit.h>

/** UIKit owns the floating image, lighting and Reduce Motion behavior. */
@interface TVPosterView : UIImageView
@property(nonatomic, copy) NSString *uri;
@property(nonatomic, strong) NSURLSessionDataTask *task;
- (void)updateMotion;
@end
@implementation TVPosterView
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.contentMode = UIViewContentModeScaleAspectFill;
    self.clipsToBounds = NO;
    self.layer.cornerRadius = 12;
    self.backgroundColor = [UIColor colorWithWhite:0.18 alpha:1];
    [self updateMotion];
    [[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(updateMotion) name:UIAccessibilityReduceMotionStatusDidChangeNotification object:nil];
  }
  return self;
}
- (void)updateMotion { self.adjustsImageWhenAncestorFocused = !UIAccessibilityIsReduceMotionEnabled(); }
- (void)setUri:(NSString *)uri {
  if ([_uri isEqualToString:uri]) return;
  _uri = [uri copy];
  [self.task cancel];
  self.image = nil;
  NSURL *url = [NSURL URLWithString:uri ?: @""];
  if (!url || ![@[@"https", @"http"] containsObject:url.scheme.lowercaseString]) return;
  __weak TVPosterView *weakSelf = self;
  self.task = [NSURLSession.sharedSession dataTaskWithURL:url completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    UIImage *image = data && !error ? [UIImage imageWithData:data] : nil;
    dispatch_async(dispatch_get_main_queue(), ^{
      TVPosterView *view = weakSelf;
      if ([view.uri isEqualToString:uri]) view.image = image;
    });
  }];
  [self.task resume];
}
- (void)dealloc { [self.task cancel]; [[NSNotificationCenter defaultCenter] removeObserver:self]; }
@end
@interface TVPosterManager : RCTViewManager @end
@implementation TVPosterManager
RCT_EXPORT_MODULE(TVPoster)
- (UIView *)view { return [TVPosterView new]; }
RCT_EXPORT_VIEW_PROPERTY(uri, NSString)
@end

@interface TVSearchCell : UICollectionViewCell
@property(nonatomic, strong) TVPosterView *icon;
@property(nonatomic, strong) UILabel *titleLabel;
@property(nonatomic, strong) UILabel *detailLabel;
- (void)configure:(NSDictionary *)item;
- (void)applyFocus:(BOOL)focused;
@end
@implementation TVSearchCell
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.contentView.backgroundColor = [UIColor colorWithWhite:0.7 alpha:0.2];
    self.contentView.layer.cornerRadius = 22;
    self.isAccessibilityElement = YES; self.accessibilityTraits = UIAccessibilityTraitButton;
    self.icon = [TVPosterView new]; self.icon.contentMode = UIViewContentModeScaleAspectFit;
    self.icon.adjustsImageWhenAncestorFocused = NO;
    self.titleLabel = [UILabel new]; self.titleLabel.font = [UIFont systemFontOfSize:30 weight:UIFontWeightSemibold];
    self.titleLabel.numberOfLines = 2; self.titleLabel.textColor = UIColor.whiteColor;
    self.detailLabel = [UILabel new]; self.detailLabel.font = [UIFont systemFontOfSize:24];
    self.detailLabel.numberOfLines = 2; self.detailLabel.textColor = [UIColor colorWithWhite:0.9 alpha:1];
    for (UIView *view in @[self.icon, self.titleLabel, self.detailLabel]) [self.contentView addSubview:view];
  }
  return self;
}
- (void)layoutSubviews {
  [super layoutSubviews]; CGFloat width = self.bounds.size.width;
  self.icon.frame = CGRectMake(20, 24, 80, self.bounds.size.height - 48);
  self.titleLabel.frame = CGRectMake(120, 20, MAX(0,width-140), 76);
  self.detailLabel.frame = CGRectMake(120, 98, MAX(0,width-140), 62);
}
- (void)configure:(NSDictionary *)item {
  self.titleLabel.text = item[@"title"]; self.detailLabel.text = item[@"detail"];
  self.icon.uri = [item[@"image"] isKindOfClass:NSString.class] ? item[@"image"] : nil;
  if (self.icon.uri.length == 0) { self.icon.image = [UIImage systemImageNamed:[item[@"id"] hasPrefix:@"player:"] ? @"person.crop.square" : @"sportscourt"]; self.icon.tintColor = UIColor.whiteColor; }
  self.accessibilityLabel = [@[self.titleLabel.text ?: @"", self.detailLabel.text ?: @""] componentsJoinedByString:@", "];
  self.accessibilityIdentifier = item[@"id"];
}
- (void)didUpdateFocusInContext:(UIFocusUpdateContext *)context withAnimationCoordinator:(UIFocusAnimationCoordinator *)coordinator {
  [super didUpdateFocusInContext:context withAnimationCoordinator:coordinator];
  [coordinator addCoordinatedAnimations:^{ [self applyFocus:self.focused]; } completion:nil];
}
- (void)applyFocus:(BOOL)focused {
  self.transform = focused && !UIAccessibilityIsReduceMotionEnabled() ? CGAffineTransformMakeScale(1.035, 1.035) : CGAffineTransformIdentity;
  self.contentView.backgroundColor = [UIColor colorWithWhite:focused ? 0.85 : 0.7 alpha:focused ? 0.45 : 0.2];
  self.contentView.layer.borderColor = UIColor.whiteColor.CGColor;
  self.contentView.layer.borderWidth = focused ? 3 : 0;
}
@end

@interface TVSearchResults : UICollectionViewController <UICollectionViewDelegateFlowLayout>
@property(nonatomic, copy) NSArray<NSDictionary *> *items;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) void (^selection)(NSString *);
@property(nonatomic, strong) UILabel *message;
@end
@implementation TVSearchResults
- (instancetype)init {
  UICollectionViewFlowLayout *layout = [UICollectionViewFlowLayout new];
  layout.minimumInteritemSpacing = 24; layout.minimumLineSpacing = 24;
  layout.sectionInset = UIEdgeInsetsMake(30, 70, 40, 70);
  if ((self = [super initWithCollectionViewLayout:layout])) _items = @[];
  return self;
}
- (void)viewDidLoad {
  [super viewDidLoad]; self.collectionView.backgroundColor = UIColor.clearColor;
  self.collectionView.accessibilityIdentifier = @"tv-search-results";
  [self.collectionView registerClass:TVSearchCell.class forCellWithReuseIdentifier:@"result"];
  self.message = [UILabel new]; self.message.textColor = UIColor.whiteColor;
  self.message.font = [UIFont systemFontOfSize:30]; self.message.textAlignment = NSTextAlignmentCenter;
  self.message.numberOfLines = 0; self.collectionView.backgroundView = self.message;
  self.message.text = self.status;
}
- (void)setItems:(NSArray<NSDictionary *> *)items { _items = [items copy] ?: @[]; [self.collectionView reloadData]; }
- (void)setStatus:(NSString *)status { _status = [status copy]; self.message.text = status; }
- (NSInteger)collectionView:(UICollectionView *)collectionView numberOfItemsInSection:(NSInteger)section { return self.items.count; }
- (UICollectionViewCell *)collectionView:(UICollectionView *)collectionView cellForItemAtIndexPath:(NSIndexPath *)indexPath {
  TVSearchCell *cell = [collectionView dequeueReusableCellWithReuseIdentifier:@"result" forIndexPath:indexPath];
  [cell configure:self.items[indexPath.item]]; return cell;
}
- (CGSize)collectionView:(UICollectionView *)collectionView layout:(UICollectionViewLayout *)layout sizeForItemAtIndexPath:(NSIndexPath *)indexPath {
  return CGSizeMake(MAX(1,(collectionView.bounds.size.width-140-48)/3), 182);
}
- (void)collectionView:(UICollectionView *)collectionView didSelectItemAtIndexPath:(NSIndexPath *)indexPath {
  if (indexPath.item < self.items.count && self.selection) self.selection(self.items[indexPath.item][@"id"]);
}
@end

@interface TVSearchContainer : UISearchContainerViewController
@property(nonatomic, copy) void (^closeSearch)(void);
@end
@implementation TVSearchContainer
- (void)viewDidDisappear:(BOOL)animated {
  [super viewDidDisappear:animated];
  if ((self.isBeingDismissed || self.presentingViewController == nil) && self.closeSearch) self.closeSearch();
}
- (void)pressesEnded:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  for (UIPress *press in presses) if (press.type == UIPressTypeMenu) { if (self.closeSearch) self.closeSearch(); return; }
  [super pressesEnded:presses withEvent:event];
}
@end
@interface TVSearchView : UIView <UISearchResultsUpdating, UISearchControllerDelegate, UIAdaptivePresentationControllerDelegate>
@property(nonatomic, copy) NSArray *items;
@property(nonatomic, copy) NSString *status;
@property(nonatomic, copy) RCTDirectEventBlock onQuery;
@property(nonatomic, copy) RCTDirectEventBlock onSelect;
@property(nonatomic, copy) RCTDirectEventBlock onDismiss;
@property(nonatomic, strong) TVSearchResults *results;
@property(nonatomic, strong) UISearchController *search;
@property(nonatomic, strong) TVSearchContainer *container;
@property(nonatomic) BOOL closing;
- (void)closeSearch;
@end
@implementation TVSearchView
- (instancetype)initWithFrame:(CGRect)frame {
  if ((self = [super initWithFrame:frame])) {
    self.results = [TVSearchResults new];
    self.search = [[UISearchController alloc] initWithSearchResultsController:self.results];
    self.search.searchResultsUpdater = self;
    self.search.delegate = self;
    self.search.searchBar.placeholder = @"Search teams or players";
    self.search.searchBar.accessibilityIdentifier = @"tv-native-search-field";
    self.search.obscuresBackgroundDuringPresentation = NO;
    self.container = [[TVSearchContainer alloc] initWithSearchController:self.search];
    self.container.modalPresentationStyle = UIModalPresentationOverFullScreen;
    self.container.view.backgroundColor = [UIColor colorWithWhite:0.22 alpha:1];
    __weak TVSearchView *weakSelf = self;
    self.container.closeSearch = ^{ [weakSelf closeSearch]; };
    self.results.selection = ^(NSString *identifier) {
      if (weakSelf.onSelect) weakSelf.onSelect(@{@"id":identifier});
      if (![identifier isEqualToString:@"retry"]) [weakSelf closeSearch];
    };
  }
  return self;
}
- (void)presentSearch {
  if (!self.window || self.container.presentingViewController) return;
  UIViewController *parent = self.reactViewController ?: self.window.rootViewController;
  if (parent && !parent.presentedViewController) {
    self.closing = NO;
    [parent presentViewController:self.container animated:NO completion:^{ self.search.active = YES; [self.search.searchBar becomeFirstResponder]; }];
    self.container.presentationController.delegate = self;
  }
}
- (void)didMoveToWindow {
  [super didMoveToWindow];
  if (self.window) {
    __weak TVSearchView *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf presentSearch]; });
  } else {
    [self.container.presentingViewController dismissViewControllerAnimated:NO completion:nil];
  }
}
- (void)setItems:(NSArray *)items { _items = [items copy]; self.results.items = items; }
- (void)setStatus:(NSString *)status { _status = [status copy]; self.results.status = status; }
- (void)updateSearchResultsForSearchController:(UISearchController *)searchController {
  if (self.onQuery) self.onQuery(@{@"query": searchController.searchBar.text ?: @""});
}
- (void)closeSearch {
  if (self.closing) return;
  self.closing = YES;
  [self.search.searchBar resignFirstResponder];
  [self.container.presentingViewController dismissViewControllerAnimated:NO completion:nil];
  if (self.onDismiss) self.onDismiss(@{});
}
// UIKit can consume Menu before the container sees it. Always notify React.
- (void)didDismissSearchController:(UISearchController *)searchController { [self closeSearch]; }
- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController { [self closeSearch]; }
@end
@interface TVSearchManager : RCTViewManager @end
@implementation TVSearchManager
RCT_EXPORT_MODULE(TVSearch)
- (UIView *)view { return [TVSearchView new]; }
RCT_EXPORT_VIEW_PROPERTY(items, NSArray)
RCT_EXPORT_VIEW_PROPERTY(status, NSString)
RCT_EXPORT_VIEW_PROPERTY(onQuery, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onSelect, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onDismiss, RCTDirectEventBlock)
@end

/** A layer-backed scrim stays aligned while the containing panel animates. */
@interface TVGradientView : UIView
@property(nonatomic, copy) NSString *direction;
@end
@implementation TVGradientView
+ (Class)layerClass { return CAGradientLayer.class; }
- (void)setDirection:(NSString *)direction {
  _direction = [direction copy];
  CAGradientLayer *gradient = (CAGradientLayer *)self.layer;
  BOOL bottom = [direction isEqualToString:@"bottom"];
  gradient.colors = @[(id)[UIColor colorWithWhite:0 alpha:bottom ? 0.65 : 0.98].CGColor,
                      (id)[UIColor colorWithWhite:0 alpha:bottom ? 0.325 : 0.9].CGColor,
                      (id)[UIColor colorWithWhite:0 alpha:0].CGColor];
  gradient.locations = @[@0, bottom ? @0.5 : @0.8, @1];
  gradient.startPoint = bottom ? CGPointMake(0,1) : CGPointMake([direction isEqualToString:@"right"] ? 1 : 0,0);
  gradient.endPoint = bottom ? CGPointMake(0,0) : CGPointMake([direction isEqualToString:@"left"] ? 1 : 0,0);
}
@end
@interface TVGradientManager : RCTViewManager @end
@implementation TVGradientManager
RCT_EXPORT_MODULE(TVGradient)
- (UIView *)view { return [TVGradientView new]; }
RCT_EXPORT_VIEW_PROPERTY(direction, NSString)
@end
