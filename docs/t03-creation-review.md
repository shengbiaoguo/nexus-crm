# T03 新建实体幂等/审计窄适配审查

日期：2026-10-31（Asia/Shanghai）。审查主体为本次 T03 执行者；结论为窄适配工程审查与本地验收。依据 M1 实施计划 §4.2/T03、requirements DC-001/INV-006、api-design §1.4、data-model §5.1、permission-matrix §4.2 和 Accepted ADR-001/003/004/005；ADR-002 为已被替代的历史记录。本记录不代替生产发布审批。

T03 无业务表/未决 D 项依赖。D-06/D-08 已批准，D-01～05/07 保持未决。本轮核对当前源码、测试、三个 Migration 及 Git 工作树：既有 createsEntity / createdEntityId 创建适配已具备，并已有 User 创建并发、审计回滚和提交确认丢失恢复测试；本次补工程审查记录、负向覆盖和结果校验，不重复实现原组件或首位负责人初始化。

## 审查结论与证据

| 审查点         | 最终实现与判断                                                                                                                                                                                                                                                  | 验证证据                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 稳定请求目标   | 创建固定 createsEntity=true、entityId=new；entityType/operationId/路径 targets 由服务器定义，父 ID 进入 targets；生成 ID 只在业务 tx 内创建后取得                                                                                                               | 普通指纹测试；真实 Contact 同 Key 并发一次插入，DTO/父对象变化 409                            |
| v1 兼容        | 沿用 actor 固定 scope、原 canonicalJson/prepareCommand、fingerprint_version=1，不把生成 ID/Key/requestId 加入 hash；normal 命令的指纹与结果引用路径不变                                                                                                         | 原 v1 黄金 SHA-256 测试及全部 M0 回归；新创建请求的 Key/requestId 变化不影响 hash             |
| 严格创建结果   | 201，摘要白名单包含规范 BIGINT UNSIGNED 字符串 id；不接受 Number、0、前导零、超范围 ID 或缺失 ID                                                                                                                                                                | 3 个新增普通测试；错误结果在真实插入后触发整事务回滚，Key 可显式重试                          |
| 原始上下文保护 | IdempotencyService 覆盖回调提供的上下文，只允许 before/after 审计摘要；AuditService 仍以原 actor/systemActor、requestId、type、new 目标、operationId、attemptId 和 STARTED/UNKNOWN 状态匹配尝试；createdEntityId 只改变成功 AuditLog.entityId，不改预写尝试目标 | 实库逐项错配拒绝；故意吞掉审计错误仍由已注册 tx 的失败标记阻止提交                            |
| 真实审计链接   | AuditLog.entityId=真实新 ID；CommandAttempt.entityId=new，resultRef=entityType:真实新 ID；IdempotencyRecord 保存同一 201 标量摘要                                                                                                                               | 查询真实 Contact / AuditLog / CommandAttempt / IdempotencyRecord 验证完整一致性、一次成功审计 |
| 原子性与失败   | 复用 Key→用户→角色→部门→客户等既有锁；业务/成功审计/SUCCEEDED/完成结果同 tx，失败回滚；失败 Key 释放，不自动执行第二次回调                                                                                                                                      | 新创建结果校验、显式业务拒绝及原审计故障测试；失败后的同 Key 显式重试成功                     |
| 当前授权       | preflight 和持锁 transaction 阶段重验当前动作、父客户范围和身份；回放旧成功不绕过角色撤权、归属转移、cv 变化                                                                                                                                                    | Contact 创建后用原命令/Key 撤权重放 403、转移父客户后 404、cv 改变后 401，无新插入            |
| 提交未知恢复   | 独立 client 争原 Key，读取已提交结果生成原 resultRef；原 SUCCEEDED 不降级，无结果时沿用既有 UNKNOWN/FAILED 核对协议，不自动再创建                                                                                                                               | 真 MySQL 提交后注入确认丢失，独立 client 恢复同一新 ID，execute 只调用一次                    |
| 损坏持久化证据 | 普通重放、恢复（包括已 SUCCEEDED 分支）和核对器消费 new 结果均要求相同 201/ID 契约；损坏记录保留待核实，不能返回伪成功或重新插入                                                                                                                                | 普通重放坏状态码/缺 ID/非规范 ID、提交后坏状态码恢复；核对器精确 attempt 白名单用例           |

可信执行回调负责实际插入并返回其生成 ID；通用适配器不按任意 entityType 动态猜表、查询业务存在性或创建通用 registry。审批、金额、客户去重、联系人上限/设主等领域约束仍在各业务命令首次执行时验证。本轮 Contact 是随机持久化夹具，无新的客户/联系人业务 Service、Controller 或 React 页面。

## 本轮发现及修复

