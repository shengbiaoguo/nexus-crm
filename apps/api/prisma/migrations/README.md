# Migrations

The first migration is `20261030014538_init_m0`, generated with `prisma migrate dev --create-only --name init_m0`, reviewed before application, and applied to the verified-empty local database.
It contains ten M0 tables and two reviewed MySQL actor CHECK constraints not expressible in Prisma Schema. Preserve these in subsequent migrations; never edit an already-applied migration.
For subsequent changes use `pnpm prisma:migrate:dev --create-only --name <change>` against a dedicated local development database and review the generated SQL before application.
Commit schema and migration together. Production uses `pnpm prisma:migrate:deploy` only.
Follow docs/adr/0004-prisma-migration-strategy.md; verify empty-database creation and historical-data upgrades before release.

`20261030020831_align_m0_collation` changes the ten application tables and existing character columns to explicit utf8mb4_0900_ai_ci, matching the database default. It drops/recreates only audit_logs_attempt_id_fkey, preserving its RESTRICT rules. init_m0 and _prisma_migrations are unchanged.
For new tables, review Prisma-generated SQL and explicitly use `DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci` before application; the Schema does not encode this preference. The CI SQL review rejects different defaults in subsequent CREATE TABLE migrations.
MySQL ALTER TABLE implicitly commits and this conversion is not one atomic transaction. Stop on failure, inspect _prisma_migrations and actual table/FK state, and follow a reviewed recovery plan; never automatically reset or blindly mark a failed migration resolved.
