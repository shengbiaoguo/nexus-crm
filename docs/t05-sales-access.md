# T05 固定销售范围与 CRM 写锁

日期：2026-10-30（Asia/Shanghai）。依据 M1 计划 T05、requirements DC-001 / §14、permission-matrix §4/9/10、data-model §12 和现行 ADR-001/003/004/005。T01、T04 的源码、真实测试及三份 Migration 已核对；D-06/D-08 已批准，D-01～05/07 保持未决。T05 的范围与锁基础不替这些业务决策定案。

本次在既有 AuthorizationModule 中导出内部 `SalesAccessService`、`SalesWriteService`，复用同一 Database/Auth/Audit/Idempotency 注册对象；没有 Customer/Opportunity Controller、业务状态 Service、React 页面或新增 OpenAPI 路由。原固定 Policy、身份重验、幂等和审计继续复用。

## 固定范围与真实查询

- action 和 scope 必须同条 grant 匹配，合法分支取并集；角色名、创建人、商机 owner、跟进 author 不额外授予权限。SELF_COLLABORATOR 为 owner=actor 或 CustomerMember.userId=actor；TEAM 取当前客户 owner 的有效部门及其祖先路径；ALL 只对其配对动作有效。CATALOG 单独用于 product:read/manage，不可用于客户对象；ASSIGNED_PROJECT / FINANCE_RELATED 没有当前关联实体时默认拒绝。
- TEAM 使用有界的完整部门树（最多 1000 节点），每条路径从节点到根全部 ACTIVE 才有效。无部门、失效祖先、缺失节点不授予 TEAM；检测环返回安全 503。修复了旧对象 guard 在已命中本部门后未撤销无效上级链结果的边界；SQL predicate 与对象 guard 共用同一算法。祖先、其他分支不误算为下属；ALL 无需计算无关 TEAM 路径。
- `SalesAuthorizationService.customerWhere(tx,identity,action)` 返回服务器构造的 Prisma CustomerWhereInput。SELF 分支通过 owner_id / members EXISTS，TEAM 分支通过 owner.department_id 集合；未知/错误配对动作先返回 403，不读取对象正文。调用方只能将业务过滤条件与其 AND，不能以客户端条件替换或 OR 放宽。
- `SalesAccessService` 实际查询 Customer / Opportunity 的分页列表、count 和摘要详情，以及 Contact / FollowUp 的嵌套摘要。列表和 count 使用同一 where、同一 RepeatableRead 授权快照；不是取出全表后内存过滤。页码 1～1000000、pageSize 1～100，固定 created_at desc / id desc，子对象 SQL 同时限制父 ID 和当前客户 scope。
- 无动作 grant 为 403；不可见对象、缺失对象、父子错配统一 404。内部摘要只选明确字段，不读取电话/邮箱/跟进正文，不返回额外账号资料；BigInt 保留内部数据库类型，后续 HTTP DTO/响应仍由 T06/T07 依既有约定转字符串。

## 写计划与事务协议

`SalesWriteService.plan` 只接受 customer:update、customer:assign、opportunity:create、opportunity:update 四个当前 CRM 对象写动作；只读动作、catalog、未知动作均拒绝。固定 Policy 中报价/订单 action 的范围映射仍保留，但没有相应持久化时不伪造对象解析或锁查询。

计划通过授权快照解析实际 Customer/Contact/Opportunity/FollowUp 父链，绑定 actor/session/cv，并保存不可变服务器目标、客户当前 owner/成员、完整相关用户、角色/部门锁和当前组织/成员集合。一次计划处理一个客户及其显式已有子记录；不据此决定 D-07 批量事务语义。最多 100 个目标和沿用 100 用户锁容量，成员超出安全解析/锁容量返回 503，不截断成员列表，不定义新的业务协作人数上限。

