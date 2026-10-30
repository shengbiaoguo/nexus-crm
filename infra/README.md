# Local infrastructure

Default development uses existing MySQL 8.4 at 127.0.0.1:3306 and Redis at 127.0.0.1:6379. No root password is assumed, no existing service is modified, and startup does not create a database.

Set the root .env URLs and run `pnpm build` then `pnpm services:check` from the repository root. Direct local service checks do not require Docker. Compose remains an optional alternative and is not used unless explicitly started.

Optional isolated alternative, only if Docker is installed:

```sh
cp infra/.env.example infra/.env
# Fill both passwords locally. Never commit infra/.env.
docker compose --env-file infra/.env -f infra/compose.yaml config --quiet
docker compose --env-file infra/.env -f infra/compose.yaml up -d
```

These containers bind to loopback ports 3307/6380 to avoid existing services. Update root .env URLs accordingly. Use a dedicated database/account. The file is a development service profile, not a production deployment or a dependency of health/unit tests.

Do not use `down -v` on data you need. Docker build/run/Compose validation remains unverified on hosts without Docker. Image patch versions are explicit; updates require review.
