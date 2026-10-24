# Compliance Fixes TODO

Action items to bring the project into full compliance with `agents.md`:

## 1. Remove `fetch()` Chapter Navigation and Restore Native Page Loads (Criteria 3 & 4)
- [x] Remove `navigateToChapter`, `applyFetchedChapterDocument`, `syncFetchedHead`, `setupFetchedChapterEnhancements`, and `isSameFictionChapterUrl` (`rr-foldable-ui.user.js:2171-2395`).
- [x] Remove link-click interception in `handleDocumentClickCapture` (`rr-foldable-ui.user.js:2405-2435`) and `popstate` `navigateToChapter` handling (`rr-foldable-ui.user.js:2588-2597`) so chapter transitions use normal browser navigation and allow Royal Road's telemetry, analytics, author metrics, and ad scripts to run normally.
- [x] Ensure the script makes zero network connections (`fetch`, `XMLHttpRequest`, etc.) so "Does the script connect to any URLs?" is strictly "no".

## 2. Stop Intercepting Royal Road's Native Fullscreen / Chapter Click Handlers (Criterion 3)
- [x] Remove custom double-tap fullscreen toggling and capture-phase click swallowing in `handleDocumentClickCapture` (`rr-foldable-ui.user.js:2437-2524`) that blocks Royal Road's native `.chapter-content` click listener.
- [x] Restore passive tracking of Royal Road's native fullscreen state across normal page loads (re-requesting fullscreen on the first user gesture of the next chapter when `sessionStorage` indicates fullscreen was active).

## 3. Scope Selectors Strictly to Royal Road's New Design (Criterion 2)
- [x] `findNextChapterWidget` (`rr-foldable-ui.user.js:305-342`): Remove legacy alert selectors (`.alert-info`, `[class*='alert-info']`) and legacy comments.
- [x] `addStyles` (`rr-foldable-ui.user.js:600-604`): Remove legacy Bootstrap/Metronic header/navbar selectors (`#header`, `.navbar`, `.navbar-fixed-top`) if only used by the old layout.
- [x] `findCommentSection` (`rr-foldable-ui.user.js:1441-1466`): Remove legacy `.portlet` / `.panel` selectors and scope to the new design's comment container.
- [x] `getFixedHeaderHeight` (`rr-foldable-ui.user.js:1777-1792`): Remove legacy Metronic header classes (`.page-header-top`, `.page-header-menu`, `.page-header`, `.navbar-fixed-top`) and keep only the new design's header selector.

## 4. Align Documentation and Metadata with Greasy Fork Rules (Criterion 5)
- [x] Update `@description` in `rr-foldable-ui.user.js` (or adjust script behavior) so all user-visible features—including collapsing shout-out author notes—are accurately disclosed.
- [x] Update `README.md` to match current script behavior:
  - Document desktop landscape support and the `Normal view`, `Comments`, and `Reader view` buttons.
  - Ensure shout-out author note detection in `containsOtherRoyalRoadFictionLink` (`rr-foldable-ui.user.js:226-245`) and its description in `README.md` match (either require an image in code as stated in `README.md` or update `README.md`).
