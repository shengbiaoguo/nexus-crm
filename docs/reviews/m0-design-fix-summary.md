# M0 数据库设计修订总结与实施检查表

- 日期：2026-10-30
- 状态：现有设计基线汇总；新增实施建议待 Schema/SQL 评审，不代表数据库或 Migration 已实现。
- 本次范围：补齐此前缺失的审查总结文件，不修改 Schema、不生成或应用迁移、不执行 Seed 或 Git 操作。
- 保留约束：用户此前提出“先不要应用迁移”的要求仍有效。本文件的生成不自动解除该要求。

后续状态：用户于 2026-10-30 明确要求继续 M0 实施，已解除上述暂停。本文保留生成时的设计总结及检查表；实际 SQL 审查、应用和验证结果以 [M0 实施记录](m0-implementation.md) 为准。

## 1. 依据及文档效力

| 依据                                                      | 本文件采用的内容                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| [需求](../requirements.md) §3、§9                         | BR-001～010 不变；历史用户保留、可撤销会话、服务端授权及迁移要求 |
| [数据模型](../data-model.md) §1、§3～7、§8                | M0 实体、命名、类型、约束、删除及事务原则；逻辑设计不是完整 DDL  |
| [权限矩阵](../permission-matrix.md) §4、§8                | 原子权限与固定 scope、受保护业务授权、角色默认包                 |
| [ADR-002](../adr/0002-idempotency-persistence.md)         | 历史取舍；已被 ADR-005 替代，不使用其旧作用域定义                |
| [ADR-003](../adr/0003-audit-and-operational-logs.md)      | 成功审计同事务；关键尝试预写、失败独立记录及 UNKNOWN 核对        |
| [ADR-004](../adr/0004-prisma-migration-strategy.md)       | Prisma Migration、SQL 审查、兼容演进及恢复要求                   |
| [ADR-005](../adr/0005-idempotency-scope-clarification.md) | 当前幂等作用域、指纹、结果与业务原子提交、保留期及失败语义       |
| [一致性修订记录](../design-review-changelog.md)           | DC-001/008/009/011/012 已完成文档修订；不等于运行验收通过        |

本文件不新增已确认 BR，不替代现有 Accepted ADR；若实现发现文档冲突，须明确记录，不能以本总结静默覆盖。此前未决的业务审批、财务和交付细节继续按需求 §13 留待 M1/M2/M3。

## 2. M0 模型范围与必要补充

本阶段仅实现下列十个模型。CommandAttempt 来自既有数据模型 §3、§8 和 ADR-003，并非本次额外引入的流程系统。

| Prisma 模型       | 数据库表            | 核心字段（数据库命名）                                                                                                                                                            | 已有约束/关系依据                                                  |
| ----------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| User              | users               | login_name、password_hash、name、department_id、status、credential_version                                                                                                        | login_name 唯一；用户离职停用，保留历史引用                        |
| Department        | departments         | parent_id、name、status                                                                                                                                                           | parent_id 自关联及索引；部门树无环由后续受控写入验证               |
| Role              | roles               | code、name、status                                                                                                                                                                | code 唯一；角色权限修改需版本检查                                  |
| Permission        | permissions         | code、description                                                                                                                                                                 | code 唯一；字典与权限矩阵 §8 一致                                  |
| UserRole          | user_roles          | user_id、role_id                                                                                                                                                                  | 二者组合唯一，显式关联 User/Role                                   |
| RolePermission    | role_permissions    | role_id、permission_id、scope_code                                                                                                                                                | role/permission 组合唯一；动作与范围成对求值                       |
| RefreshSession    | refresh_sessions    | user_id、token_hash、expires_at、revoked_at                                                                                                                                       | token_hash 唯一；仅存哈希，不存原始刷新令牌                        |
| AuditLog          | audit_logs          | actor_id、action、entity_type、entity_id、before_json、after_json、request_id、attempt_id、created_at                                                                             | 实体/时间索引；适用关键命令关联 CommandAttempt；成功事实同业务提交 |
| IdempotencyRecord | idempotency_records | scope、key、request_hash、fingerprint_version、status、http_status、response_body、completed_at、expires_at                                                                       | UNIQUE(scope,key)，INDEX(status,expires_at)；业务结果同事务        |
| CommandAttempt    | command_attempts    | attempt_id、actor_id、operation_id、entity_type、entity_id、request_id、idempotency_scope、idempotency_key、request_hash、status、started_at、finished_at、error_code、result_ref | attempt_id 唯一；状态/开始时间及 scope/key 索引；状态见 §5         |

通用审计时间、版本号等按实体需要补充，不机械给所有关联表增加软删除列。不得提前加入 Customer、Opportunity、Quote、Order、Delivery、Payment、Refund 或其关联表。M0 权限字典可以包含未来模块的权限码，不代表创建这些业务表或启用相应接口。

