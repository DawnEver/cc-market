// Takeover plugin migration — idempotent, self-detecting, no-op once current.
// Called by npm run migrate (skills/migrate/migrate.js) on each project.

export async function migrate(_projectRoot) {
  // Current format — nothing to migrate.
  // When a future breaking change to .claude/ format is needed,
  // add the migration logic here (additive, no version-bookkeeping).
  return { changed: false, summary: "takeover: already at latest format" };
}
