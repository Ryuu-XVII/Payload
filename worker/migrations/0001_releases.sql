CREATE TABLE releases (
  package_id TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  version_name TEXT NOT NULL,
  min_sdk INTEGER NOT NULL,
  app_name TEXT NOT NULL,
  icon TEXT NOT NULL,
  notes TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  certificate_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  published_at INTEGER NOT NULL,
  expires_at INTEGER,
  deleted_at INTEGER,
  cleanup_attempted_at INTEGER,
  cleanup_error TEXT,
  PRIMARY KEY (package_id, version_code)
);

CREATE UNIQUE INDEX one_current_release ON releases (package_id)
WHERE expires_at IS NULL;

CREATE INDEX pending_cleanup ON releases (expires_at)
WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

-- The UPDATE and the INSERT that fired it share a SQLite statement transaction.
-- Only the release that was current gets a replacement deadline.
CREATE TRIGGER replace_current_release BEFORE INSERT ON releases
WHEN NOT EXISTS (
  SELECT 1 FROM releases
  WHERE package_id = NEW.package_id AND version_code >= NEW.version_code
)
BEGIN
  UPDATE releases SET expires_at = NEW.published_at + 2592000000
  WHERE package_id = NEW.package_id AND expires_at IS NULL;
END;
