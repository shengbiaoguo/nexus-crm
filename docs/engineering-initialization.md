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

## 2026-10-30：M1 开发准备（仅文档）

- 阅读项目规则、需求/API/权限/数据模型、全部 ADR、M0 Prisma Schema、NestJS 模块及现有数据库/集成测试；新增 [M1 实施计划](plans/m1-implementation-plan.md)，含前置核查、14 个候选模型、分批增量 Migration、追踪矩阵、18 项任务的依赖/验收/测试与 53～82 人日估算。只补文档，不注册 Controller、不新增业务代码、Schema、Migration 或真实身份数据。
- 定点补充 API §9、数据模型 §11、权限 §9、需求 §13.1 与审查修订记录，修正 follow_ups 的 M1/M3 阶段不一致及“下一步生成初始迁移”的过时说明。保留历史 ADR 和已应用迁移；BR-001～010 原文逐行与当前 HEAD 核对一致。
- 识别 M0 业务授权范围/写锁、受控身份准备、后台核对、新建自增实体与幂等审计目标的适配缺口，以及 M0 整库十表断言在新模型引入时的演进需求；逐项设为前置任务。未把已有 M0 测试视为这些能力已经完成。
- DC-001 的设计基线仍有效，M1 销售对象与写入实现尚未验收；DC-005/010 技术契约补齐但未关闭，业务未决事项 D-01～08 明确登记，没有选择审批门槛、税折/舍入、有效期、证据形式或批量交接语义的默认答案。本轮未推翻现行 Accepted ADR，无需新增 superseding ADR。
- 实际通过：冻结锁离线安装（复用此前安装所需的缓存访问权限）、lint、typecheck、build、test:m0（API 普通 24 / Admin 1 / MySQL 31，零失败零跳过）、编译后 API smoke、OpenAPI 导出。文档检查通过 BR 原文、本次文档 32 个相对文件链接、围栏、18 项依赖无环及人日求和；临时校验脚本位于忽略的 artifacts，不作为生产或业务代码提交。
- 本轮没有运行任何新 Migration、建库/系统服务安装、账号 bootstrap、M1 业务测试、备份恢复、生产验证或远端 CI；既有 Admin 大包提示与 @scarf/scarf 脚本忽略提示仍存在。下一轮须明确选择任务并先满足对应门禁，本轮到计划交付即停止。

## 2026-10-30：M1 前置基础能力修复

- 用户授权仅修复五项前置缺口；复用现有 NestJS/Prisma/Authorization/Audit/Idempotency。新增固定销售 action/scope Policy、同事务对象 guard 及身份锁协调；新增首位 business_owner 的安全 Bootstrap、有界 command_attempts 核对入口和 createsEntity 审计适配。未创建 Customer/Order 或其他 M1 业务模型/Controller，无 schema、Migration、依赖版本或 Accepted ADR 决策变更；原有未提交的 M1 准备文档修订保留。
- 销售对象由服务端 resolver 使用传入 tx 读取权威根，授权前不调用数据读取回调；TEAM 查询真实用户/有效部门关系，停用路径和环路失败关闭。WriteLockService 只允许注册的交互事务，用户→角色→部门按数值 ID 取锁，重验目标集合；不伪造不存在的订单行锁。订单适用操作、后续客户/订单/子记录接入边界详见 [基础能力与文件清单](m1-foundations.md)。
- Bootstrap 需要显式参数和有界 UTF-8 JSON 标准输入，密码无默认值、保留空白且拒绝纯空白，使用现有 scrypt；只建新账号和既有未改动的负责人角色关联，已有或已停用负责人均阻止重跑。预写 STARTED，账号/角色关系/真实成功审计/尝试成功同事务；CLI 限本地非生产。未执行真实账号初始化；实库测试仅创建、验证、清理随机夹具，拒绝删除既有负责人来满足测试条件。
- 核对每批至多 100 个超时 STARTED/UNKNOWN，游标推进，短事务锁 attempt，联合合法幂等完成摘要与同次审计/真实结果引用核对；不匹配保持 UNKNOWN，不自动重执行业务或清理记录。未给 HTTP 进程加 timer、安装服务或计划任务；部署需由运维明确接入并保存游标。
- 创建命令保留稳定 entityId=new 的 v1 请求指纹，AuditLog 记录事务内生成的真实 ID，attempt.resultRef 保留结果关联，成功/重放/提交确认丢失路径均一致。现有非创建指纹黄金测试不变；没有提前插入业务实体或制造迁移来绕过自增 ID。
- 实际最终通过：Node 24.22.2/pnpm 10.34.9 冻结锁离线安装、lint、typecheck、build、test:m0（API 普通 28 / Admin 1 / 本地 MySQL 39，零失败零跳过）、编译后 API smoke、OpenAPI 导出、Prisma validate 和迁移 SQL 静态审查。新增普通测试 4 项、真实数据库测试 8 项，覆盖授权/锁竞争/并发创建/真实审计目标/回滚/丢失提交确认/证据核对/Bootstrap 并发及故障；CLI 无显式授权或非法游标会安全拒绝且不打印标准输入。
- 本地 MySQL 8.4.13 SELECT VERSION() 与 Redis PING 通过；实际调用 audit:reconcile --after-id=18446744073709551615 返回 examined=0/nextCursor=null，不更改既有尝试。正常核对修改路径在精确 attemptIds 限定的随机实库夹具中验证。生产、远端 CI、真实进程崩溃/代理断网、全新/历史库迁移与备份恢复未运行，未宣称已验收。
- 残留边界：Customer repository/列表 SQL、完整订单锚点与跨业务竞争、身份管理写接口/自授/最后负责人、部署调度与生产 Bootstrap 接入仍需对应后续任务；DC-005/010 等业务未决门禁未绕过。Admin 既有大包提示和 @scarf/scarf 构建脚本忽略提示仍存在。本轮完成后停止，不启动 Customer 模块。

