# M1 前置基础能力补齐（2026-10-30）

后续 T05 已完成真实 CRM SQL 范围与写锁，见 [T05](t05-sales-access.md)。下文保留最初无 CRM 表时的前置实现/夹具记录；T04 的五表现已落库，T05 使用真实 Customer/Member/Contact/Opportunity/FollowUp 验证，未以 User 投影代替新验收。当前导出的 SalesAccessService / SalesWriteService 及其边界、隔离级别断言和完整锁表以 T05 记录为准。

本轮只扩展既有身份、授权、审计、幂等及受控运维入口。没有 Customer/Order 模型、业务 Controller、新数据库结构、Migration、额外依赖或 Redis 权威数据。现行 ADR-001/003/004/005 不变，ADR-002 仍为历史。

## 1. 销售对象授权

AuthorizationModule 导出 `SalesAuthorizationService`。固定 action/scope 映射在 `sales.policy.ts`，包括销售读写、审批/分配和目录，不接受通配符/管理员身份旁路。动作和 scope 必须来自同条授权；SELF_COLLABORATOR 不用于分配/审批，CATALOG 不用于销售对象，尚无实体关系的 ASSIGNED_PROJECT/FINANCE_RELATED 默认拒绝。

`withObjectRead(identity,action,resolve,read)` 在一个 RepeatableRead 事务内重验会话/凭证版本/当前有效角色，通过授权后才调用 read。resolve 是**服务端 repository 函数**：使用传入 tx 读取目标→父对象→当前客户根，返回权威 ownerId/collaboratorIds 或 null。它不是请求 DTO、前端过滤器、客户端 scope 或授权结果缓存。不存在/不可见/错误父子链返回 404；无动作权限 403，失效身份 401。

TEAM 使用当前 actor/owner 的 User.departmentId 和有效部门祖先关系，读取真实 M0 身份/组织数据；无部门、停用路径不授予 TEAM，路径环路失败关闭。组织最多 1000 个节点，超过范围返回安全 503，不截断后授予。当前小企业组织采用有界全树读取，不引入部门闭包表或策略引擎。

写命令的 preflight 和 transaction 回调调用 `requireObject`；后者必须先取身份及业务锁，直接使用调用方的 ReadCommitted tx。`AuthorizationService.inTransaction` 复用身份/grants 读取，不另开事务。新建客户资格/目录使用 `requireCreationOrCatalog`；该能力不等于允许客户端指定负责人。

**尚无 Customer 表，故没有客户 repository、列表 SQL 或销售 HTTP 路由。** 新模块必须实现可信 resolver、完整父子关联和数据库列表 where（含 count），不得先查全量再内存过滤；不能把本轮对 M0 权威关系的实库测试当作客户 API 已验收。审批金额门槛/职责分离仍在实际业务 Service 接入，本轮不发明门槛。

## 2. 跨模块写锁

`WriteLockService.plan(tx,identity,relatedUsers)` 在业务事务前解析全体相关用户、其角色以及有界组织树。用户模式 SHARE/UPDATE 在开始前显式声明；传给 IdempotencyService 的 userLocks 必须与同一计划的 users 一致，不能遗漏当前负责人、移交目标等未来业务相关用户。

`acquire(tx,identity,plan)` 只接受 AuditService.withTransaction 注册的精确交互事务（IdempotencyService 已使用此入口），拒绝 root client；同一事务只能完整取得一次。锁顺序为用户数值 ID 顺序（预定 SHARE/UPDATE）→角色 ID 顺序 FOR SHARE→部门 ID 顺序 FOR SHARE。随后重新查询目标集合，角色/部门集合变化返回 409 VERSION_CONFLICT，调用方完整回滚、重新解析后按原 Key 再尝试，不逆序补锁或在后续层升级用户锁。

当前选择锁整个至多 1000 节点的组织树，角色成员关系读取也有 1000 项上限；不会无界遍历。授权/部门管理写方仍需在相同等级取得对应排他锁：成员变更锁目标用户，权限/角色状态变更锁角色，组织调整锁相关部门/父节点。该 helper 保护业务命令的身份授权读取，不自动开放任何角色/用户/部门编辑接口，也不代替其自授/最后负责人规则。

后续业务层继续按客户→已有订单→子记录取锁，并在同 tx 当前读取动作、对象范围、版本、状态、职责分离。`plan` 只解析身份层，业务归属改变也必须锁客户/订单并重验；不能认为取得用户/角色锁就拥有订单写许可。

### ADR-001 的订单适用操作

