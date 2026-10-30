# 工程初始化记录

日期：2026-10-29。本轮只初始化工程；文档中的完整 M0 身份、授权、幂等和审计模块尚未实现，不创建相关表。

以下初始化检查保留 2026-10-29 的历史结果。2026-10-30 用户明确采用本地 MySQL/Redis，已取消 Docker 前置门禁；当前本地验证结果见文末补充记录。

## 现有文件与依据

初始化前磁盘只有 docs，没有 README、Starter、Prisma Schema、迁移或 Git 仓库。完整阅读既有设计文档，原有文件通过初始化前 SHA-256 基线核验，不作覆盖。ADR-004 中“Starter 已编写 M0 Schema”的历史描述与实际磁盘不符；此处记录事实差异，不伪造其存在，也不改写历史 ADR。

本次用户要求“仅初始化、不生成用户/权限/订单代码”，因此不按 data-model.md 的完整 M0 表清单提前建表。未来按其阶段门禁实现。

## 工具链与兼容性决定

- 初始系统工具：Node 24.9.0、pnpm 9.12.3。改用项目忽略目录 .tools 中的 Node 24.22.2（运行时 process.release.lts=Krypton）与 pnpm 10.34.9；系统工具未修改。
- NestJS 核心/平台/测试 12.3.2，Swagger 12.0.5，ESM + TypeScript NodeNext；不复制旧 CommonJS Starter。使用 TypeScript 6.0.3，避免当前 TypeScript 7 与 typescript-eslint 的兼容范围冲突。
- 安装阶段发现 ESLint 9 已停止支持，修正为 ESLint 10.13.0 / @eslint/js 10.0.1；typescript-eslint 8.72.1 和 React Hooks 7.1.1 的 peer 范围包含 ESLint 10。API 开发也使用 tsc watch 生成带装饰器元数据的 JS，再由 Node watch 重启，避免 tsx/esbuild 丢失 Nest 注入元数据。
- Prisma CLI、Client 和官方 @prisma/adapter-mariadb 均 7.10.1；prisma.config.ts 配 URL，schema 不放旧式 url，prisma-client 显式输出且 ESM。没有业务模型，不创建占位业务表或虚假迁移。
- React 19.3.1、Ant Design 6.6.8、Vite 8.3.5、React 插件 6.1.2；不添加旧版 Ant Design React 19 兼容补丁。
- 不使用 Nest CLI 生成器覆盖目录；直接建立符合 Nest 模块/控制器模式的最小 API，并由实际编译、启动与 HTTP 测试验证。
- 项目 registry 固定官方 npm；初次沙箱访问原系统 mirror 被 EACCES 拒绝，经网络权限批准后访问官方 registry 安装。未把镜像地址或全局配置改写为项目架构决定。
- CORS、1 MiB 请求体上限、开发端口属于可调整工程默认值，不宣称业务 SLA 已确认。

官方核对依据：