## 2026-10-30：T04 CRM 持久化批次 A

- 沿用现有 Prisma 7 / MySQL 8.4 / adapter-mariadb，未换版本或重复初始化 M0。增加五个 CRM 模型及 `20261030090155_m1_crm`；生成 SQL 在应用前补充显式 collation、主联系人 STORED 生成列和四个 CHECK，原因及最终映射见 data-model §12.4。
- 原配置只有 dev，本次在明确会话授权后创建独立 shadow、空库、历史 M0 升级库，未重置原库或启动服务。Prisma config 增加可选 SHADOW_DATABASE_URL，示例只放占位符；生成辅助列在客户端忽略，实库及迁移 replay 的 Schema diff 均为空。
- 开发库真实 MySQL 44 项、空库/历史库各 11 项通过，历史行摘要和 checksum 保持；冻结锁安装、Prisma validate、SQL 审查、lint/typecheck/build、普通 API 28/Admin 1、编译后 smoke/OpenAPI 通过。完整证据与未运行边界见 [T04 记录](t04-persistence.md)，未执行 T05～T07、生产或 Git Commit。

## 2026-10-30：T01 最小受控身份管理

- 复用既有首位负责人 Bootstrap，不改 Schema/迁移/seed；增加显式无角色员工创建模式，复用 scrypt 与系统审计，不自动创建真实账号。增加角色替换、停用及供版本化命令使用的最小管理状态读取，不开放完整身份/部门/模板编辑。
- 复用同一 Database/Auth/Idempotency 注册对象、固定身份权限、审计、错误及写锁；写锁计划允许预声明新增角色和受保护角色 UPDATE 模式，其余默认 SHARE 不变。保护真实角色授权、禁止自授、最后负责人、事务内重验、撤权后重放及审计失败回滚均有实库证据。
- 数据库测试文件顺序运行以隔离 Bootstrap 的全局前置，测试内部真实事务仍并发。冻结锁安装、lint/typecheck/build、API 31/Admin 1 普通测试、MySQL 54 项、编译后 smoke/OpenAPI、Prisma validate、M0/M1 SQL 审查通过；未应用新迁移或提交 Git，详见 [T01 记录](t01-identity.md)。

## 2026-10-30：T05 固定销售范围与真实 CRM 写锁

- 复用已有 Policy、Authorization、Audit/Idempotency 和同一个数据库模块，新增内部 SalesAccessService / SalesWriteService / crm-target；没有 CRM Controller、业务状态 Service、Schema、Migration、seed 或依赖版本变化，保留 T01/T04 原有工作树修改。
- 客户/商机 SQL where、列表/count/摘要详情同一 RepeatableRead 快照；联系人/跟进按真实父链限定当前客户范围。TEAM 完整检查有效祖先链，修复命中 actor 部门后仍需检查更上级状态的边界；未知动作和错误 action/scope 配对拒绝。
- 预声明用户/角色/部门/客户及 Opportunity→Contact→FollowUp 锁，所有写方在同一 ReadCommitted 事务内当前读、重验完整集合；AuditService 增加显式隔离级别记录/断言。订单表尚不存在，实际订单锁和来源链留 T13，未造占位表或空实现。
- 冻结锁安装、Prisma validate、M0/M1 SQL 审查、lint/typecheck/build、API 33/Admin 1 普通测试、真实 MySQL 69 项、编译后 smoke/OpenAPI 通过；写入口收紧后另复验 15 项实库专项通过。首轮 lint 未使用导入和部门夹具清理顺序失败均已修复，约束未放宽。文件、限制、真实并发证据及未执行项见 [T05 记录](t05-sales-access.md)；无自动 Git Commit。下一步先补 T03 审查，再满足 T06 完整门禁，本次停止。
