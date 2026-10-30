# Nexus CRM engineering rules

## Scope and architecture

- Modular monolith: apps/api (NestJS), apps/admin (React), packages/shared (transport contracts only), infra and scripts. Single-enterprise MySQL 8.4; Redis is auxiliary, never authoritative for money or approvals.
- Current task is engineering initialization only. Do not implement users, roles, customers, orders, approval policies or business tables until explicitly requested. Initialization is not completion of all M0 requirements.
- Node 24.22.2 LTS, pnpm 10.34.9, TypeScript strict, ESM/NodeNext on API; exact direct dependency versions and committed pnpm lockfile. Do not silently change major versions.

## Sources and priority

- Read docs before implementation. Explicit current user instructions set task scope; preserve confirmed BR-001..010 in requirements.md. Unknown business decisions remain unknown.
- requirements.md defines business; permission-matrix.md defines authorization; current Accepted ADRs define technical decisions; data-model.md and api-design.md implement those contracts. None authorizes silently overriding a conflict: record it and obtain a decision for affected business behavior.
- ADR-005 supersedes ADR-002; do not treat historical ADR-002 as current. New decisions that overturn Accepted ADRs require a superseding ADR; keep historical reasons.
- Do not overwrite existing design documents using a scaffold generator. Record setup/compatibility differences in docs/engineering-initialization.md.

## Data and security

- Schema evolves only through reviewed Prisma Migration SQL committed with schema. Development: migrate dev against dedicated local databases. Production: migrate deploy; never db push/migrate reset/migrate dev, manual untracked ALTER or fabricated migrations.
- Expand → Backfill → Contract; test new and historical databases, backup/restore and compatibility. Never assume automatic down migration.
- Prisma 7: prisma.config.ts holds datasource URL, prisma-client generator has explicit output, runtime uses matching official @prisma/adapter-mariadb. Do not put legacy URL config in datasource schema.
- No production credentials or real development secrets in Git, shared packages, VITE_* or logs. Only placeholders in examples; .env files and generated clients ignored.
- Future commands must enforce action + object scope + parent-child consistency + state + separation of duties on server. Use the documented shared orders transaction/lock protocol, business+success audit+idempotency atomically, reliable attempts per ADR-003.
- Amounts Decimal/string, BigInt IDs strings, UTC timestamps; do not implement money with JS floating point.

## Verification and boundaries

- Before handing off: install locked dependencies; run lint, typecheck, build, minimum unit tests, compiled API health smoke and OpenAPI export. Report actual failures and unrun checks explicitly.
- Liveness must work without MySQL/Redis and must not imply dependency readiness. Database/service checks are separate, explicit, read-only, and never run against production automatically.
- Database-dependent work needs reachable approved local MySQL/Redis services and credentials; Docker is optional and is not a prerequisite for direct local service checks (user decision 2026-10-30). Do not invent credentials, install/start system services or create databases as an implicit test.
- Future invariant/concurrency and permission tests require real MySQL, not only mocks. CI frozen-lock install and deterministic checks must match local scripts.
- No microservices, Kafka, Kubernetes, CQRS, generic strategy/workflow engine, complex DDD framework, speculative tables or business modules.
- Do not add latest dependency/image tags, weaken strict checks to pass, or claim CI/deployment/database checks ran when only files were created.
