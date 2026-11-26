# App Store Submission Checklist

This document tracks all requirements for submitting "Specimen Sandbox" to the App Store. Updated for v1.3.0 (daily AI-generated native flower, offline species search, and Premium Pass).

## App Store Metadata Requirements

- [x] **App Name**: "Specimen Sandbox"
- [x] **Bundle ID**: com.djscottyb.playinginthesandoxlookingatflowers
- [x] **Primary Category**: Entertainment
- [x] **Secondary Category**: Lifestyle (configured in `app-store-config.json` & `app.json`)
- [x] **Age Rating**: 4+ / Everyone
- [x] **App Description**: Updated in `app-store-config.json` for the daily-flower product, 100% offline botanical search, and Premium Pass
- [x] **Keywords**: Updated in `app-store-config.json` to "flowers,native,daily,wildflowers,bloom,nature,seasons,states"
- [x] **Support URL**: GitHub issues page
- [x] **Marketing URL**: GitHub repository URL (`app-store-config.json`)
- [x] **Privacy Policy URL**: https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/privacy.html (includes location, offline search, GitHub Pages CDN, and RevenueCat/Apple/Google IAP disclosures)

## Permissions

- [x] **NSLocationWhenInUseUsageDescription** added to `ios.infoPlist` ("Your region is used once to show flowers native to your area. It is never shared.")
- [x] **`expo-location` plugin** registered in `app.json` with matching `locationWhenInUsePermission` string
- [ ] **App Privacy questionnaire** in App Store Connect declares:
  - Coarse Location: local-only resolution to region code, not linked to user, not used for tracking, not transmitted off-device
  - Purchases: In-App Purchase history/receipt verification handled by Apple App Store / Google Play Billing and synced anonymously via RevenueCat (not linked to user identity, App Functionality only)
  - Search History / Queries: None collected (botanical search runs 100% offline via bundled SQLite FTS5/BM25 with zero queries sent off-device)

## Compliance Documentation

- [x] **Export Compliance**:
  - [x] App uses only exempt encryption (standard HTTPS)
  - [x] ITSAppUsesNonExemptEncryption set to false in `app.json`
  - [x] Documented in ENCRYPTION_NOTICE.md

- [x] **Digital Services Act (EU) Compliance**:
  - [x] Company/developer information provided
  - [x] Data processing information provided
  - [x] Documented in DSA_COMPLIANCE.md

- [ ] **AI-generated content & offline search disclosure**:
  - [ ] App Privacy notes include: daily flower images are generated server-side by `gemini-3.1-flash-image` / `gemini-3.1-flash-lite-image`; in-app species search runs 100% offline via SQLite FTS5/BM25 with zero client-side Gemini API keys or user input sent to Gemini

- [x] **Content Rights**: Original code + AI-generated imagery (developer-owned per Google AI Studio terms)

## Asset Requirements

- [ ] **App Icon**:
  - [x] 1024×1024 icon created
  - [ ] Verify icon meets Apple's guidelines
  - [ ] Verify icon displays properly on different backgrounds

- [ ] **Screenshots** (must be recaptured against new daily-flower UI — see SCREENSHOTS.md):
  - [ ] iPhone 6.5"+ (1290 × 2796 px) — 3-7 screenshots
  - [ ] iPad 12.9" (2048 × 2732 px) — 3-7 screenshots
  - [ ] All screenshots show today's flower, yesterday's flower, and a different region as the first 3

- [ ] **App Preview Video** (Optional): 15-30 sec demo of the daily ritual

## Technical Requirements

- [x] **Build Configuration**:
  - [x] Development profile configured
  - [x] Production profile configured
  - [x] Preview profile configured

- [ ] **Device Compatibility**:
  - [x] iOS 15.1+ compatibility
  - [ ] iPad layout verified
  - [ ] iPhone layout verified on hardware
  - [ ] Performance testing on older devices

- [x] **Code Signing**:
  - [x] Distribution certificate created
  - [x] Provisioning profiles configured

- [x] **Privacy Declarations**:
  - [x] Location-data usage documented in PRIVACY.md and `docs/privacy.html`

## Functional Testing

- [ ] **Core Functionality**:
  - [ ] First-launch location permission prompt fires
  - [ ] Permission granted → resolved state cached, today's flower fetches and renders
  - [ ] Permission denied → falls back to `default` bucket gracefully
  - [ ] Outside US → falls back to `default` bucket gracefully
  - [ ] ±6-day back-navigation works
  - [ ] Test under slow network
  - [ ] Test with no published flower for today (404 → friendly error UI)

- [ ] **User Experience**:
  - [ ] Dark/light mode transitions
  - [ ] Accessibility (VoiceOver) on flower card
  - [ ] Image alt-text from common name + latin name

- [ ] **Performance**:
  - [ ] App size optimization
  - [ ] Cold/warm startup times
  - [ ] Memory under low-memory conditions

## Backend Readiness

- [ ] **`GEMINI_API_KEY`** added to repo Secrets
- [ ] **GitHub Pages** enabled from `docs/` on `main`
- [ ] **First 7 days** of flowers pre-generated for all 112 regions (avoid 404 on launch day)
- [ ] **Cron job** verified: at least 3 successful daily runs
- [ ] **Pages CDN URL** verified: `https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/daily/{region}/{date}.{png,jpg,json}` resolves

## Build and Submission

- [ ] **Final Build**:
  - [ ] Production build created via EAS
  - [ ] All console logs and debug code removed
  - [ ] Build tested on physical device

- [ ] **App Store Connect**:
  - [ ] All required fields completed
  - [ ] Build uploaded
  - [ ] Screenshots uploaded (recaptured)
  - [ ] Privacy questionnaire completed (location disclosure)
  - [ ] Reviewer notes explaining one-shot location + cached-only behavior + AI-generated images
  - [ ] Release information filled out

## Post-Submission

- [ ] **TestFlight Testing**:
  - [ ] Internal testing group created
  - [ ] External testing group created (optional)

- [ ] **Launch Plan**:
  - [ ] Release date determined
  - [ ] Cron monitored for first week
  - [ ] Support response plan in place

## Notes

- Upgraded to Expo SDK 56 / React Native 0.85.3 / React 19.2
- Pivoted to daily AI-generated native flower product (v1.2.0 on 2026-04-25; v1.3.0 adds Premium Pass IAPs, 112 regions, and 100% offline SQLite FTS5/BM25 species search)
- The app's only network calls are: GitHub Pages static CDN image/JSON fetches and RevenueCat / Apple App Store / Google Play Billing IAP validation & restore (`expo-location` reverse-geocode resolves on-device and offline species search makes zero network calls)
- **Remaining blockers before submission**:
  1. Recapture screenshots against new daily-flower UI
  2. Pre-generate first 7 days of flowers in GH Pages
  3. Verify cron has run cleanly at least 3 times
  4. VoiceOver pass on `app/index.tsx` flower card
  5. Update App Store Connect metadata: keywords, secondary category, privacy questionnaire (location + anonymous purchases)
  6. Production EAS build + physical device test

---

Last Updated: November 26, 2026
