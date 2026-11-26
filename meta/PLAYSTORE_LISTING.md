# Play Store Listing Copy & Questionnaire Answers

> Drop-in answers and copy for the Google Play Console submission flow.
> Field names below match the Play Console UI as of 2026-04. Keep this in
> sync with `meta/SUBMISSION.md` (App Store equivalent).

---

## Store Listing → App details

### App name
Length limit: 30 characters

```
Specimen Sandbox
```
(16 chars)

### Short description
Length limit: 80 characters

```
A new native flower every morning, picked for your region and the season.
```
(73 chars)

### Full description
Length limit: 4000 characters

```
Wake up to a fresh AI-generated picture of a flower blooming near you today.

Every morning, Specimen Sandbox picks a native species for your region and
the current month, then delivers a new image with a botanical blurb. One tap
takes you to yesterday's flower, or explore the 7-day archive, offline species
search, and Travel Mode across 112 supported regions.

A daily ritual, not a habit loop.

WHAT YOU GET EACH DAY
• A photorealistic image of a wildflower, garden flower, or shrub bloom
  native to your region, generated fresh every day
• Common name and Latin name
• A one-sentence note on the flower's appearance or ecological role
• 100% offline botanical search across 396 native species (SQLite FTS5/BM25)
• Optional Premium Pass ($4.99/mo, $29.99/yr, or $99.99 Founders Lifetime VIP)
  unlocking unlimited offline search, the full 7-day archive, and Travel Mode

HOW IT WORKS
• On first launch, the app asks for your location once and resolves it locally
  to a region code (e.g. CA, CA-ON, MX-MEX). That code is stored only on your
  device.
• Each day, our server-side generator picks an in-season native species for
  supported regions and creates a new image using Google Gemini.
• The app fetches today's image for your region from a static GitHub Pages CDN.
  No account, no profile, no server-side history of you.
• If you deny location, you'll see a flower from the curated default bucket.

PRIVACY FIRST
• Location is requested ONCE on first launch and resolved on-device to a
  region code. Your coordinates never leave your phone.
• Offline botanical search runs 100% on-device via SQLite — search queries
  never leave your phone.
• No analytics. No ad SDKs. No third-party trackers.
• Optional In-App Purchases are handled directly by Google Play Billing and
  synced anonymously via RevenueCat.
```

### App icon
Length: 512×512 PNG, 32-bit (with alpha)

Source: `assets/images/icon.png` (1024×1024) — must be exported to 512×512
for Play Console. ImageMagick:

```bash
magick assets/images/icon.png -resize 512x512 play_store_assets/icon-512.png
```

### Feature graphic
Length: 1024×500 PNG or JPG, no alpha

Required for store discovery. **Not yet created.** Suggested composition:
- Background: brand green (`#4CAF50`)
- Center-left: small icon mark
- Right two-thirds: a single illustrated flower silhouette in white or pale
- Bottom-left: tagline "A flower a day, native to you" (white, small)

Tools: Figma, Canva, or `magick -size 1024x500 ...` for a quick solid-color
placeholder.

### Phone screenshots
Length: 2–8 screenshots, PNG/JPG, 16:9 or 9:16, 320–3840 px on long edge.
Recommend 1080×2400 (modern phone aspect ratio).

Reuse the iPhone screenshots from `screenshots/iphone_pro_max/` if those
have been recaptured against the daily-flower UI; otherwise capture fresh
on Android emulator with `adb shell screencap`.

Required content (matches App Store priority order):
1. Today's flower (full-bleed)
2. Yesterday's flower (shows back-nav)
3. Different region (shows personalization)
4. Loading / first-launch state
5. Dark mode
6. Error / "Coming soon to your area" friendly state

### Tablet screenshots (7-inch & 10-inch)
Optional but improves search ranking on tablets. Same content as phone, on
the appropriate canvas. If skipping, mark "phone only" in Distribution.

---