## 3. 物理建模和序列化

### 3.1 已有技术基线

- Prisma 模型 PascalCase、TS 属性 camelCase；使用 @map/@@map 将数据库字段及表名映射为 snake_case。
- 单企业 MySQL 8.4/InnoDB/utf8mb4，不增加 tenant_id。Prisma 7 使用 prisma.config.ts 与匹配版本的官方 MySQL 适配器；Schema 不包含真实连接密钥。
- 实体主键建议 BigInt 对应 BIGINT UNSIGNED 自增，相关 FK 的有符号性及类型必须一致。关联表可采用组合主键或独立主键加组合唯一约束，须在 SQL 评审中明确选择。
- DateTime 使用 DATETIME(3)，应用按 UTC 写入，传输为 RFC 3339 UTC 字符串。BigInt ID 在接口及 JSON 快照中转十进制字符串，不转 Number。
- Json 只存合法 JSON 数据；写入前将 BigInt/Date 等转换为约定字符串，明确 SQL NULL 与 JSON null 的差别。审计及响应快照按白名单脱敏，不能把原始 Prisma 实体整体返回或记入日志。
- M0 不引入金额字段；未来 Decimal 金额按字符串传输，不使用 JS 浮点数计算。不通过全局修改 BigInt.prototype 掩盖接口序列化边界。

### 3.2 待 Schema/SQL 评审落定的实施建议

以下是实施建议，不是已确认业务规则；在生成首份迁移前于实施记录写明最终选择：

| 事项                 | 最小实施建议                                                                   | 评审要点                                                                 |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 状态与默认值         | 用户/角色/部门使用明确的启用/停用状态；版本初始值统一；不引入未定义的业务状态  | 启用、停用及版本含义不能混用                                             |
| 字符串长度和排序规则 | 对登录名、权限码、哈希、UUID 和幂等 scope/key 给出有界长度；明确大小写语义     | 唯一性需与规范化规则一致，不凭数据库默认排序规则决定 Key 语义            |
| 授权关联             | 组合唯一或组合主键，补反向查询所需索引                                         | role_permissions 每个 role/permission 只有一个 scope，不新增策略表达式表 |
| FK 删除/更新         | 历史用户、审计及尝试引用采用显式 RESTRICT/NO ACTION；必要身份关系保守保护      | 不级联删除历史；具体 FK 的可空性和行为逐项写入 SQL 审查                  |
| 系统审计主体         | 允许明确标识的系统主体，或受控系统身份；未知主体不得冒充用户                   | 若 actor_id 可空，必须有明确系统主体表达，不能用 null 混同身份丢失       |
| 尝试与成功审计       | AuditLog.attempt_id 关联稳定且唯一的尝试标识；同一次尝试允许哪些审计数量须明确 | 不默认加“一次尝试只能一条审计”的额外业务限制                             |
| 技术记录清理         | 幂等记录与长期审计通过稳定关联值核对，不建立阻碍回收的级联依赖                 | 不能因删除过期幂等行丢失审计或 UNKNOWN 线索                              |

部门无环、权限授予限制、状态转换和审计不可改约定不能仅靠 FK 证明；本阶段不实现其 Auth/RBAC 服务逻辑，也不宣称仅完成表结构就已满足全部安全要求。

## 4. 权限数据及 Seed 边界

- scope_code 固定枚举：SELF_COLLABORATOR、TEAM、ASSIGNED_PROJECT、FINANCE_RELATED、ALL、IDENTITY、AUTHENTICATED、CATALOG；SELF_COLLABORATOR 是 SELF/COLLABORATOR 的并集。
- 默认角色为 system_admin、sales、sales_manager、delivery_member、delivery_manager、finance、business_owner。原子权限及默认作用域逐项来自权限矩阵 §8，不采用“管理员拥有所有权限”的通配规则。
- role:grant_business 仅由受保护的 business_owner 模板提供。字典/模板初始化不等于为任何用户分配业务角色，也不替代运行时职责分离和对象授权。
- 开发基础 Seed 仅负责可重复执行的角色、权限和默认映射，不含默认密码、刷新令牌、测试客户或自动授予的超级管理员账号。重跑不得静默覆盖已修改的有效授权、删除额外角色或扩大已有用户权限；遇冲突应报告，由明确的数据升级流程处理。
- 首位业务负责人的受控初始化及审计是既有要求，但账号来源/凭证输入方式未定义。本阶段不能凭空创建真实负责人；如后续单独实现 bootstrap，必须显式输入、留审计并避免提交秘密。
- 测试 fixture 与基础字典 Seed 分离，使用专用测试库/命名空间和可核验的清理范围；不得将测试账号混入普通开发 Seed。

