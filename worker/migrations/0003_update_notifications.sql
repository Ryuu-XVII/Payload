CREATE TABLE push_devices (
  token TEXT PRIMARY KEY,
  sdk INTEGER NOT NULL
);

CREATE TABLE push_installs (
  token TEXT NOT NULL REFERENCES push_devices (token) ON DELETE CASCADE,
  package_id TEXT NOT NULL REFERENCES apps (package_id),
  version_code INTEGER NOT NULL,
  PRIMARY KEY (token, package_id)
);

CREATE INDEX push_installs_by_app ON push_installs (package_id, version_code);

CREATE TABLE push_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL REFERENCES push_devices (token) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  FOREIGN KEY (package_id, version_code) REFERENCES releases (package_id, version_code),
  UNIQUE (token, package_id, version_code)
);

CREATE INDEX push_jobs_due ON push_jobs (next_attempt_at);

CREATE TRIGGER queue_release_notifications AFTER INSERT ON releases
BEGIN
  INSERT INTO push_jobs (token, package_id, version_code, next_attempt_at)
  SELECT i.token, NEW.package_id, NEW.version_code, NEW.published_at
  FROM push_installs AS i JOIN push_devices AS d USING (token)
  WHERE i.package_id = NEW.package_id AND i.version_code < NEW.version_code AND d.sdk >= NEW.min_sdk;
END;
