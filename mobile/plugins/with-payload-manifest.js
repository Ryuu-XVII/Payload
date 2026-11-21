const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const managedQueries = 'app.payload.store.MANAGED_PACKAGE_QUERIES';

module.exports = (config, packages) => {
  if (!Array.isArray(packages) || packages.some(id => typeof id !== 'string' || !/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(id))) {
    throw new Error('packages.json must contain a list of valid Android package IDs.');
  }
  return withAndroidManifest(config, result => {
    const root = result.modResults.manifest;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    const metadata = application['meta-data'] ?? [];
    const previous = new Set(metadata.find(item => item.$['android:name'] === managedQueries)
      ?.$['android:value']?.split(',').filter(Boolean));
    root.queries ??= [];
    for (const query of root.queries) {
      if (query.package) {
        query.package = query.package.filter(item => !previous.has(item.$['android:name']));
        if (!query.package.length) delete query.package;
      }
    }
    root.queries = root.queries.filter(query => Object.keys(query).length);
    const newIds = [...new Set(packages)].filter(id =>
      !root.queries.some(query => query.package?.some(item => item.$['android:name'] === id)),
    );
    if (newIds.length) {
      root.queries.push({ package: newIds.map(id => ({ $: { 'android:name': id } })) });
    }
    application['meta-data'] = metadata.filter(item => item.$['android:name'] !== managedQueries);
    if (newIds.length) {
      application['meta-data'].push({ $: { 'android:name': managedQueries, 'android:value': newIds.join(',') } });
    }
    return result;
  });
};