## 5. 幂等及审计的数据库支撑

### 5.1 幂等：以 ADR-005 为准

- scope 固定为 user:<不可变用户 ID>，同一用户的 Key 跨操作唯一；目标、operationId、规范化请求体进入指纹，不能再把操作放入唯一作用域。
- 保存 fingerprint_version、请求哈希、HTTP 状态及最小响应快照；保留至少七天的技术默认和回收索引。64 KiB 快照上限与规范化检查是后续写入逻辑要求，不声称 Json 字段本身已自动强制。
- PROCESSING 不独立预提交；成功事实与最终幂等结果同一 MySQL 事务；V1 不缓存失败。结果未知时用原 Key 核对，不自动重做。
- 本阶段以唯一约束、事务回滚及并发数据库测试验证必要支撑，不实现 HTTP 幂等拦截器或完整执行器。

### 5.2 审计：以 ADR-003 为准

- AuditLog 保存成功业务事实；CommandAttempt 保存 STARTED、SUCCEEDED、REPLAYED、FAILED、UNKNOWN 尝试状态及关联信息。
- 关键尝试先独立预写；成功审计、业务事实、成功尝试及幂等结果同事务。确定回滚后独立写 FAILED；崩溃留下 UNKNOWN 待核对，不能伪造成审批驳回。
- 数据库可用性故障不能凭表结构消除；核对任务、故障告警、白名单审计写服务仍属于后续实现，不在本次只建模任务中提前扩展。
- 保存期限未由业务确认，不虚构统一清理周期；STARTED/UNKNOWN 不随七天幂等清理自动删除。

## 6. 首份 Migration 的执行顺序与安全边界

1. 阅读本总结及当前有效 ADR；以明确的 M0 Schema 为输入，首先执行 prisma validate。
2. 只读核查目标主机、库环境及表清单，不输出凭证；确认专用本地空库。若发现已有非空对象，停止自动应用，先核实数据归属、备份及迁移方案；不得自动 reset、drop、truncate 或覆盖。
3. 用 Prisma Migration 工具生成 init_m0；使用仅生成方式先取得 SQL。若工具要求 shadow database 或权限不足，明确处理，不改用 db push 或手工建表绕过。
4. 审查真实 SQL：十个 M0 表、列名/类型/NULL/default、主键、唯一键、索引、FK 及删除/更新行为；确认无 CRM/订单/财务表和破坏性 SQL。SQL 文件名、校验及实际结论写入实施记录，不预先宣称通过。
5. 在允许应用迁移后，将已审查版本应用于确认过的空库；失败先查迁移状态，不自动清空数据或迁移历史。
6. 生成 Prisma Client，查询实际表结构、约束及迁移记录，再执行构建、只读连接验证、数据库集成测试与开发基础 Seed 验证。
7. Schema、真实迁移 SQL、迁移锁定配置、Seed、测试、序列化策略和实施记录纳入 Git 交付。不得提交 .env、生成客户端、测试凭证或数据库转储；实际 Git 提交状态须单独报告，不能用“待提交列表”冒充已提交。

当前仍处于“仅补总结、先不要应用迁移”状态；本节描述后续流程，不是本次执行记录。

## 7. 最小验收清单

- [ ] M0 十个模型及 snake_case/camelCase 映射明确，无业务表。
- [ ] Prisma validate、Client 生成、lint、typecheck、build 通过。
- [ ] init_m0 真实 SQL 已逐项审查，记录其 FK 删除策略和安全影响。
- [ ] 迁移只应用于确认的专用空库；实际结构与 Schema/迁移一致。
- [ ] 真实 MySQL 验证登录名/角色码/权限码、关联组合及幂等 scope/key 唯一性。
- [ ] FK 拒绝悬空引用；停用用户仍可追溯；受引用历史用户删除被约束阻止。
- [ ] 重复幂等键并发只允许一个所有者，回滚不留下已提交的成功审计/幂等结果；独立尝试记录的保留边界可验证。
- [ ] BigInt、UTC 时间、Json/null 转换有最小测试，不泄漏密码哈希或令牌。
- [ ] Seed 可重复执行，基础权限与测试 fixture 分离，不自动建真实账号或扩权。
- [ ] 交付明确列出 SQL 审查、实库结构、Client/构建、测试和 Git 状态；没有把后续 Auth/RBAC 执行语义标成已完成。

## 8. 本次文件补齐记录

原指定路径不存在，现根据已有项目文档生成本总结。此次仅新增本文；未修改原设计、Schema 或数据库，未生成/应用 init_m0，未执行 Seed 或 Git 提交。上方检查项保持未勾选，等待实际实施验证。
