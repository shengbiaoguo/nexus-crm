# Migrations

No migration exists yet: initialization intentionally defines no tables. Do not create fake initial SQL.
When the first approved model is implemented, use `pnpm prisma:migrate:dev --name <change>` against a dedicated local development database and review the generated SQL.
Commit schema and migration together. Production uses `pnpm prisma:migrate:deploy` only.
Follow docs/adr/0004-prisma-migration-strategy.md; verify empty-database creation and historical-data upgrades before release.
