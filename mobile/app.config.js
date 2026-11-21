const fs = require('node:fs');
const path = require('node:path');
const packages = JSON.parse(fs.readFileSync(path.join(__dirname, 'packages.json'), 'utf8'));
const withManifest = require('./plugins/with-payload-manifest');
const googleServicesFile = process.env.PAYLOAD_GOOGLE_SERVICES_FILE || './google-services.json';
const hasFirebase = fs.existsSync(path.resolve(__dirname, googleServicesFile));

module.exports = () => withManifest({
  name: 'Payload',
  slug: 'payload',
  owner: 'ryuu_xvii',
  scheme: 'payload-store',
  version: '1.0.5',
  platforms: ['android'],
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  android: {
    package: 'app.payload.store',
    versionCode: 6,
    ...(hasFirebase && { googleServicesFile }),
    predictiveBackGestureEnabled: true,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/adaptive-monochrome.png',
      backgroundColor: '#493582',
    },
    permissions: ['android.permission.REQUEST_INSTALL_PACKAGES', 'android.permission.QUERY_ALL_PACKAGES'],
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ],
  },
  plugins: ['expo-secure-store', 'expo-notifications', './plugins/with-local-release-signing'],
  extra: {
    updateNotifications: hasFirebase,
    eas: { projectId: process.env.PAYLOAD_EAS_PROJECT_ID || '703a29f3-ef0b-4c13-90e9-942eec67f1c4' },
  },
}, packages);
