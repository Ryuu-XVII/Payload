import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readApkMetadata } from './publish.mjs';

const fingerprint = 'ed'.repeat(32);
const verified = `Signer #1 certificate SHA-256 digest: ${fingerprint}\n`;
const badging = `package: name='app.payload.fixture' versionCode='13' versionName='2.4' platformBuildVersionName='16' platformBuildVersionCode='36'\nsdkVersion:'26'\n`;

test('extracts signed APK metadata including long version codes', () => {
  assert.deepEqual(readApkMetadata(badging, '', verified, fingerprint.toUpperCase().match(/../g).join(':')), {
    packageId: 'app.payload.fixture', versionCode: 13, versionName: '2.4', minSdk: 26, certificateSha256: fingerprint,
  });
  assert.equal(readApkMetadata(badging, 'A: android:versionCodeMajor(0x01010576)=(type 0x10)0x1', verified, fingerprint).versionCode, 2 ** 32 + 13);
});

test('rejects a changed certificate, a debug APK, and split APKs', () => {
  assert.throws(() => readApkMetadata(badging, '', verified, 'a'.repeat(64)), /does not match/);
  assert.throws(() => readApkMetadata(badging + 'application-debuggable\n', '', verified, fingerprint), /release APK/);
  assert.throws(() => readApkMetadata(badging, '  A: split="config.en"', verified, fingerprint), /standalone/);
  assert.throws(() => readApkMetadata(badging, '  A: android:isSplitRequired(0x01010591)=(type 0x12)0xffffffff', verified, fingerprint), /standalone/);
});
