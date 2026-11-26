# App Store Submission Reference for Specimen Sandbox

## Critical App Information
| Field | Value |
|-------|-------|
| App Name | Specimen Sandbox |
| Bundle ID | com.djscottyb.playinginthesandoxlookingatflowers |
| SKU | EX1744334003092 |
| Apple ID | 6744488642 |
| Version | 1.3.0 |
| Build Number | 35 (or next EAS auto-incremented build) |

## Required URLs
| URL Type | Value |
|----------|-------|
| Privacy Policy URL | https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/privacy.html |
| Support URL | https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers/issues |
| Marketing URL (Optional) | https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers |
| User Privacy Choices URL (Optional) | - |

## App Store Metadata
| Field | Value |
|-------|-------|
| Primary Category | Entertainment |
| Secondary Category | Lifestyle |
| Age Rating | 4+ |
| Content Rights | Original content + AI-generated imagery (`gemini-3.1-flash-image` / `gemini-3.1-flash-lite-image`, server-side only) |
| Features | Daily AI-generated native flower images, region-aware (112 regions: US states, CA provinces, MX, CN, RU, BR, IS, plus regional buckets and `default`), one-shot location, offline backup caching, pre-compiled 396-species SQLite database with 100% offline FTS5/BM25 + tokenized botanical search, 7-day archive, Travel Mode, light/dark theme |

## App Review Information
| Field | Value |
|-------|-------|
| Contact Email | Configured via `APP_REVIEW_CONTACT_EMAIL` env / App Store Connect UI (not stored in git) |
| Contact Phone | Configured via `APP_REVIEW_CONTACT_PHONE` env / App Store Connect UI (not stored in git) |
| Demo Account | Not required |
| Notes | Changes since the last review: Guideline 3.0 (Business) — the price of the Founders Lifetime VIP non-consumable (`com.djscottyb.playinginthesandoxlookingatflowers.premium_founders`) has been reduced from $599.99 to $99.99. The new price is approximately 3.3x the $29.99 Premium Annual Pass, in line with typical lifetime-tier pricing, and reflects the value of permanent access to the premium feature set (unlimited offline botanical searches, 7-day archive, and Travel Mode) versus the recurring plans ($4.99/month, $29.99/year). --- Location & Privacy note: the app requests location permission once on first launch to resolve the user's US state, Canadian province, or supported region via on-device reverse-geocoding. The region code is cached locally and never transmitted off-device. Daily flower images are pre-generated server-side via a GitHub Actions cron and served from GitHub Pages — no user data is sent with these requests. Species search runs 100% offline on-device using a bundled SQLite FTS5/BM25 database (zero queries sent off-device). Optional In-App Purchases are handled by Apple App Store / Google Play Billing and synced anonymously via RevenueCat. |

## In-App Purchases (v1.3.0)
Optional Premium Pass unlocks unlimited offline botanical searches, the full 7-day history archive, and regional Travel Mode (processed via Apple App Store / Google Play Billing and synced anonymously via RevenueCat):
- **Premium Monthly Pass** (`$4.99/month`, auto-renewable; ASC product `com.djscottyb.playinginthesandoxlookingatflowers.premium_monthly`, RevenueCat package `$rc_monthly`)
- **Premium Annual Pass** (`$29.99/year`, auto-renewable; ASC product `com.djscottyb.playinginthesandoxlookingatflowers.premium_annual` — overridable via `ASC_ANNUAL_PRODUCT_ID`, RevenueCat package `$rc_yearly`)
- **Founders Edition (Lifetime VIP)** (`$99.99` one-time non-consumable; ASC product `com.djscottyb.playinginthesandoxlookingatflowers.premium_founders`, RevenueCat package `$rc_lifetime`)

## App Store Screenshots Requirements
| Device | Size | Minimum Required | Key Features to Showcase |
|--------|------|------------------|--------------------------|
| iPhone 6.5"+ | 1290 × 2796 pixels | 3-5 screenshots | Today's flower, yesterday's flower, different region, dark mode |
| iPad 12.9" | 2048 × 2732 pixels | 3-5 screenshots | Same flow, tablet layout |

**Important**: See [SCREENSHOTS.md](SCREENSHOTS.md) for capture guidelines. The previous screenshots show the deprecated tab UI and **must be recaptured** against the daily-flower screen before submission.

## App Store Legal Questionnaire Responses

### Age Rating Questionnaire
All categories: None

### Export Compliance
- Encryption: Standard HTTPS for network calls only
- ITSAppUsesNonExemptEncryption: false (configured in `app.json`)

### Content Rights
- Third-party Content: No
- Licensed Content: No
- AI-Generated Content: Yes — flower images generated daily server-side via Google Gemini 3.1 Flash Image (`gemini-3.1-flash-image` / `gemini-3.1-flash-lite-image`). Images are owned by the developer per Google's AI Studio terms. No search queries or user inputs are sent to Gemini.

### Data Collection
- Analytics: None
- Advertising: None
- User Data Collection: None transmitted off-device for search or location; optional IAP receipts/entitlements are processed directly by Apple App Store / Google Play Billing and synced anonymously via RevenueCat
- Location: Requested once, resolved locally to region code, cached on-device only

### Digital Services Act (EU Compliance)
- Developer Identity: Verified
- Content Type: Entertainment / Lifestyle
- Target Audience: All ages
- No commercial communication

## Submission Checklist
- [x] App icon uploaded (1024×1024 px)
- [ ] Screenshots recaptured for new daily-flower UI (iPhone + iPad)
- [ ] App Preview video showing the daily ritual (optional)
- [ ] Description finalized describing the daily-flower product
- [ ] Keywords updated: "flowers,native,daily,wildflowers,bloom,nature,seasons,states"
- [x] Privacy policy URL updated with location-data disclosure
- [x] Support URL valid
- [ ] Age rating questionnaire submitted
- [x] Pricing: Free (with optional Premium Pass IAPs)
- [ ] App Review notes explaining one-shot location + cached-only behavior + offline search + IAP pricing
- [ ] Manual release set
- [ ] Build selected
- [ ] First 7 days of daily flowers pre-generated before submission

## Additional Notes
- Privacy policy hosted at `docs/privacy.html` via GitHub Pages
- No user data transmitted off-device for search or location; external calls are limited to static GitHub Pages CDN fetches and RevenueCat/store IAP entitlement verification
- No login or account creation
- Hardware testing required to exercise the location prompt
- Daily images are generated via GitHub Actions cron at 04:00 PT and served from GitHub Pages
- See `BUILD_CONFIG.md` for build details
