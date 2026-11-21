CREATE TABLE apps (
  package_id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  certificate_sha256 TEXT NOT NULL
);

INSERT INTO apps (package_id, name, icon, certificate_sha256)
SELECT package_id, app_name, icon, certificate_sha256
FROM releases WHERE expires_at IS NULL;