| 订单相关操作                                     | 必须遵守的协议                                                 | 本轮状态                               |
| ------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------- |
| submit/approve/reject/withdraw、草稿编辑         | 授权锁→客户→同一 orders 行→轮次/明细；事务内重检版本/轮次/状态 | 未建 orders；此处明确后续接入约束      |
| 启动交付 vs 取消批准                             | 共用 orders FOR UPDATE；重查从未启动/待决取消/首款或有效豁免   | M2/M3 实现时验证，不执行缺表 SQL       |
| 结项 vs 范围变更生效/验收有效性变化              | 共用 orders 锚点；重查当前范围与阻断条件                       | M2/M3 接入，不使用固定 false           |
| 变更/取消/终止申请的创建、撤回、拒绝、失效、生效 | 改变阻断条件的写方也先锁同一订单                               | M3 接入后重跑 M1/M2 回归               |
| 收款确认/冲正与依赖相关财务事实的订单操作        | 订单与付款行固定顺序、当前读、原子审计/幂等                    | 财务契约及真实模型建立后明确子记录锁序 |

订单仍使用真实业务状态，不为锁改成 DELIVERING。没有新增虚假的 OrderTransactionService、订单锁表或通用工作流；完整订单锁/跨模块不变量验收仍须等 M1/M2/M3 实体建立。

## 3. 安全身份 Bootstrap

新增独立 `BootstrapIdentityService` 和 `identity:bootstrap` 命令，不由应用启动、迁移、字典 seed 或 CI 自动调用。作用是从既有、未改动的 seed 模板中创建**首位 business_owner**：输入 loginName/name/password，不接受 role/scope、已有用户 ID 或自选授权。

- 先运行受审查的 M0 Migration 和受控字典 seed；role 的名称/启用状态/完整权限配对必须匹配模板，冲突拒绝，不覆盖。
- 新登录名必须不存在；已有任意 business_owner 成员（包括已停用账号）均阻止重跑。此命令不恢复账号、不替换密码，也不为已有用户提权。
- 输入严格校验，密码保留空白、长度 16～256，使用现有 salted scrypt；没有默认密码或硬编码生产凭证。操作者必须从密码管理器/秘密管理通道提供强随机密码，命令不打印它或其哈希。
- 通过标准输入传一个 JSON 对象；CLI 必须显式带 `--initialize-business-owner`，拒绝交互 TTY，最多 4096 UTF-8 字节。不要把密码放在命令行、Shell 历史、Git 或 VITE_*。
- 命令当前仅允许 localDatabaseUrl 的本地非生产数据库。生产初始化须另行评审执行环境/授权，不能临时去掉保护或复用本地凭据。
- 预写系统 STARTED，锁定受保护角色行串行化首次分配，然后同事务创建 User、UserRole、成功审计、attempt SUCCEEDED。新用户尚无既存行，角色锁后插入新行不是对既存用户的逆序加锁；后续成员调整仍从用户锁开始。
- 两次并发初始化至多一次成功；审计失败回滚账号及授权。技术/提交未知保留 UNKNOWN，操作者先核对实际账号/审计，不自动创建第二个负责人。

编译后调用 `pnpm identity:bootstrap --initialize-business-owner`，标准输入由受控秘密通道传入。本文不提供含真实密码的 shell 示例，也不自动执行此命令。T01 后另增加显式 `--create-unassigned-user` 模式，只创建新无角色员工，不覆盖/恢复账号；角色必须经受控 HTTP 分配。assign-roles/disable 和管理状态读取已完成，详见 [T01 契约与证据](t01-identity.md)；受保护模板编辑、通用身份 CRUD 及恢复仍未开放，不将本轮最小路径冒充完整身份管理。

## 4. 命令尝试核对入口

`AttemptReconciliationService.runBatch` / `pnpm audit:reconcile` 实际核对的是现有 command_attempts 的超 5 分钟 STARTED 与 UNKNOWN，关联同 scope/key 的 IdempotencyRecord 和同 attemptId/actor/systemActor/requestId/action 的成功 AuditLog。不是核对资金余额、订单、银行流水或交付。

每批至多 100 项、每项独立 ReadCommitted 短事务，先锁 attempt，数据库锁等待临时限制 2 秒，事务 5 秒；finally 恢复连接设置。持锁后重读，终态不能被旧批次覆盖。普通查询幂等记录/审计不会反向取得 Key 排他锁，避免与原业务“Key→attempt”形成锁环。

只有匹配指纹 v1 的合法完成摘要、同次成功审计及真实 resultRef 一致时才确认 SUCCEEDED；创建命令还要求完成摘要 id 与成功审计对象一致。只有完成 Key、来自另一次尝试的审计、结果已清理、证据不匹配或没有结果，都不足以断言本次成功或失败：保留 UNKNOWN。不会自动重执行业务、生成驳回、删除 Key 或清理审计。真实业务与 success/attempt 原子提交，所以正常已提交 SUCCEEDED 本来就不需修复；确认分支用于有充分证据的核对，而不是制造缺失事实。

CLI 输出仅 examined/confirmed/unknown/nextCursor，不输出响应正文、账号/Token、银行或合同数据。支持 `pnpm audit:reconcile --after-id=<上次游标>`；失败非零退出，不吞掉锁/连接错误。调度方须持久保存游标并在 nextCursor=null 时从 0 开始新轮次，否则大量 UNKNOWN 会使旧记录反复占据首批。单批失败时保留输入游标重试，已完成处理的行可安全再次核对。UNKNOWN 需人工核实，不能因扫描完成就视为处理完毕。

