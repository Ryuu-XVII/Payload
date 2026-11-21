# Payload

Payload is a private Android store for one owner. Publish standalone signed APKs from your computer or CI, then open the library on your phone to install or update through Android’s installer.

## Cloudflare setup

The current deployment is `https://payload.adnaanhoosen51.workers.dev`. It uses the `payload` D1 database and the private `payload-apks` R2 bucket. The checked-in Wrangler configuration targets this deployment. The setup commands below are for provisioning a fresh account.

### Use the saved credentials on this PC

The setup saved the credentials in `%LOCALAPPDATA%\Payload\cloudflare.credentials.clixml`. Windows encrypts the file for the current user on this computer. For a different computer or for CI, provision credentials in that environment's secret store. [PowerShell credential encryption](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/export-clixml#example-3-encrypt-an-exported-credential-object-on-windows)

The CLI loads the saved publisher settings automatically on this PC. Set the publisher environment variables explicitly in CI or when targeting another store.

To copy the owner access token for first-time sign-in to the Android app:

```powershell
$payloadCredentials = Import-Clixml (Join-Path $env:LOCALAPPDATA 'Payload/cloudflare.credentials.clixml')
[System.Net.NetworkCredential]::new('', $payloadCredentials['OWNER_TOKEN']).Password | Set-Clipboard
```

### Provision a fresh account

Install Node.js 22.16 or newer. From this directory, run:

```sh
npm ci
npx wrangler login
npx wrangler r2 bucket create payload-apks --storage-class Standard
npx wrangler d1 create payload
```