## Store Listing → Categorization

| Field | Value |
|---|---|
| Application type | App |
| Category | Lifestyle |
| Tags | Lifestyle / Nature & outdoors |
| Email | Configured privately in Play Console; public support via https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers/issues |
| Phone (optional) | leave blank |
| Website (optional) | https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers |
| Privacy policy URL | https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/privacy.html |

---

## App content → Privacy policy

URL (already configured in `app.json`):
```
https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/privacy.html
```

---

## App content → App access

> "Is all functionality of your app available without any access restrictions?"

**Answer: Yes (for core free daily flower & limited offline search); optional Premium Pass IAP unlocks unlimited offline search, 7-day archive, and Travel Mode**

No login or account required. No region-gating beyond the `default` fallback when location permission is denied or outside a named bucket.

---

## App content → Ads

> "Does your app contain ads?"

**Answer: No**

The app makes outbound HTTPS calls only to GitHub Pages (daily sidecar JSON + image) and RevenueCat / Google Play Billing for optional In-App Purchases. No ad SDKs or trackers.

---

## App content → Content rating (IARC questionnaire)

Walk through the questionnaire with these answers:

| Section | Question | Answer |
|---|---|---|
| Category | Tools, Productivity, Communication, or Other | **Other** |
| Violence | Does the app contain violence of any kind? | **No** |
| Sexuality | Sexual content, nudity, partial nudity, suggestive themes? | **No** |
| Language | Profanity, crude humor? | **No** |
| Controlled substances | References to drugs, alcohol, tobacco? | **No** |
| Gambling | Real or simulated gambling? | **No** |
| User-generated content | Does the app feature user-generated content, content sharing, social interaction, location sharing, personal info sharing, IAP, or unrestricted internet access? | **Yes** for **IAP** (optional Premium Pass via Google Play Billing); **No** to the other five |
| Miscellaneous | Anything else parents/users should know? | **No** |

**Expected rating:** Everyone (IARC Generic 3+).

> Note: location access is asked here but should be answered **No** — the
> app does not *share* location, it resolves it locally to a state code.
> Google's question is specifically "lets users share their physical
> location with other users."

---

## App content → Target audience and content

| Field | Answer |
|---|---|
| Target age group | **13+** (covers all use cases without triggering Designed for Families review) |
| Does your store listing target children? | **No** |
| Could children unintentionally view your app? | No (the listing is general-audience, not kid-targeted) |
| Are children likely to be using your app? | No |

If asked about ad disclosure for kids: **N/A — no ads.**

---

## App content → News app

**Answer: No, my app is not a news app.**

---

## App content → COVID-19 contact tracing and status

**Answer: My app is not a publicly available COVID-19 contact tracing or status app.**

---

## App content → Data safety

This is the most scrutinized section. The full answer set:

### Data collection and security

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** (HTTPS only — fetch to GitHub Pages CDN) |
| Do you provide a way for users to request that their data be deleted? | **Yes** (in-app "Update location" + uninstalling clears all local data) |

### Data types — what we collect

Only **two** data types are touched (coarse location stays strictly on-device; optional IAP tokens are verified anonymously via Google Play Billing and RevenueCat):

| Data type | Collected? | Shared? | Optional? | Purpose | Why |
|---|---|---|---|---|---|
| **Approximate location** | Yes | **No** | Yes (denying falls back to default) | App functionality, Personalization | Resolves once on first launch via `expo-location` `Accuracy.Lowest`, reverse-geocodes on-device to a region code (112 supported regions), caches the code locally. Coordinates never leave the device. |
| **Purchase history** | Yes (via Google Play Billing & RevenueCat) | **No** (processed for entitlement sync only) | Yes (only if user purchases Premium Pass) | App functionality | Anonymous app user ID and Google Play purchase token verified via RevenueCat solely to unlock/restore Premium Pass entitlements. |

