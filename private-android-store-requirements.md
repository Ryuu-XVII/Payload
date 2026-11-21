# Payload

## Goal

Build Payload, a private native Android store for my own apps. I should be able to publish a signed APK from my computer or CI, open Payload on my phone, see which apps have updates, and install them through Android's system installer. The first version is for one owner, with one release channel and one standalone APK per release.

## Design brief for the building agent

**Use the Impeccable design skill to shape the UI before implementation.** Treat the library and install flow as **Operate** surfaces. Prioritize a clear next action, easy scanning, and familiar Android behavior. Use real app icons, clear typography, a restrained accent color, and spacing that makes the list easy to scan. Keep the layout usable one-handed, support system font scaling and TalkBack, and use motion sparingly for feedback. Before shipping, review the rendered screens and their loading, error, and install states at phone size. [Official Impeccable skill](https://github.com/pbakaus/impeccable/blob/main/plugin/skills/impeccable/SKILL.md)

- **Library.** Show apps with available updates first, then the rest of the catalog. Label the primary action **Install**, **Update**, or **Open** based on device state. Provide pull-to-refresh.
- **App details.** Show the icon, name, installed and latest versions where applicable, download size, and release notes. Keep the primary action easy to reach. If the latest release requires a newer Android version, offer the newest compatible APK still within retention or show the minimum Android version required.
- **Install flow.** Show download progress and a clear retry action. Explain the one-time Android **Allow from this source** setting in context. Show specific feedback for cancellation, a signing mismatch, an incompatible APK, or a failed download. Refresh the app's status when the user returns from Android's installer.

## Implementation scope

| Component | Requirement |
| --- | --- |
| Android client | Expo and React Native with TypeScript. Use a local Kotlin Expo module for package lookup and `PackageInstaller`. Test with an Expo development build and ship a signed release APK via EAS Build. |
| APK storage | Use a private Cloudflare R2 **Standard** bucket. Upload directly from a desktop command or CI using the S3-compatible API. Each release gets its own immutable object key. |
| Catalog and downloads | Use one Cloudflare Worker with D1 for app and release metadata. Authenticate requests and issue short-lived R2 download URLs on demand. |
| Owner access | For the first version, enter an owner access token once and store it with Expo SecureStore. Use separate, server-side publishing credentials for the desktop command or CI. Keep R2 credentials and APK signing keys outside the mobile app. |

Keep v1 to Android, standalone release APKs, and user-initiated installs. Offer opt-in notifications for compatible updates to installed catalog apps. Defer an admin dashboard, public accounts, split APKs and XAPK, and automatic background installs.

## Publish and install

1. Publish with a desktop command that can also run in CI. Extract the package ID, version name, version code, and minimum Android version from the APK. Verify its signature against the expected certificate and record its SHA-256 and size. An update must have a higher version code. Back up the signing keys used for the apps and the store.
2. Upload the APK before making it visible. Update the catalog and set the previous release's expiry together in one database transaction. A retry of the same release must be safe and must preserve any expiry already set. Reject attempts to replace a published version with different bytes.
3. On the phone, compare Android's installed package ID and version code with the catalog. The private store uses Android package visibility for catalog IDs published after the store APK was built.
4. Download to app-private storage and check the file's SHA-256 before offering installation. Submit only a verified local APK to Android's installer after an explicit install action. Show Android session progress and refresh the package lookup after the installer reports a result. Clear incomplete downloads and keep one verified APK per app so failed or cancelled installs can be retried from disk. For an app already installed, the APK must use the same package ID and a compatible signing certificate to update it in place and preserve its data.

## APK retention policy

- **Keep the current APK indefinitely.** The 30-day clock for an older APK starts when its replacement is successfully published to the catalog. Store that deadline in UTC. A subsequent update starts a clock for the APK it replaces and leaves earlier deadlines intact.
- **Stop serving the old APK exactly 30 days after it was replaced.** Any signed link issued for it must expire by that deadline. A Cloudflare Cron Trigger runs every 15 minutes to physically delete expired APKs from R2, so deletion occurs on the next successful run after expiry. Retry failed deletions on later runs and record the result. Historical release notes may remain in D1.
- Base cleanup on the recorded replacement deadline. An R2 lifecycle rule based on upload age could delete an APK that is still current.

## Acceptance checks

- On a real phone, install a fresh app from the store, then publish a higher version, update in place, and confirm the app's data is still there. Also test an app that was installed before the store.
- Test the unknown-source permission flow, installer cancellation, a mismatched signing key, and a failed download followed by a retry.
- Verify a realistic APK larger than 50 MB can upload and install. Verify a caller without valid access cannot fetch catalog data or obtain download links.
- Test retention with three successive releases. Confirm expiry is based on when each release was replaced, downloads stop at the deadline, the next successful cleanup removes the old object, and the current APK remains downloadable. Simulate a failed cleanup and confirm the next run retries it.

## Platform references

- [Expo native modules](https://docs.expo.dev/modules/get-started/) · [EAS APK builds](https://docs.expo.dev/build-reference/apk/)
- [Android update rules](https://developer.android.com/google/play/app-updates) · [Package visibility](https://developer.android.com/training/package-visibility/declaring)
- [Cloudflare R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/) · [Signed download URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
