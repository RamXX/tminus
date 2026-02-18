# iOS Release Readiness -- TestFlight Candidate

This document defines the checklist and procedures for releasing the T-Minus iOS app
to TestFlight and eventually the App Store.

## Table of Contents

1. [Build Environment Prerequisites](#build-environment-prerequisites)
2. [Code Signing and Provisioning](#code-signing-and-provisioning)
3. [Versioning](#versioning)
4. [Entitlements](#entitlements)
5. [Privacy Strings (Info.plist)](#privacy-strings-infoplist)
6. [Push Notifications](#push-notifications)
7. [Widgets](#widgets)
8. [Apple Watch Extension](#apple-watch-extension)
9. [Crash Reporting](#crash-reporting)
10. [Core Flow Validation Checklist](#core-flow-validation-checklist)
11. [CI Pipeline Targets](#ci-pipeline-targets)
12. [TestFlight Submission Procedure](#testflight-submission-procedure)
13. [Known Blockers](#known-blockers)

---

## Build Environment Prerequisites

> **Xcode 16.0+ is required.** The project file (`project.pbxproj`) uses
> `objectVersion = 77`, which is an Xcode 16-only format. Xcode 15 and earlier
> **cannot open this project** and will produce parse errors. This also means the
> build host must run macOS 14.0+ (Sonoma) or later, since Xcode 16 does not
> support earlier macOS versions.

| Requirement | Minimum | Current |
|-------------|---------|---------|
| Xcode | 16.0+ | 16.2 (Swift 6.2.3) |
| Swift | 6.1+ | 6.2.3 |
| iOS Deployment Target | 17.0 | 17.0 |
| macOS (build host) | 14.0+ | 26.0 (Tahoe) |

Verify with:
```bash
xcode-select -p        # Should be /Applications/Xcode.app/Contents/Developer
swift --version         # Swift 6.1+
xcodebuild -version     # Xcode 16+
```

## Code Signing and Provisioning

### Local Development

The Xcode project uses **automatic code signing** (`CODE_SIGN_STYLE = Automatic`).

To build and run on a physical device or submit to TestFlight:

1. Open `ios/TMinus/TMinus.xcodeproj` in Xcode.
2. Select the **TMinus** target -> **Signing & Capabilities** tab.
3. Set **Team** to your Apple Developer account team.
4. Xcode will auto-generate a development provisioning profile.

| Setting | Value |
|---------|-------|
| `CODE_SIGN_STYLE` | Automatic |
| `DEVELOPMENT_TEAM` | _(must be set -- currently empty)_ |
| `PRODUCT_BUNDLE_IDENTIFIER` | `com.tminus.ios` |

### CI Environment

For CI (headless builds), two approaches:

**Option A -- Automatic signing (recommended for GitHub Actions with macOS runner):**
```bash
xcodebuild archive \
  -scheme TMinus \
  -destination 'generic/platform=iOS' \
  -archivePath ./build/TMinus.xcarchive \
  DEVELOPMENT_TEAM="YOUR_TEAM_ID"
```
Requires: Apple ID with developer program enrollment added to the CI keychain.

**Option B -- Manual signing:**
```bash
xcodebuild archive \
  -scheme TMinus \
  -destination 'generic/platform=iOS' \
  -archivePath ./build/TMinus.xcarchive \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Distribution: Your Name (TEAM_ID)" \
  PROVISIONING_PROFILE_SPECIFIER="TMinus AppStore"
```
Requires: Distribution certificate (.p12) and provisioning profile installed in CI keychain.

**Option C -- No signing (CI validation only, current default):**
```bash
make ios-archive   # Uses CODE_SIGNING_ALLOWED=NO
```
Produces a valid .xcarchive for structural verification but NOT uploadable to TestFlight.

## Versioning

| Key | Location | Current |
|-----|----------|---------|
| `MARKETING_VERSION` (CFBundleShortVersionString) | project.pbxproj | `0.1.0` |
| `CURRENT_PROJECT_VERSION` (CFBundleVersion) | project.pbxproj | `1` |

**Rules for TestFlight:**
- `MARKETING_VERSION` follows semver: `MAJOR.MINOR.PATCH` (e.g., `1.0.0`)
- `CURRENT_PROJECT_VERSION` must increment on every TestFlight upload (e.g., `1`, `2`, `3`, ...)
- App Store Connect rejects duplicate `(MARKETING_VERSION, CURRENT_PROJECT_VERSION)` pairs.

**Bump versions via xcodebuild:**
```bash
# Bump build number for TestFlight upload
cd ios/TMinus && xcodebuild -scheme TMinus \
  -showBuildSettings 2>/dev/null | grep -E "(MARKETING|CURRENT_PROJECT)"

# Override at build time (preferred for CI)
xcodebuild archive -scheme TMinus \
  MARKETING_VERSION=1.0.0 \
  CURRENT_PROJECT_VERSION=42 \
  ...
```

## Entitlements

The following entitlements are required for full functionality.
Add them in Xcode under **Signing & Capabilities**.

| Entitlement | Purpose | Status |
|-------------|---------|--------|
| App Groups (`group.com.tminus.ios`) | Shared UserDefaults between app and widget | Code references it; entitlement file NOT YET created |
| Push Notifications (APNs) | Event reminders and sync triggers | Code implemented; entitlement NOT YET added |
| Background Modes: Remote Notifications | Silent push for background sync | Required for push; NOT YET added |
| Keychain Sharing (optional) | Shared tokens across extensions | Uses KeychainService; may need entitlement for extensions |

**To add entitlements:**
1. Open project in Xcode.
2. Select TMinus target -> Signing & Capabilities -> + Capability.
3. Add each listed capability.
4. Xcode generates `TMinus.entitlements` file automatically.

## Privacy Strings (Info.plist)

iOS 17+ requires privacy descriptions for all sensitive API usage. The following
keys must be present in Info.plist (or the Xcode-generated Info.plist via build settings):

| Key | Required For | Status |
|-----|-------------|--------|
| `NSCalendarsUsageDescription` | EventKit (if using on-device calendars) | Not currently used -- API-only model |
| `NSUserTrackingUsageDescription` | App Tracking Transparency | Not needed (no tracking) |
| `NSFaceIDUsageDescription` | Biometric auth for login | Not currently used |

**Currently auto-generated keys (via INFOPLIST_KEY_ build settings):**
- `UIApplicationSceneManifest_Generation = YES`
- `UIApplicationSupportsIndirectInputEvents = YES`
- `UILaunchScreen_Generation = YES`
- `UISupportedInterfaceOrientations_iPad` and `_iPhone` (portrait + landscape)

**No additional privacy strings needed at this time** since the app uses API-based
calendar data (no on-device EventKit) and push permissions are requested at runtime.

## Push Notifications

### Current Implementation
- `PushNotificationService` registers for remote notifications via APNs.
- Device token is hex-encoded and sent to `POST /v1/device-tokens`.
- Retry with exponential backoff (3 attempts).
- Foreground notifications show banner/badge/sound.
- Tap handling routes via `NotificationRouter` protocol -> `DeepLink`.

### TestFlight Requirements
- [ ] APNs key (.p8) or certificate uploaded to Apple Developer portal.
- [ ] Push Notifications entitlement added to Xcode project.
- [ ] Backend push worker configured with APNs key ID and team ID.
- [ ] Test: send test push to TestFlight build, verify banner and deep link.

### APNs Environment
- Development builds (debug): `gateway.sandbox.push.apple.com`
- TestFlight/App Store: `gateway.push.apple.com`

The backend must detect the APNs environment from the device token or use
separate endpoints for sandbox vs production.

## Widgets

### Current Implementation
- `WidgetDataProvider` reads/writes via App Group UserDefaults (`group.com.tminus.ios`).
- `WidgetTimelineLogic` generates timeline entries for small/medium/large widget sizes.
- `TMinusWidgetViews` renders the widget UI with event countdown, titles, times.
- Deep links from widget taps open the main app via `tminus://event/{id}` URL scheme.

### TestFlight Requirements
- [ ] Widget extension target added to Xcode project (currently library code only).
- [ ] App Group entitlement added to BOTH main app and widget extension.
- [ ] Widget configuration intent defined (if supporting user-configurable widgets).
- [ ] `Info.plist` for widget extension includes `NSExtension` dictionary.
- [ ] Test: widget appears in widget gallery, displays events, taps open app.

### Known Gap
Widget and watch extension source files exist as library code within `TMinusLib` but are
**not yet registered as separate Xcode extension targets**. This is the primary blocker
for widget functionality on device (see [Known Blockers](#known-blockers)).

## Apple Watch Extension

### Current Implementation
- `WatchConnectivityService` defines sync payload/state types for WCSession.
- `WatchComplicationLogic` generates complication timeline entries.
- `WatchComplicationViews` renders complications (circular, rectangular, inline).
- `WatchTodayView` displays today's events on the watch.
- Platform-guarded: `#if canImport(WatchConnectivity)`.

### TestFlight Requirements
- [ ] watchOS app target added to Xcode project.
- [ ] WatchConnectivity framework linked.
- [ ] Watch app includes complication configuration.
- [ ] App Group entitlement shared between iPhone app and watch extension.
- [ ] Test: events sync from iPhone to watch, complications update.

### Known Gap
Watch extension source files exist as library code only -- **no watchOS target in
the Xcode project yet** (see [Known Blockers](#known-blockers)).

## Crash Reporting

### Recommended Setup (Pre-TestFlight)
- [ ] Enable dSYM upload to a crash reporting service (Crashlytics, Sentry, or Datadog).
- [ ] Archive builds generate dSYMs at `TMinus.xcarchive/dSYMs/`.
- [ ] TestFlight crash logs are available in App Store Connect -> TestFlight -> Crashes.

### Current State
No crash reporting SDK is integrated. For TestFlight beta, Apple's built-in crash
reporting in App Store Connect provides basic crash logs. For production, integrate
a dedicated service.

## Core Flow Validation Checklist

Execute these checks on simulator (or device) before every TestFlight submission.

### Authentication Flow
- [ ] Cold launch shows login screen when not authenticated.
- [ ] Login with valid credentials succeeds and navigates to calendar view.
- [ ] Login with invalid credentials shows error message.
- [ ] Logout clears keychain tokens and returns to login screen.
- [ ] Token refresh on 401 is transparent to the user.

### Calendar View
- [ ] Today's events load and display after login.
- [ ] Events show title, time, account color indicator.
- [ ] All-day events display correctly.
- [ ] Pull-to-refresh triggers API fetch.
- [ ] Empty state displays when no events exist.

### Create/Edit Event
- [ ] Create event form opens from calendar view.
- [ ] Required fields (title, start, end) are validated.
- [ ] Event creation via API succeeds and event appears in calendar.
- [ ] Scheduling flow (propose times -> commit candidate) works end-to-end.

### Offline Queue
- [ ] Event creation while offline enqueues the operation.
- [ ] Queue drains automatically when connectivity returns.
- [ ] Failed operations retry up to 3 times with exponential backoff.
- [ ] Pending operations are visible/recoverable after app restart (UserDefaults persistence).

### Push Notification Handling
- [ ] Push permission dialog appears on first launch.
- [ ] Foreground notification shows banner.
- [ ] Notification tap navigates to the relevant event.
- [ ] Device token is registered with the backend.

### Deep Links
- [ ] `tminus://event/{id}` opens the event detail view.
- [ ] `tminus://today` opens the today/calendar view.
- [ ] Widget taps deep-link into the app correctly.

## CI Pipeline Targets

### Available Makefile Targets

| Target | What It Does | Code Signing |
|--------|-------------|--------------|
| `make ios-build` | SPM library build (macOS host) | None needed |
| `make ios-test` | SPM unit tests (335 tests, macOS host) | None needed |
| `make ios-build-xcode` | xcodebuild clean build (iOS Simulator) | None needed |
| `make ios-test-xcode` | xcodebuild test with coverage (iOS Simulator) | None needed |
| `make ios-archive` | xcodebuild archive (generic/iOS, no signing) | `CODE_SIGNING_ALLOWED=NO` |
| `make ios-ci` | Full pipeline: test + build + archive | None needed |
| `make ios-clean` | Clean SPM build artifacts | -- |
| `make ios-clean-xcode` | Clean Xcode derived data + build/ | -- |

### Overriding Simulator Device
```bash
make ios-build-xcode IOS_SIM="iPhone 16e"
make ios-test-xcode IOS_SIM="iPad Pro 13-inch (M5)"
```

### CI Evidence Collection
```bash
# Full CI run with timestamped evidence
make ios-ci 2>&1 | tee ios-ci-$(date +%Y%m%d-%H%M%S).log
```

## TestFlight Submission Procedure

### Prerequisites
1. Apple Developer Program membership (paid, $99/year).
2. App registered in App Store Connect with bundle ID `com.tminus.ios`.
3. DEVELOPMENT_TEAM set in Xcode project or passed via build setting.
4. At least one iOS Distribution certificate in the team's keychain.

### Steps

1. **Bump version numbers:**
   ```bash
   # In Xcode: TMinus target -> General -> Version and Build
   # Or via CLI:
   xcodebuild archive -scheme TMinus \
     MARKETING_VERSION=0.1.0 \
     CURRENT_PROJECT_VERSION=<next_build_number> \
     -destination 'generic/platform=iOS' \
     -archivePath ./build/TMinus.xcarchive
   ```

2. **Create signed archive:**
   ```bash
   cd ios/TMinus && xcodebuild archive \
     -scheme TMinus \
     -destination 'generic/platform=iOS' \
     -archivePath ./build/TMinus.xcarchive \
     DEVELOPMENT_TEAM="YOUR_TEAM_ID"
   ```

3. **Export for App Store / TestFlight:**
   ```bash
   xcodebuild -exportArchive \
     -archivePath ./build/TMinus.xcarchive \
     -exportOptionsPlist ExportOptions.plist \
     -exportPath ./build/export
   ```
   Where `ExportOptions.plist` contains:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
     "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>method</key>
     <string>app-store-connect</string>
     <key>teamID</key>
     <string>YOUR_TEAM_ID</string>
     <key>destination</key>
     <string>upload</string>
   </dict>
   </plist>
   ```

4. **Upload to App Store Connect:**
   ```bash
   xcrun altool --upload-app \
     -f ./build/export/TMinus.ipa \
     -u "your@apple-id.com" \
     -p "@keychain:AC_PASSWORD"
   ```
   Or use **Transporter.app** for a GUI upload.

5. **In App Store Connect:**
   - Navigate to TestFlight -> TMinus -> new build.
   - Add internal/external testers.
   - For external testing, submit for beta review (usually < 24 hours).

## Known Blockers

| # | Blocker | Severity | Owner | Impact |
|---|---------|----------|-------|--------|
| 1 | `DEVELOPMENT_TEAM` is empty in project.pbxproj | **P0 for TestFlight** | Project owner | Cannot create signed archive or upload to TestFlight. Set to Apple Developer team ID. |
| 2 | Widget extension target missing from Xcode project | **P1** | iOS developer | Widget code exists as library but cannot run on device. Need to create WidgetExtension target in Xcode, link TMinusLib, add App Group entitlement. |
| 3 | watchOS app target missing from Xcode project | **P1** | iOS developer | Watch code exists as library but cannot run on device. Need to create watchOS app target with WatchKit dependency. |
| 4 | Entitlements file not created | **P1** | iOS developer | App Groups, Push Notifications, and Background Modes entitlements need to be added via Xcode Signing & Capabilities. |
| 5 | No crash reporting SDK | **P2** | iOS developer | TestFlight has built-in crash reporting via App Store Connect. Dedicated SDK (Crashlytics/Sentry) recommended for production. |
| 6 | No ExportOptions.plist for CI upload | **P2** | DevOps | Needed for automated TestFlight uploads from CI. |

### Blocker Resolution Order
1. Set DEVELOPMENT_TEAM (unblocks all signing).
2. Add entitlements (unblocks push, app groups).
3. Create widget extension target (unblocks widget on device).
4. Create watchOS app target (unblocks watch on device).
5. Integrate crash reporting (recommended for production).
6. Create ExportOptions.plist (unblocks CI upload).