- [NestJS 12 官方迁移说明](https://github.com/nestjs/docs.nestjs.com/blob/master/content/migration.md)：ESM 与兼容运行时。
- [Prisma 7 MySQL 官方配置及适配器](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/mysql)。
- [Vite 官方环境要求](https://vite.dev/guide/)。
- [Node 官方发行周期](https://nodejs.org/en/about/previous-releases)。
- 实际可安装版本及 peer 约束以官方 npm registry 元数据、package.json 和 pnpm-lock.yaml 为准。

## 本地基础服务边界

Get-Service 显示 MySQL84、Redis 正在运行，netstat 确认 3306、6379 监听；未据服务名称宣称已完成 MySQL 登录或版本查询。Docker 不在 PATH，标准安装路径也不存在。Get-NetTCPConnection/CIM 受本机访问限制，改用可用的服务列表及 netstat 作只读检查。

按本次任务“数据库依赖步骤先确认 Docker 和 MySQL 可用”的门禁，不运行数据库连接、Migration 或数据写入。services:check 会先检查 Docker，缺失时非零退出；健康检查/测试刻意使用无可达服务 URL，证明其只是进程 Liveness。未来填写自己的本地账号后再验证服务；不猜测密码、不自动创建数据库或替用户安装 Docker。

Compose 是可选隔离本地服务配置（MySQL 8.4.7、Redis 8.2.2），默认仍直连现有宿主机服务。未在 Docker 缺失时声称通过 Compose config/up 或容器测试。

## 验证状态

| 实际命令/检查                            | 结果                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Node / pnpm 版本                         | v24.22.2，LTS Krypton / 10.34.9                                                                                            |
| pnpm install                             | 成功；所有直接依赖固定版本，生成 pnpm-lock.yaml                                                                            |
| pnpm install --frozen-lockfile --offline | 使用原安装权限/缓存后成功，锁文件无需修改                                                                                  |
| pnpm env:init                            | 成功创建仅含占位值的忽略文件 .env，不覆盖已有文件                                                                          |
| pnpm prisma:validate                     | 7.10.1 CLI 验证通过；无数据库连接                                                                                          |
| pnpm prisma:generate                     | 成功生成无业务模型的 Prisma 7.10.1 Client；无建表                                                                          |
| pnpm lint                                | ESLint 10，零警告/错误                                                                                                     |
| pnpm typecheck                           | shared / api（含测试及 Prisma 配置）/ admin 均通过 strict 检查                                                             |
| pnpm build                               | shared、API、Vite 前端全部通过；前端单 JS 包约 596 kB，有 >500 kB 构建提示，留待业务路由引入时按需拆分，未通过调高阈值掩盖 |
| pnpm test                                | 4 项通过：前端响应契约 1、环境配置 2、API HTTP/OpenAPI 1；0 失败/跳过                                                      |
| pnpm smoke                               | 编译后 API 子进程：GET /api/v1/health 200、/docs 200、/docs-json 的 health operationId 正确；自动停止进程                  |
| pnpm format:check                        | 通过；原有设计文档刻意排除自动重排                                                                                         |
| pnpm openapi:export                      | 成功生成 artifacts/openapi.json                                                                                            |
| pnpm services:check                      | 非零退出，明确 BLOCKED：Docker 不可用；未尝试数据库连接                                                                    |
| 原 docs 哈希                             | 11 份原文件 SHA-256 全部一致                                                                                               |

完整实际直接依赖见 [dependency-versions.json](dependency-versions.json)，来自 pnpm list --recursive --depth 0 --json；完整源码目录树见 [project-tree.txt](project-tree.txt)。目录树不包含安装产物、真实环境文件、工具下载及生成客户端。

### 执行期间的修正/限制

- ESLint 9 停止支持提示已修复，最终采用兼容的 ESLint 10，未禁用 lint/strict 检查。
- 首次冻结离线安装在沙箱中因自动选用了项目内 store，而原安装使用 F 盘共享 store，触发无 TTY 的重建保护；回到原安装权限/缓存执行后成功，不强制清空 node_modules、不修改锁文件以绕过检查。
- pnpm 明确阻止了非必需的 @scarf/scarf 安装期统计脚本；必要 Prisma 引擎和 esbuild 构建脚本按 workspace 白名单执行，客户端生成和构建已实际通过。
- 未运行 MySQL 登录/查询、Redis PING、任何 Migration；没有真实数据库凭证，且 Docker 门禁未满足。也未验证 Compose config/up。
- GitHub Actions 仅交付工作流文件，本机不具备远端执行记录；当前目录不是 Git 仓库，未创建提交。
- 未实现身份、权限、幂等业务执行或审计业务记录；这属于后续 M0 工作，不属于本次工程初始化。

## 2026-10-30：直接使用本地 MySQL/Redis

- 用户明确暂不使用 Docker。移除 services:check 的 docker info 门禁；不修改原有架构 ADR，不启用 Compose。
- 检查继续限制为 loopback 本地地址，读取根 .env，通过 Prisma 7 官方 MySQL 适配器执行 SELECT VERSION()，并向 Redis 发送 PING。保留配置校验、失败非零退出、凭证不输出和连接释放。
- 实际执行 `pnpm --filter @nexus/api build`、`pnpm services:check` 成功：本地 MySQL **8.4.13**，Redis **PONG**。
- 未建表、未执行 Migration、未写入业务或 Redis 数据；未执行 Git 操作。Compose 文件保留为可选配置。
- README、infra/README 和 AGENTS 已同步：本地服务不依赖 Docker。首次初始化时的 Docker 阻塞记录仅作历史，不再代表当前状态。

## 2026-10-30：日志/审计事务兼容性

- Prisma 7.10.1 的交互式事务代理仍暴露 `$transaction`，不能通过属性存在性识别事务；真实 MySQL 验证发现该差异。
- AuditService 使用 withTransaction 登记 callback 内的确切事务对象，拒绝根客户端/未登记事务写入成功审计；不依赖 Prisma 私有属性或改动生成代码。业务写入、成功审计、尝试终态和幂等结果仍使用同一个数据库事务。
- 复用已有 audit_logs/command_attempts，不改 schema 或历史 Migration；不新增外部日志依赖。实现边界和使用规则见 [结构化日志与审计](logging-and-audit.md)。

## 2026-10-30：JWT 与 Refresh Token

- 增加 AuthModule，复用 M0 用户/会话表及 AuditService；无数据库结构或历史 Migration 变更。配置、HTTP 契约和边界见 [认证说明](authentication.md)。
- 固定依赖 jose 6.1.3，更新 pnpm 锁文件；使用项目本地 Node 24.22.2 和 pnpm 10.34.9。全局 Node 版本不符合项目要求，不用于验收。
- 真实 MySQL 测试发现原生 SQL 的无符号整数字段可能映射为 bigint，而 Prisma 模型字段为 number；改为 SQL 仅获取行锁，Prisma 读取并映射字段，显式使用 ReadCommitted，避免类型断言掩盖驱动差异。
- AUTH_JWT_SECRET 不设置默认值，缺失时仅认证返回 503；HTTP 探活和 OpenAPI 导出保持无数据库连接。受控账号创建须使用 hashPassword 的 scrypt 格式，本次不创建真实账号、不实现用户管理接口。
- 实际验收通过：冻结锁离线安装、lint、typecheck、build、test（API 16 / Admin 1）、test:db（本地 MySQL 8.4.13，13 项）、编译后 API smoke、OpenAPI 导出及 git diff --check。登录、续期、登出、停用认证测试全部通过，包含真实数据库并发与审计回滚。
- 构建仍提示 Admin 现有产物超过 500 kB；安装仍提示忽略 @scarf/scarf 构建脚本，均未放宽检查或调整无关模块。未执行生产部署/生产验证，无需执行新 Migration。

## 2026-10-30：RBAC 与对象级读取授权

- 增加 AuthorizationModule、固定权限/scope Policy 和 M0 读取 Service，Controller 仅处理 HTTP。接口、字段白名单及未实现范围见 [授权契约](authorization.md)。无 schema/Migration 或依赖版本变更。
- AuthDatabase 移至共享 PrismaService/DatabaseModule；认证与授权导入同一个动态模块注册对象，真实应用测试验证只有一个连接池持有者，仍保持按需初始化和关闭释放。
- M0 读取使用新的 RepeatableRead 快照完成权威账号/会话/角色重验及数据查询，避免同一读取中授权和结果不一致；该方法不适用于写命令，不替代现行授权锁顺序。
- 实际验收通过：冻结锁离线安装、lint、typecheck、build、test（API 19 / Admin 1）、test:db（本地 MySQL 8.4.13，18 项）、编译后探活、OpenAPI 导出及 git diff --check。普通用户越权拒绝、权限撤销并发和此前 JWT 回归均通过；本地 MySQL/Redis 只读连通检查通过。
- 本次新增 3 项普通测试与 5 项真实数据库测试；未执行生产部署或生产权限验证。Admin 既有大包提示及 @scarf/scarf 脚本忽略提示仍存在，未改无关模块或放宽校验。

## 2026-10-30：幂等基础组件

- 复用现有 idempotency_records/command_attempts/audit_logs，新增 IdempotencyModule 与固定指纹、存储和执行 Service；无 schema/Migration、依赖版本或业务端点变更。接入边界见 [幂等说明](idempotency.md)。
- 争用 Key 时临时设置当前连接的 innodb_lock_wait_timeout=2，并在 finally 恢复原值；MySQL 语句超时不等于事务回滚，因此失败退出完整事务。正常池仍按需初始化；恢复核对才开启独立短生命周期客户端。
- AuditService 的尝试预写/失败/未知方法收窄为所需 commandAttempt delegate，允许组件使用独立短事务设定等待上限；仍拒绝在登记的业务事务中预写 STARTED。成功审计仍限定 withTransaction 登记的确切事务。
- 首轮真实数据库验证通过重试、请求冲突、并发一次执行、超时、回滚、重放授权和异常恢复；首轮 lint 发现稀疏数组测试字面量违规，改为测试内删除数组索引构造，未关闭 lint 规则。
- 复核补齐 userLocks：由服务端声明完整用户锁集合及 SHARE/UPDATE 模式，补入操作者后去重并按数值 ID 排序，避免固定先锁操作者后再追加更小 ID 用户；后续角色/部门/业务行仍由业务授权回调遵守既有顺序。
- 最终实际通过：冻结锁离线安装、lint、typecheck、build、test（API 24 / Admin 1）、test:db（本地 MySQL 8.4.13，30 项）、编译后 API smoke、OpenAPI 导出及 git diff --check。新增 5 项普通测试和 12 项真实 MySQL 测试；关键重试、同 Key 不同请求及并发提交均通过。
- 未执行生产部署、真实代理断网或进程崩溃演练；提交确认异常通过真实 MySQL 事务外层故障注入验证。没有自动清理/后台事实核对作业或新业务端点。Admin 既有大包提示与安装时忽略 @scarf/scarf 脚本提示仍存在。

## 2026-10-30：M0 完整集成测试（现有实现范围）

- 新增 database/m0-integration.test.ts，使用真实 HTTP 登录串联 Auth、Authorization、统一响应/DTO 与 Audit；逐响应对照当前 OpenAPI 的状态、必填字段、字段白名单、类型、列表和错误结构。覆盖同一 JWT 的授权新增/撤销、刷新后仍无权限、登出后旧新 Access Token 均失效，以及认证成功审计的精确 requestId 关联和凭据不落快照。复用全部既有约束、并发、回滚、故障与幂等测试，不重复新增生产实现。
- 根目录增加 `pnpm test:m0`，顺序执行普通测试与全部数据库测试。CI 增加独立隔离 MySQL 8.4.7 / Redis 8.2.2 作业，明确在临时空库执行已审查迁移与字典 seed，然后运行相同命令；未实际触发远端 CI。覆盖清单、执行条件与未完成能力见 [M0 集成测试验收](m0-integration-tests.md)。无 schema/Migration 或依赖版本变更。
- 冻结锁安装首轮因无 TTY 中止；交互重试在重建依赖目录时长时间无输出，停止后将原目录移至忽略的 `.tools/m0-node-modules-backup`。受限环境离线缓存不完整且普通网络请求 EACCES；获批权限重试后成功复用缓存的 477 个锁定包。初次类型检查发现 Swagger 内部类型路径不属于公开 exports，改为公共入口类型导入后通过；未放宽 strict 或 lint。
- 最终实际通过：冻结锁安装、Prisma generate/validate、lint、typecheck、build、`test:m0`（API 普通测试 24 / Admin 1 / 真实 MySQL 31，全部零失败零跳过）、编译后 API smoke、OpenAPI 导出和迁移 SQL 静态审查。本地 MySQL 8.4.13 SELECT VERSION() 与 Redis PING 通过；无自动建库、启动服务或本地迁移操作。
- 边界：只验收已有 M0 能力，不宣称负责人初始化、自授防护/最后负责人管理写接口或后台核对作业已实现。未执行全新库/历史库升级、备份恢复、真实断网/进程崩溃、生产验证和远端 CI。保留 Admin 既有超过 500 kB 的产物提示及 @scarf/scarf 构建脚本忽略提示。
