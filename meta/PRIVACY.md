# Privacy Policy for Specimen Sandbox

**Last Updated:** November 26, 2026

## Introduction

This Privacy Policy explains how Specimen Sandbox ("we", "our", or "us") handles information when you use our mobile application ("App"). We respect your privacy and are committed to protecting it through our compliance with this policy.

## Location Data

The App requests your device's approximate location **once** — the first time you open it — solely to determine your US state, Canadian province, or supported country/region (across 112 supported regional buckets). This is used to select flowers native to your region. The resolved region code (e.g. `CA`, `CA-ON`, or `MX-MEX`) is stored on your device via `AsyncStorage` and is **never** transmitted to us or any third party. The underlying coordinates are discarded immediately after the region is resolved. You can reset this cache at any time by using the in-app "Update location" control, reinstalling the App, or clearing its local storage.

If you decline the location prompt, or if your location is outside a specific regional bucket, the App falls back to the `default` flower bucket and continues to function normally. Travel Mode also lets users browse other supported regions locally on-device without transmitting location data.

## Data Collection and Usage

Beyond the one-time local region resolution described above, **we do not collect personal information, analytics, or advertising identifiers through our App.** This includes, but is not limited to:

- Personal identifiers (name, email address, phone number)
- Precise or persistent location data
- Financial or credit card information (handled exclusively by Apple App Store / Google Play Billing)
- Health information
- Browsing history
- User content
- Biometric data
- Usage tracking or behavioral analytics
- Advertising device IDs

### 100% Offline Species Search & Local Device Storage

- **Offline Botanical Search**: In-app species search executes **100% offline on-device** using SQLite FTS5/BM25 full-text and tokenized keyword matching against the bundled read-only species database (`expo-sqlite`), with an in-memory fallback on Web. Search queries never leave your device and are never sent to Google Gemini or any external server.
- **Local Storage**: `AsyncStorage` stores only non-personal local state: your resolved/Travel Mode region code, cached daily flower metadata/image reference, and daily free search quota state.

The App fetches pre-generated daily flower images and sidecar JSON from a static GitHub Pages CDN. These are standard HTTPS requests that include no personal or account identifiers.

## Children's Privacy (COPPA Compliance)

Our App does not collect personal information from anyone, including children under the age of 13. We are compliant with the Children's Online Privacy Protection Act (COPPA) and the App is suitable for general audiences.

## European Union Users (GDPR Compliance)

Specimen Sandbox does not maintain user accounts or collect personal profiles on remote servers. Coarse region resolution and species searches happen locally on-device, and optional In-App Purchases are processed by Apple App Store or Google Play Billing and synced anonymously via RevenueCat using an anonymous app user ID solely for entitlement verification.

## Third-Party Services & In-App Purchases

The App does not use analytics SDKs, advertising networks, or client-side AI/Gemini API calls. External network communication is strictly limited to:

- **GitHub Pages (Static CDN)**: Serves pre-generated daily botanical imagery and sidecar metadata over HTTPS without user identifiers.
- **RevenueCat, Apple App Store & Google Play Billing**: Optional Premium Pass subscriptions and lifetime unlocks are processed directly by Apple App Store or Google Play Billing and verified anonymously through RevenueCat using an anonymous app user ID and store purchase receipt/token. Specimen Sandbox never collects or stores credit card numbers, billing addresses, or payment credentials.

## Changes to Our Privacy Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last Updated" date.

## Contact Information

If you have any questions or concerns about this Privacy Policy, please contact us via:

- GitHub Issues: [https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers/issues](https://github.com/TheScottyB/playing-in-the-sandbox-staring-at-flowers/issues)

## California Privacy Rights

Under California law, California residents have specific rights regarding their personal information. Specimen Sandbox does not sell personal information or maintain personal user profiles.

## International Data Transfers

Specimen Sandbox does not transfer personal profiles or location coordinates off-device. Static CDN fetches go to GitHub Pages, and optional store purchase receipts are verified by Apple App Store, Google Play Billing, and RevenueCat strictly for entitlement status.

## Data Security

We implement appropriate technical measures to protect the security and integrity of our App. All external communications use standard HTTPS and are strictly limited to daily static content retrieval and anonymous store entitlement verification.

## Data Retention

Specimen Sandbox retains no personal profiles on developer servers. Local region, daily cache, and search quota state remain only on your device until cleared or uninstalled.

## Your Consent

By using our App, you consent to our Privacy Policy. Since we do not collect any personal information, your continued use of the App does not raise any privacy concerns.

## Governing Law

This Privacy Policy is governed by and construed in accordance with the laws of the United States, without giving effect to any principles of conflicts of law.

