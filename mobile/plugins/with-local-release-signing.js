const { withAppBuildGradle } = require('expo/config-plugins');

const marker = '// Payload local release signing';
const signing = `
${marker}
def payloadKeystore = System.getenv("PAYLOAD_ANDROID_KEYSTORE")
if (payloadKeystore) {
    android.signingConfigs.create("payloadLocalRelease") {
        storeFile = file(payloadKeystore)
        storePassword = System.getenv("PAYLOAD_ANDROID_STORE_PASSWORD")
        keyAlias = System.getenv("PAYLOAD_ANDROID_KEY_ALIAS")
        keyPassword = System.getenv("PAYLOAD_ANDROID_KEY_PASSWORD") ?: storePassword
    }
    android.buildTypes.release.signingConfig = android.signingConfigs.payloadLocalRelease
}
tasks.matching { it.name == "createBundleReleaseJsAndAssets" }.configureEach {
    inputs.property("payloadApiUrl", System.getenv("EXPO_PUBLIC_PAYLOAD_API_URL") ?: "")
}
`;

module.exports = config => withAppBuildGradle(config, result => {
  if (!result.modResults.contents.includes(marker)) result.modResults.contents += signing;
  return result;
});
