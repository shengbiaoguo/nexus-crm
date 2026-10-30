# Migrations

The first migration is `20261030014538_init_m0`, generated with `prisma migrate dev --create-only --name init_m0`, reviewed before application, and applied to the verified-empty local database.
It contains ten M0 tables and two reviewed MySQL actor CHECK constraints not expressible in Prisma Schema. Preserve these in subsequent migrations; never edit an already-applied migration.
For subsequent changes use `pnpm prisma:migrate:dev --create-only --name <change>` against a dedicated local development database and review the generated SQL before application.
Commit schema and migration together. Production uses `pnpm prisma:migrate:deploy` only.
Follow docs/adr/0004-prisma-migration-strategy.md; verify empty-database creation and historical-data upgrades before release.