1. 旧检查只要求 createsEntity=true 时 target 为 new，漏掉 new 但未启用适配的服务器误配置。现在将 new 保留为显式创建标记，两个配置必须一起出现，数据库访问和尝试预写前就拒绝不匹配，避免创建成功却把 new 当真实审计 ID。
2. 旧 201 校验仅覆盖首次执行；重放/恢复没有一致检查已存创建状态码，恢复在尝试已 SUCCEEDED 时还会跳过结果引用校验。提取 `creationResultId`，首次、普通重放和所有恢复分支统一校验。非法首次回调结果导致事务回滚并返回既有安全 503；无法核实的已完成创建结果返回 `IDEMPOTENCY_RESULT_UNKNOWN`，保留原成功事实，不自动修复或重做。
3. 已有尝试核对器消费 new 目标时原先使用通用成功状态范围。该窄分支现在复用同一创建校验，避免把 HTTP 200 的损坏创建证据当作合格完成结果。用例仅访问显式随机 attempt 白名单；未运行后台全库作业、增加调度、清理或完成 T02 的多执行器等剩余专项。

创建结果白名单仍只含标量 ID/状态/版本等。生成 ID 的校验发生于白名单投影后，不能从未保存的原始响应或客户端元数据伪造引用。`createdEntityId` 和 `resultRef` 的相互对应、旧 actor/request/attempt 状态检查及审计失败事务中毒保护保留；没有削弱断言、隔离级别或锁等待约束。

## 持久化与兼容性

**无新 Migration，无 Schema/seed/依赖版本变化。** 既有 CommandAttempt.entityId/resultRef、AuditLog.entityId/attemptId 和 IdempotencyRecord.responseBody 足以分离稳定请求目标与真实结果目标；无需 E 批次新增列、历史回填或迁移文件。原三份 SQL 不改写、未重新应用；实库回归核对 M0/CRM 表、FK/CHECK/collation 和历史 checksum。

本次使用此前已授权的本地 127.0.0.1 开发/测试库 nexus_crm，先复查 MySQL 8.4.13 只读连通及 Redis PING。没有创建库、启动服务、执行 reset/db push/手工 DDL 或修改生产数据；所有新增数据为随机 User/Role/Customer/Contact/Session 及其平台夹具，按精确 ID/范围清理。没有运行用户身份 Bootstrap 或创建真实员工账号。

启动核查时 HEAD 为 `5fc7049`（infra completed），已有用户暂存的 T01/T04/T05 产物；交付核查时 HEAD 已推进至 `1c6ebf1`（feat(authorization): add fixed sales scopes and write locks），这些前置产物已进入提交。本执行过程没有调整暂存区或执行 Git Commit，T03 改动仍在工作树。

## 实际验证

| 检查                               | 结果                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| Node / pnpm / frozen-lock 离线安装 | 24.22.2 / 10.34.9；显式复用 F:/.pnpm-store，通过，锁文件无变更              |
| Prisma validate / M0、M1 SQL 审查  | 通过；无 Migration 执行                                                     |
| lint / typecheck / build           | 通过；Admin 保留既有大于 500 kB 产物提示                                    |
| 普通自动化测试                     | API 36 / Admin 1 全过，零失败/跳过；新增 T03 3 项普通测试，旧 v1 黄金值保持 |
| 真实 MySQL 全量集成测试            | 77 项全部通过，零失败/跳过；新增 T03 8 项实库用例，保留原 69 项             |
| 编译后 smoke / OpenAPI 导出        | 通过；health/docs/OpenAPI 不依赖 MySQL/Redis；没有新增 CRM 路由             |
| 本地服务只读检查                   | MySQL 8.4.13 和 Redis PING 通过                                             |

前置专项首轮 9 项（3 普通 + 6 实库）全部通过；其后补恢复已 SUCCEEDED 时的坏状态码证据，以及核对器消费创建契约的兼容用例，再执行最终检查。真实提交已发生，异常只注入提交确认边界；没有把注入异常测试称为真实代理断网/进程崩溃演练。

未运行远端 CI、生产部署/初始化、备份恢复、真实网络/进程故障、T02 全量运维作业。其余业务 HTTP、角色/交接资格和报价/订单业务状态验收仍按原任务，不把本次夹具测试视为 T06/T07 完成。

## 文件与门禁结论

- 修改：`apps/api/src/idempotency/idempotency.contract.ts`、`idempotency.service.ts`；`apps/api/src/audit/attempt-reconciliation.service.ts`（仅 new 创建结果消费校验）。
- 新增测试：`apps/api/test/creation.test.ts`、`apps/api/test/database/creation.test.ts`。
- 文档：本记录、`docs/plans/m1-progress.md`、`docs/idempotency.md`、`docs/m1-foundations.md`、`docs/api-design.md`、`docs/engineering-initialization.md`。

T03 窄适配工程审查和本地验收完成后，T03/T04/T05 与 D-06/D-08 门禁均满足，下一项可执行任务为 **T06**。T02 剩余专项、T00 的 D-01～05/07 与其他业务任务状态保持。本次完成 T03 后停止，不执行 T06。

建议 Commit：`fix(idempotency): enforce audited entity creation contracts`。