| 顺序 | 锁对象与模式                                                      | 重验 / 责任                                                                                                |
| ---- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 0    | 幂等 Key 唯一键                                                   | IdempotencyService 先争 Key，STARTED 在独立短事务预写                                                      |
| 1    | 全体相关 User，SHARE；显式声明需更新的用户用 UPDATE，各 ID 升序   | actor、当前 owner/协作者，以及调用方预声明的新目标用户；传给 IdempotencyService.userLocks 和同一身份锁计划 |
| 2    | 相关 Role SHARE，预声明排他角色时 UPDATE，各 ID 升序              | 复用 WriteLockService；角色成员撤销锁 User，权限/scope 替换锁 Role，管理写方须遵循同协议                   |
| 3    | 有界完整 Department 树 SHARE，各 ID 升序                          | 组织调整写方取得对应 UPDATE；持锁重验用户部门、UserRole 成员、部门 ID/parent/status 集合                   |
| 4    | 当前 Customer UPDATE                                              | 所有归属/协作变更和该客户 CRM 写互斥；持锁后重查当前 scope、owner/成员                                     |
| 5    | 已有 Order UPDATE（确实涉及订单时，T13 接入）                     | 当前无 orders 表，不执行缺表 SQL、不造空锁实现、不创建占位表                                               |
| 6    | Opportunity → CustomerContact → FollowUp，均 UPDATE，各类 ID 升序 | 跟进目标自动纳入所属 Opportunity；调用方必须在计划前列出完整已有子记录，不能持子锁后追加父锁               |

`acquire` 只接受 AuditService 注册且明确指定 **ReadCommitted** 的同一交互事务。AuditService 新增可选隔离级别断言，并跟踪其实际传入 Prisma 的事务选项；不凭 `$transaction` 属性或 session 默认隔离变量伪称已验证事务类型。既有调用不要求新断言时行为不变。

加锁后重新读取真实父链、当前动作/客户范围与计划集合：失权/不可见按 401/403/404 拒绝；仍可见但 owner/协作/部门/角色集合变化则 409，完整回滚后重新计划，不逆序补锁。子对象已移到不可见客户时统一 404。计划不包含业务 version，不能把旧 expectedVersion、归档/终态规则放进幂等重放授权；这些首次执行业务约束仍由 T06/T07 的 execute 回调实现。

新建客户另有 `planCreation/acquireCreation`：只验证 customer:create 有效 grant，身份锁内重验并返回 actor ID；尚未生成的客户没有伪造的行锁。创建资格不隐含 customer:read，不接受客户端 owner 身份。Catalog 仍走独立 action/scope guard，等待 T08 目录持久化。

接入现有幂等组件时：每请求先生成新计划；传入 plan.identity.users；authorize 的 preflight 调 `requireTargets`，transaction 调 `acquire`；execute 在同一 tx 校验状态、版本、职责分离并写业务。成功业务+成功审计+SUCCEEDED+幂等结果仍原子提交，未知提交/回滚沿用 ADR-003/005。测试以随机 CRM 行更新验证这一组合，不发布业务命令或交接接口。

## 本次验证与失败记录

本地目标沿用本会话已授权的 127.0.0.1 开发/测试库 nexus_crm；执行前重新确认 MySQL 8.4.13 只读查询和 Redis PING。没有创建数据库、启动服务、重置、迁移写入或生产访问。随机夹具只操作自身 User/Role/Department/CRM 及审计/幂等数据；不修改 seed 模板或实际账号。

| 检查                                 | 实际结果                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Node / pnpm / frozen-lock 离线安装   | 24.22.2 / 10.34.9，显式复用 F:/.pnpm-store，通过；锁文件无变更                                                                        |
| lint / typecheck / build             | 通过；Admin 保留既有大于 500 kB 产物提示                                                                                              |
| `pnpm test`                          | API 33 / Admin 1 全部通过，零失败/跳过；本次新增 2 项普通测试                                                                         |
| `pnpm test:db`                       | 真实 MySQL 69 项全部通过，零失败/跳过；原 54 项保留，本次新增 15 项                                                                   |
| T05 专项                             | 首轮 16 项中 15 通过、1 在夹具清理时失败；修正后 16/16 通过；新增协作竞争用例纳入全量 69 项；写动作入口收紧后另复验全部 15 项实库专项 |
| `pnpm smoke` / `pnpm openapi:export` | 编译后 health/docs/OpenAPI 通过，无 DB/Redis 依赖；CRM 路由未开放                                                                     |
| Prisma validate / M0、M1 SQL 审查    | 通过；实库回归校验三份历史 Migration checksum、M0/CRM 表/FK/CHECK/collation                                                           |
| `pnpm services:check`                | 本地 MySQL/Redis 只读检查通过                                                                                                         |

