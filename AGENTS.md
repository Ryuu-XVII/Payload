# Publishing Android apps to Payload

The default build and publish workflow runs on the owner’s PC. Use the app project’s local Android build to produce a signed standalone release APK. For the Payload store itself use `npm run --silent payload -- build` from this repository. The optional `build --eas` command starts an EAS cloud build and requires the owner to request that path.

Before preparing a release, run `npm run --silent payload -- inspect FILE.apk --json` and `npm run --silent payload -- app list --json`. The APK’s Android package ID identifies the target. Display names can be shared by several registered apps. The certificate fingerprint and version code provide additional verification.

For an already linked project, read `payload-app.json` in its project root. It contains the store origin and package ID, which are safe to commit. Check the link with `app show PACKAGE_ID --json`. Use `--project DIRECTORY` when calling the CLI from outside the app’s project.

When the APK has no registered app, ask the owner to confirm the app name, icon, target store, and trusted signing certificate fingerprint before creating the registration. If a request leaves the target or publishing intent unclear, ask the owner before changing remote state. A request to build or check an APK authorizes those steps. Explicit authorization to publish a named app and version covers the upload and catalog update.

Use `publish FILE.apk --app PACKAGE_ID --dry-run --json` to check the selected app, signing fingerprint, and version against the catalog. The dry run computes the APK digest and performs server preflight without uploading. With publishing authorized, repeat the validated command without `--dry-run`. Preserve the existing app registration and key when building an update. A version conflict requires a new build with a higher version code.

To monitor a publish, run `payload publish FILE.apk --app PACKAGE_ID --json --progress-file PATH` with a fresh path in an existing directory. Read stderr for newline-delimited events with `event: "publish-progress"`, or poll PATH from another process for the latest JSON snapshot. Use `status`, `bytesUploaded`, `totalBytes`, `percent` and `updatedAt` to report progress. At 100%, continue monitoring through `publishing`. Confirm success using the process exit code and the final stdout JSON with status `published` or `already-published`. If the process exits without reaching a terminal status, check stderr for the error before deciding what to do next.

Use the Windows-encrypted publisher settings or the environment variables documented in [README.md](README.md). Keep tokens, keystore passwords, and other credentials out of conversation, command arguments, logs, and source files. From another project, run `payload guide --json` for these instructions and `payload --json` for machine-readable help.

The store's own update target is `app.payload.store`. Increase its Android version code and preserve its production signing key. A release published to that catalog entry is offered to compatible devices under **Payload update**.