本轮提供**显式单次后台作业入口**，不在 HTTP 进程添加计时器、不安装系统服务、不修改计划任务。部署时可由现有任务调度器每分钟调用并正确推进游标；该调度配置未在本机启用。命令同样拒绝生产/非回环地址，生产作业接入须按发布运维流程评审。

## 5. 创建命令审计适配

2026-10-31 T03 窄适配代码审查已形成 [可追溯记录](t03-creation-review.md)：补齐 new/createsEntity 双向声明、首次/重放/恢复（含原 SUCCEEDED）及 new 结果核对的一致校验。新状态码/ID、上下文错配、真实 Contact 创建、角色/归属/cv 撤权等负向测试已补充；不新增 Schema/Migration，不改变 v1 指纹。下方保留最初适配说明；T02 其他专项仍按原进度独立验收。

IdempotentCommand 增加服务端 `createsEntity:true`，要求 entityId=`new`，固定 operationId/父对象 targets/规范 DTO 进入现有 fingerprint v1。不得每次请求随机生成目标 ID，也不得在幂等事务外预创建业务实体。既有非创建命令的 v1 指纹输入和重放语义保持不变。

首次 execute 在现有 tx 插入实体后，必须返回 201 和包含规范无符号 BigInt 字符串 id 的白名单标量摘要。AuditService 的 createdEntityId 适配仅接受 new-target、同 actor/requestId/操作/attempt 上下文和匹配 resultRef；attempt 保留原请求目标，AuditLog.entityId 写真实生成 ID，attempt.resultRef=`entityType:id`。业务写入、成功审计、结果和 attempt 成功同事务，解析/审计失败使事务不可提交。

重放与提交确认丢失的恢复只从已保存摘要恢复同一真实结果引用，不重跑 execute、不重复成功审计；仍检查当前身份和 authorize。Bootstrap 同样使用 new-target 审计适配，但不将密码放入幂等记录或指纹。没有新增表/列，故本轮无需 Migration；没有更改已应用迁移。

## 6. 验证和边界

新增普通测试 `test/foundation.test.ts`，新增真实 MySQL 测试 `test/database/foundation.test.ts`：固定配对、后台读取前拒绝、TEAM/撤权/停用/环路、锁集合变化、用户/角色排他竞争、并发一次创建、真实审计目标、失效凭据拒绝重放、审计失败回滚、创建 COMMIT 确认丢失、核对证据、首次 Bootstrap 并发/安全哈希/停用不恢复和故障回滚。

销售对象根使用测试内 repository 从 M0 User/部门 FK 投影，真实身份、角色、组织和锁均在 MySQL 验证；这不是虚构 Customer 表，也不是完整客户 API 交付。测试只清理随机命名夹具及其关联尝试/审计，不改 seed 授权。Bootstrap 成功分支测试要求获准的隔离测试库中没有已分配负责人；若已有则显式失败，**绝不删除/停用既有负责人来凑测试条件**。普通 test 不运行该实库测试。

运行 `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test:m0`、`pnpm smoke` 和 `pnpm openapi:export`；实际结果见工程初始化记录。本轮不执行生产验证、真实代理断网/进程崩溃、系统调度安装、M1 业务开发或新 Migration。

原 [M1 计划](plans/m1-implementation-plan.md) 的 T03 创建适配、T02 有界作业入口已有本轮实现；T01 只补 Bootstrap，不含后续管理写接口，T05 只补基础对象 guard/身份锁，不含真实业务表的列表过滤/锁。不得把它们全部打勾，也不得跳过 API §9 的业务未决门禁进入订单开发。

## 7. 本轮实际文件清单

| 类别         | 文件（相对仓库根目录）                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增授权     | apps/api/src/authorization/sales.policy.ts；sales-authorization.service.ts；write-lock.service.ts（同目录）                                             |
| 修改授权     | apps/api/src/authorization/authorization.service.ts；authorization.module.ts（同目录）                                                                  |
| 创建审计适配 | apps/api/src/audit/audit.service.ts；apps/api/src/idempotency/idempotency.service.ts                                                                    |
| 新增初始化   | apps/api/src/database/bootstrap-identity.service.ts；bootstrap-identity.ts（同目录）                                                                    |
| 新增核对作业 | apps/api/src/audit/attempt-reconciliation.service.ts；reconcile-attempts.ts（同目录）                                                                   |
| 新增测试     | apps/api/test/foundation.test.ts；apps/api/test/database/foundation.test.ts                                                                             |
| 命令入口     | package.json；apps/api/package.json                                                                                                                     |
| 文档         | README.md；docs/m1-foundations.md；docs/authorization.md；docs/idempotency.md；docs/plans/m1-implementation-plan.md；docs/engineering-initialization.md |

之前 M1 准备留下的其他未提交设计修订保持原样；本轮没有修改 Prisma Schema、Migration、业务需求规则、权限 seed 或依赖版本。
