# Nexus CRM

pnpm Monorepo 工程底座，已实现 M0 身份/平台数据库模型、首份迁移、受控字典 Seed 和数据库集成测试；**不等于完整 M0 业务底座完成**。提供健康检查、Swagger 和前端空壳，尚未实现 Auth/RBAC 执行逻辑或 CRM/订单/财务业务表。

## 环境

- Node **24.22.2 LTS**、pnpm **10.34.9**（packageManager 和 lockfile 固定）。
- 本地 MySQL **8.4**、Redis；默认连接 127.0.0.1:3306 / 6379。API 健康检查不连接数据库或 Redis。
- Docker Compose 作为可选的隔离本地服务方案，见 [infra/README.md](infra/README.md)，不会自动启动。

如果系统已有正确工具，直接使用下面命令。本次 Windows 环境另在忽略目录 `.tools` 安装了固定工具，不修改系统 Node；新 PowerShell 会话可执行：

```powershell
. ./scripts/use-local-tools.ps1
```

全新机器可使用 Node 官方发行包或版本管理器安装 .node-version 指定版本，然后安装 `pnpm@10.34.9`。不要提交 `.tools` 或实际凭证。

## 安装及启动

```sh
pnpm install --frozen-lockfile
pnpm env:init
# 编辑根目录 .env，填写已有本地服务的独立账号/数据库；不会覆盖现有 .env。
pnpm prisma:validate
pnpm prisma:generate
pnpm dev
```

- 前端：http://localhost:5173（开发代理 /api → http://127.0.0.1:3000）。
- API：http://127.0.0.1:3000/api/v1/health。
- Swagger：http://127.0.0.1:3000/docs；JSON：/docs-json。由 SWAGGER_ENABLED 控制，默认关闭，示例开发配置开启。
- 若改变 API_PORT，同步修改 apps/admin/vite.config.ts 的代理目标；若改变前端地址，同步 CORS_ORIGIN。
- `.env.example` 只有占位值，启动健康检查不会把占位值当作真实数据库凭证连接；服务验证前必须替换。前端无需服务密钥，禁止将 DATABASE_URL 放入 VITE_*。

单独启动或运行编译产物：

```sh
pnpm --filter @nexus/shared build
pnpm --filter @nexus/api dev
pnpm --filter @nexus/admin dev
# 或
pnpm build
pnpm --filter @nexus/api start
```

## 验证

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm smoke
pnpm openapi:export
```

smoke 会启动真实的编译后 API 子进程，在空闲端口请求 health、Swagger 和 OpenAPI，随后停止子进程。单元/HTTP 测试不依赖数据库；openapi:export 生成忽略目录 artifacts/openapi.json。CI 使用同一脚本，当前不宣称 GitHub 远端 CI 已执行。

```sh
# 填写 .env 中的本地凭证后，显式执行只读服务验证；不需要 Docker。
pnpm services:check
```

该检查直接连接 .env 指定的本地 MySQL/Redis，不检查或启动 Docker、不创建表、不执行 Migration，仅查询 MySQL 版本与 Redis PING。连接、认证或版本不符合要求时非零退出。数据库相关验收状态见 [初始化记录](docs/engineering-initialization.md)。

## Prisma / Migration

Prisma CLI/Client/MySQL 官方适配器均锁定 7.10.1。prisma.config.ts 配置连接 URL，schema 使用 mysql provider 和显式 prisma-client 输出。首份 `20261030014538_init_m0` 包含十张 M0 表，已在确认空的本地库应用。详见 [SQL 审查与实施记录](docs/reviews/m0-implementation.md)。

后续 Schema 变更先 validate，再使用 `pnpm prisma:migrate:dev --create-only --name <change>` 生成 SQL，审查后再应用。生产使用 `pnpm prisma:migrate:deploy`。Schema 和真实生成的迁移 SQL 一同评审提交。禁止 db push、重置历史或承诺自动 down migration。详见 [ADR-004](docs/adr/0004-prisma-migration-strategy.md)。

```sh
# 仅在确认的专用本地开发库进行迁移和初始化；遇非空未知库先停止核查。
pnpm prisma:validate
pnpm prisma:migrate:deploy
pnpm prisma:generate
pnpm prisma:seed
pnpm test:db
pnpm db:verify
```

基础 Seed 只初始化七种角色和权限/范围映射，不创建账号或分配用户角色；重跑不覆盖已修改的有效模板，冲突时失败。数据库测试 fixture 与 Seed 分离：主要通过事务回滚，仅按随机唯一标识清理测试自己创建的技术记录，禁止全表清空。`pnpm db:verify` 输出实库类型、索引、FK、CHECK 和数量到 artifacts/m0-database-verification.json。测试不自动迁移或重置库，执行前应人工确认本地目标。普通 `pnpm test` 不连接数据库。

序列化：选出允许字段后用 serializeJson 将 BigInt 转十进制字符串、Date 转 UTC ISO 字符串；Json 写入显式区分 Prisma.DbNull（SQL NULL）与 Prisma.JsonNull（JSON null）。拒绝 undefined/非有限数字/未映射类实例，不把整个用户对象或密码哈希自动公开。MySQL 适配器固定 UTC 会话与日期转换。

## 项目依据及状态

架构、授权、并发、幂等、审计和迁移约束见 [AGENTS.md](AGENTS.md) 与 docs。原有设计文档保留；待确认需求不作为已实现行为。初始化差异、实际版本及验证结果记录于 [engineering-initialization.md](docs/engineering-initialization.md)。