Set the target `account_id` and new D1 database ID in `worker/wrangler.jsonc`. If you change the R2 bucket name, update both its binding and `R2_BUCKET_NAME`. Keep the bucket private with its public development URL and public custom domains disabled. Use the Standard storage class for the bucket and leave upload-age expiry rules disabled. [R2 setup](https://developers.cloudflare.com/r2/get-started/s3/)

Create independent, high-entropy owner and publisher tokens. Generate them separately with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Create two bucket-scoped R2 S3 credentials in Cloudflare. The Worker uses an Object Read credential to sign downloads. The publisher uses an Object Read & Write credential to upload. The scheduled cleanup deletes through the bucket binding. [R2 S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/)

```sh
npx wrangler d1 migrations apply payload --remote --config worker/wrangler.jsonc
npx wrangler secret put OWNER_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put PUBLISH_TOKEN --config worker/wrangler.jsonc
npx wrangler secret put R2_ACCOUNT_ID --config worker/wrangler.jsonc
npx wrangler secret put R2_READ_ACCESS_KEY_ID --config worker/wrangler.jsonc
npx wrangler secret put R2_READ_SECRET_ACCESS_KEY --config worker/wrangler.jsonc
npm run worker:deploy
```

Keep the Worker’s HTTPS URL. The 15-minute UTC Cron Trigger comes from the Worker configuration. D1 records publish time, retention deadline, last cleanup attempt, and deletion time or error. Published deadlines use UTC epoch milliseconds. The Worker caps the signature at five minutes and rounds an archived release's signed expiry down to the nearest second to stay within its deadline. R2 deletion takes place on the next successful scheduled cleanup. [Signed R2 URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) · [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## Publish a locally built APK

Use your app project’s local build tools to produce a signed, standalone release APK. That APK can also come from EAS or CI. The publisher uses the same upload and catalog workflow in each case.

From this directory, run `npm ci` for the CLI. Install Java and Android SDK Build Tools. The CLI checks the usual Windows SDK and JDK locations automatically. Set `ANDROID_HOME` or `ANDROID_BUILD_TOOLS` and `JAVA_HOME` for custom installations.

```powershell
npm run --silent payload -- inspect ./release.apk --json
npm run --silent payload -- app list --json
npm run --silent payload -- app create --package com.example.myapp --name "My App" --icon ./app-icon.png --cert YOUR_EXPECTED_CERT_SHA256
npm run --silent payload -- app link com.example.myapp --project "C:/Projects/My App"
npm run --silent payload -- publish ./release.apk --app com.example.myapp --dry-run --json
npm run --silent payload -- publish ./release.apk --project "C:/Projects/My App" --notes ./release-notes.txt --json
```

Register each app once. Set its Android package ID and a fingerprint from your trusted release keystore. The registration supplies the name and icon for all releases. Use the app’s own PNG icon up to 96 KiB. The app appears in the store after its first release publishes.

Linking writes a `payload-app.json` file with the store origin and package ID. Existing links are preserved. You can pass `--app` for a one-off command or publish from the linked project with the `payload` executable. To make the executable available outside this repository, run `npm link` here once. Running `npm run publish:apk -- ...` in this repository also calls the publisher.

The CLI checks the APK package ID, registered signing fingerprint, and version before uploading. Notes are optional UTF-8 text up to 20,000 characters. The upload goes directly to private R2 before the Worker commits it to the catalog. Re-running a publication after an interruption is safe. Publish one build per app at a time. A losing concurrent attempt with different bytes can leave an unreferenced object in R2. The current workflow expects the registered signing certificate for updates. Preserve your key and keep an encrypted backup. [Android signing and updates](https://developer.android.com/studio/publish/app-signing)

The terminal shows a live upload bar with the percentage and MiB sent. After the upload, Payload confirms that the release was added to the store.

For automation, run the publish command with a new progress filename. While it runs, read the file from another terminal or follow the newline-delimited JSON events on stderr. Stdout contains the final result JSON.

```powershell
payload publish ./release.apk --app com.example.myapp --json --progress-file ./upload-123.json
Get-Content -LiteralPath ./upload-123.json -Raw | ConvertFrom-Json
```

The status file records `status`, `bytesUploaded`, `totalBytes`, `percent`, and `updatedAt`, plus the package ID and version code after APK inspection. It stays on disk after the command exits. Wait for `published` or `already-published` and a successful exit to confirm publication. An interrupted process may leave the last recorded status.

[Agent publishing instructions](AGENTS.md) document target discovery, authorization checks, the JSON dry run, and upload monitoring. A linked CLI can show the same instructions from any project with `payload guide --json`.

### Configure CI or use a different store

Provide these values through the environment or CI secret store:

| Variable | Value |
| --- | --- |
| `PAYLOAD_API_URL` | HTTPS URL of your Worker |
| `PAYLOAD_PUBLISH_TOKEN` | The Worker’s distinct publishing token |
| `PAYLOAD_R2_ACCOUNT_ID` | Cloudflare account ID |
| `PAYLOAD_R2_BUCKET` | Private bucket name |
| `PAYLOAD_R2_WRITE_ACCESS_KEY_ID` | Bucket-scoped publisher key ID |
| `PAYLOAD_R2_WRITE_SECRET_ACCESS_KEY` | Publisher secret |

## Build and install Payload

Payload checks the installed versions of catalog apps directly on the phone, including apps installed outside Payload. Its private Android build declares `QUERY_ALL_PACKAGES` so newly published package IDs are visible as soon as they enter the catalog. The store package name defaults to `app.payload.store`. Choose its permanent identity before the first signed release. [Android package visibility](https://developer.android.com/training/package-visibility/declaring)

Tap **Download** to save and verify the APK, then **Install** or **Install update** to open an Android install session. Payload keeps one verified APK per app in private storage. A failed or cancelled installation leaves it available for another install attempt. The installation bar shows Android’s session progress while Android provides it and prompts the user when confirmation is required. [Android installer sessions](https://developer.android.com/reference/android/content/pm/PackageInstaller.SessionInfo)

### Local release on Windows

Install a JDK and the Android SDK, then run `npm ci` in both this directory and `mobile`. Put the Worker HTTPS URL in `mobile/.env.local` as `EXPO_PUBLIC_PAYLOAD_API_URL`. This PC already has that URL configured.

```powershell
npm run --silent payload -- keygen
npm run --silent payload -- build
```

Run `keygen` once if Payload has no existing release key. It saves the keystore and Windows-encrypted password under `%LOCALAPPDATA%\Payload\signing` and prints the public certificate fingerprint. The build command generates the native project locally, signs and verifies the release, and writes `mobile/dist/Payload-<versionCode>.apk`. Use `--output FILE.apk` for a different destination. No Expo sign-in is needed for this path. [Expo local production builds](https://docs.expo.dev/guides/local-app-production/) · [Android release APKs](https://developer.android.com/build/build-for-release)

To use an existing key, set `PAYLOAD_ANDROID_KEYSTORE`, `PAYLOAD_ANDROID_KEY_ALIAS`, and `PAYLOAD_ANDROID_STORE_PASSWORD` through your local secret store. Set `PAYLOAD_ANDROID_KEY_PASSWORD` if it differs from the store password. Keep an encrypted backup of the keystore, alias, and passwords together. The Windows credential file is tied to this user and computer. To save the generated keystore password in your password manager, you can copy it from PowerShell:

```powershell
$payloadSigning = Import-Clixml (Join-Path $env:LOCALAPPDATA 'Payload/signing/credentials.clixml')
[System.Net.NetworkCredential]::new('', $payloadSigning['PAYLOAD_ANDROID_STORE_PASSWORD']).Password | Set-Clipboard
```

Install the first Payload APK directly on your phone and enter the owner token. Android may ask for the **Allow from this source** permission when you install your first app through Payload. A previously installed debug-signed Payload build needs to be removed before installing the production-signed build.

### Update Payload from the library

1. Register `app.payload.store` in the same catalog once, using the Payload icon at `mobile/assets/icon.png` and the certificate fingerprint reported by `payload inspect` on a verified production Payload APK.
2. For each release, raise `android.versionCode` in `mobile/app.config.js`, set the new version name, and build with the same signing key. Run `payload publish FILE.apk --app app.payload.store --dry-run --json` to preflight it, then repeat without `--dry-run` to publish.
3. Open Payload or tap **Settings → Payload updates → Check for updates**. A newer compatible version appears under **Payload update** in the library and in Settings. Tap **Download**, then **Install update**, and confirm in Android.
4. Open Payload again after Android replaces it. The library shows the new version and reports successful installation. An in-place update keeps the owner token and app data.

### App update notifications

When notifications are configured, device owners can turn **App update alerts** on or off in **Settings → Notifications**. Payload sends the store the installed version codes of catalog apps when the library loads, when Payload returns to the foreground, and after installs. The Worker queues an alert on publication if a device reported an older installed version and supports the new release. Apps installed or removed outside Payload are reflected the next time Payload opens. Tapping an alert opens that app’s details.

1. Register the Android app `app.payload.store` in Firebase and save its `google-services.json` to `mobile/google-services.json`. For a different location, set `PAYLOAD_GOOGLE_SERVICES_FILE` to the file path in the build environment. [Firebase Android setup](https://firebase.google.com/docs/android/setup)
2. Enable Firebase Cloud Messaging and create a dedicated service account with the Firebase Cloud Messaging API Admin role on this project. Store its JSON key as the Worker secret `FCM_SERVICE_ACCOUNT` and keep the file out of source control. The app obtains the native Android device token and the Worker sends directly through the FCM HTTP v1 API. [FCM HTTP v1 setup](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
3. Apply D1 migration `0003_update_notifications.sql` with the migration command above, then deploy the Worker. The notification cron runs every minute. Update the installed Payload APK when ready so devices can opt in.

Verify on an Android device with Google Play services by enabling notifications, installing a catalog app, and publishing a newer compatible version of that app. With Payload in the background, the notification should open that app’s details when tapped.

### Optional EAS cloud release

Payload is linked to `@ryuu_xvii/payload`. The EAS production and development environments both have the live Worker URL. The EAS default Android credential matches the permanent signing key used by the local release. Run `npm run --silent payload -- build --eas` when you want a cloud-built APK. [Expo project](https://expo.dev/accounts/ryuu_xvii/projects/payload) · [EAS APK profiles](https://docs.expo.dev/build-reference/apk/)

## Verification

`npm run check` type-checks the Worker and client. `npm test` runs publisher metadata checks and Worker tests on local D1 and R2, including access controls, concurrent publication, a 55 MiB object, three-release retention, compatible fallback, and deletion retry.

For isolated Android development, start `node worker/test/phone-server.mjs` from the root. Set the publisher variables printed by the local server. In the mobile environment, use `EXPO_PUBLIC_PAYLOAD_API_URL=http://127.0.0.1:8974`, then run `adb reverse tcp:8974 tcp:8974` for the connected test device. Load the development build and enter the printed local owner token. This test server provides an in-memory catalog and loopback APK downloads. Use only test signing keys and local credentials with it. To fail the next APK download, POST to `http://127.0.0.1:8974/__fixture/fail-download`.

Before distributing the release APK, run the device acceptance checks in [the requirements](private-android-store-requirements.md) against your deployed Worker and a real Android phone. Use a disposable test app and verify its saved data before and after an in-place update, including when the original was installed outside Payload. Exercise permission denial and grant, installer cancellation, incompatible releases, a mismatched signing key, failed download and retry, and an APK over 50 MB.