> Important: Mark "approximate" not "precise". The app uses
> `Accuracy.Lowest` which on iOS 14+ skips the precise-location prompt
> entirely and on Android requests `ACCESS_COARSE_LOCATION` only.

### Data types — what we DON'T collect

Tick **none** for every other category in the questionnaire:
- Personal info (name, email, phone, address, IDs, racial/ethnic, political, religious, sexual orientation)
- Financial info
- Health & fitness
- Messages
- Photos & videos
- Audio files
- Files & docs
- Calendar
- Contacts
- App activity
- Web browsing
- App info & performance (no crash logs, no analytics)
- Device & other IDs

### Tracking

> Does your app share user data with third parties for tracking?

**Answer: No.**

No analytics or ad SDKs. Outbound HTTPS calls are strictly limited to fetching publicly cached daily flower assets from GitHub Pages CDN and verifying optional Google Play Billing entitlements anonymously via RevenueCat (not classified as tracking under Google's rules).

### Security practices declaration

| Practice | Answer |
|---|---|
| Data is encrypted in transit | **Yes** |
| Users can request data deletion | **Yes** (uninstall clears, in-app reset clears region) |
| App follows Play Store Families Policy (if targeting children) | N/A — 13+ |
| App has been independently security-validated | No |

---

## App content → Government apps

**Answer: My app is not a government app.**

---

## App content → Financial features

**Answer: My app does not provide any financial features.**

---

## App content → Health

**Answer: My app does not provide health features.**

---

## Pricing & distribution → Countries / regions

Supports **112 regions** (US states, Canadian provinces, MX, CN, RU, BR, IS, European/African/Latin American regional buckets, plus `default` fallback), so distribution can be enabled for supported countries/regions or worldwide with graceful `default` fallback.

---

## Pricing & distribution → Pricing

**Free** (with optional In-App Purchases: Premium Monthly `$4.99`, Premium Annual `$29.99`, Founders Lifetime VIP `$99.99`).

---

## Pricing & distribution → Device categories

| Category | Distribute? |
|---|---|
| Phone | **Yes** |
| Tablet | **Yes** (single-screen layout adapts; nothing tablet-specific) |
| Wear OS | No |
| Android TV | No |
| Chromebook | Yes (no harm; the app runs as a tablet-class device) |
| Android Auto | No |

---

## Releases → Production → Release

After EAS Build produces a `.aab`:

```bash
# Submit to internal testing first (use eas.json submit profile)
eas submit --platform android --profile production --latest

# Or upload manually:
# Play Console → Production → Create new release → Upload [aab]
```

Recommended ladder:
1. Internal testing (you + 2 testers, 1 week)
2. Closed testing (10–20 testers, 1 week)
3. Open testing (no audience, 1 week — gives Google's automated reviews
   time to check installs across device classes)
4. Production rollout: start at 5% staged rollout, ramp to 100% over 3 days

---

## What the maintainer still has to do

- [ ] **Backfill the daily flowers** (all 112 regions including US states, CA provinces, international buckets, and `default`)
  — Actions → Generate Daily Flowers → Run workflow with `missing_only: true`.
  Defaults to today's date and all configured regions.
- [ ] **Capture Android screenshots** against the new daily-flower UI
  (see `meta/SCREENSHOTS.md` § Android — `adb shell screencap` on an
  emulator running the dev build)
- [ ] **Create the 1024×500 feature graphic** (no current asset)
- [ ] **Resize the app icon to 512×512** for Play Console upload
- [ ] **Set up Google Play Console app entry** ($25 one-time dev fee if
  not already paid)
- [ ] **Generate `google-service-account.json`** for `eas submit`:
  Cloud Console → IAM → Service Accounts → create → grant
  "Service Account User" + "Android Publisher" roles → Keys → Add Key →
  JSON → store as `google-service-account.json` (gitignored) and as a
  GitHub Secret for the EAS Workflow
- [ ] Walk through Play Console wizards, pasting the answers above