首次 lint 发现测试未使用导入，已移除。首轮实库失败发生在随机部门夹具更改父链后的清理顺序，RESTRICT 正确拒绝删除：已对只属于本次用例的节点解除自身链接后清理，保留全部数据库约束；遗留四个随机部门经逐 ID、名称、时间、零用户引用和内部子节点检查后清除。修正后专项及全量回归通过；未删除实际业务数据或为通过测试调整约束。

15 项真实 CRM 用例覆盖：SELF/协作/TEAM/ALL 列表及详情/count、一致性分页；上下级/同级/跨团队/空部门/失效祖先/环；多角色不串用、角色名称不授予权、CATALOG 配对及未知/财务/交付范围拒绝；同一次列表与 count 之间已提交归属变化仍保持快照；角色范围撤销、同身份会话撤销；真实子父链与迁移后不可见子记录拒绝；仅允许明确 ReadCommitted、真实服务器计划和正确 tx；创建资格不授予读取；owner/成员/部门/祖先/角色计划变化回滚；成功 Key 在当前移交/撤权后不可越权重放；审计故障回滚真实 CRM 更新和 Key；客户写与归属/协作变更串行；User/Role/Department 更新竞争；反向输入子记录时通过真实行锁等待及 Prisma query 观测验证固定跨类顺序、类内 ID 排序。

范围测试中的角色替换、组织变更、客户归属/成员变化是精确随机夹具的数据库竞争操作；用于证明双方遵循锁协议后的授权行为，不代表已经实现 T09 管理 API、D-07 目标资格或 T06/T07 状态命令。T01、M0 以及 CRM 原有测试全部回归。

## Migration、文件与后续门禁

本次 **无新 Migration、无 Schema/seed/依赖版本变化**；启动时已有 T01/T04 未提交改动全部保留。未运行远端 CI、生产部署、备份恢复、真实进程崩溃/代理断网、生产规模性能或 EXPLAIN 评估，不将静态检查冒充这些结果。

- 新增：`apps/api/src/authorization/crm-target.ts`、`sales-access.service.ts`、`sales-write.service.ts`。
- 修改：`apps/api/src/authorization/sales.policy.ts`、`sales-authorization.service.ts`、`authorization.module.ts`；`apps/api/src/audit/audit.service.ts`（可选隔离级别断言）。
- 测试：新增 `apps/api/test/sales-access.test.ts`、`apps/api/test/database/sales-access.test.ts`。
- 文档：本记录、`docs/plans/m1-progress.md`、`docs/authorization.md`、`docs/permission-matrix.md`、`docs/api-design.md`、`docs/data-model.md`、`docs/m1-foundations.md`、`docs/engineering-initialization.md`。

本任务的已落库 CRM 授权与锁验收完成。报价/订单真实父链、订单共享行锁、审批职责分离/金额门槛在相应持久化与 T13～T16 接入，不提前创建表或放行。D-07 协作资格/批量交接仍未决定；业务 HTTP、查重、归档、主联系人切换和商机状态/跟进追加仍留 T06/T07。

下一项已具备执行前提的是 **T03 剩余窄适配审查/签收**（无业务表依赖；实现测试已具备但进度仍待审查）。T06 的 T04/T05 条件已满足，仍须先关闭 T03 审查；不能据本轮复用其实现就代为签收。T02 专项也维持独立可执行状态。本次停在 T05，不执行这些任务，不自动 Git Commit。

建议 Commit：`feat(authorization): add fixed sales scopes and write locks`。
