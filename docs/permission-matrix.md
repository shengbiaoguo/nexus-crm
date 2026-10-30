# Nexus CRM — 权限与数据范围设计 V0.2

> 状态：技术建议，需结合真实公司组织审批。业务权限不按角色硬编码；RBAC 决定功能访问，Scope/Policy 决定资源访问与职责分离。

2026-10-30 实现范围：M0 用户/角色/权限/部门读取接口已接入 RBAC，用户详情采用本人或 user:manage + IDENTITY 的对象级数据库过滤，详见 [授权实现与边界](authorization.md)。其余业务范围及授权写入规则仍是待接入、待验收的设计基线。

## 1. 默认角色

- `system_admin` 系统管理员（仅用户、角色、系统配置，默认不具备财务审批权限）
- `sales` 销售
- `sales_manager` 销售经理
- `delivery_member` 交付成员
- `delivery_manager` 交付经理
- `finance` 财务
- `business_owner` 业务负责人/负责人授权

## 2. 权限粒度

权限字典以 §8 为完整基线，包括 `product:read/manage`、`quote:read/create/submit/record_acceptance`、`order:read/create/update/submit/withdraw/approve/reject/request_cancel/approve_cancel/request_terminate/approve_terminate/request_change/approve_change/complete`、`delivery:read/assign/start/task_manage/task_update/accept`、`payment:read/record/confirm/reverse`、`refund:read/create/approve/settle`、`customer:create/read/update/assign`、`opportunity:create/read/update`、`department:read`、`user:manage`、`role:manage`、`role:grant_business`、`audit:read`。斜杠表示分别展开的原子权限，不是通配符。

## 3. 默认操作权限建议

| 功能 | 销售 | 销售经理 | 交付成员 | 交付经理 | 财务 | 业务负责人 | 系统管理员 |
|---|---|---|---|---|---|---|---|
| 创建客户/商机 | Y | Y | N | N | N | Y | N |
| 分配客户 | N | 团队 | N | N | N | Y | N |
| 报价与订单草稿 | 本人 | 团队 | N | N | N | Y | N |
| 审批订单 | N | 授权范围 | N | N | N | 授权范围 | N |
| 申请取消/终止 | 本人 | 团队 | N | 分配项目 | N | Y | N |
| 批准普通取消 | N | 授权范围 | N | N | 财务复核 | 特例 | N |
| 批准终止 | N | N | N | 交付核算 | 财务复核 | Y | N |
| 启动交付 | N | N | N | 分配项目 | N | 豁免授权 | N |
| 更新交付任务 | N | N | 本人任务 | 分配项目 | N | N | N |
| 验收/结项 | N | N | 提交证据 | 授权范围 | N | 特例 | N |
| 记录收款 | N | N | N | N | Y | N | N |
| 确认收款 | N | N | N | N | 授权+职责分离 | N | N |
| 冲正 | N | N | N | N | 授权+复核 | 特例 | N |
| 账号/角色管理 | N | N | N | N | N | 按授权 | Y |

## 4. 数据范围

- `SELF`: 当前客户主负责人为本人；创建人身份不产生永久访问权。
- `COLLABORATOR`: 作为客户协作成员的许可对象。
- `TEAM`: 当前所属团队及允许的下属团队；组织成员变化时动态生效。
- `ASSIGNED_PROJECT`: 明确分配的交付项目及最小必要客户信息。
- `FINANCE_RELATED`: 为收付款核对所必需的订单和客户账务数据。
- `ALL`: 已授权的公司级数据范围，仍不绕过敏感动作权限。

### 4.1 V1 固定继承策略（技术基线，非新增 BR）

客户是销售数据授权根：联系人、商机、报价及其版本、订单及申请均按当前客户归属继承。商机 `owner_id` 是业务责任信息，不独立授予访问权；创建者、历史负责人同样不产生残留授权。客户转移后，旧负责人仅在仍为协作者或另有有效 TEAM/ALL 授权时继续访问；批量商机交接对授权的影响仍遵守该规则。

TEAM 以当前客户主负责人的当前部门为准，包含授权人所在有效部门及其全部有效下属部门；禁止部门环路，用户无有效部门时不获得 TEAM。协作成员限有效销售人员，COLLABORATOR 默认允许销售业务读写，但不授予分配及审批权。客户负责人/协作关系只经 assign 命令修改，通用 PATCH 禁止修改客户关联、负责人和协作集合。商机 owner 的调整留给 DC-007 的受控交接契约，通用 PATCH 禁止修改。

多角色按“同一角色的动作权限及其 scope”分别求值后取并集，禁止把一个角色的业务动作与另一个角色的 ALL 范围拼接。`role_permissions.scope_code` 使用固定枚举；无映射即拒绝。实现为 Service 内的固定 Policy 函数和查询条件，不引入表达式策略引擎。

ASSIGNED_PROJECT 通过订单预分配的交付经理、项目经理及项目成员关系确定；成员仅可编辑本人任务，经理可管理其项目。项目创建前由 `delivery:assign` 指定订单交付经理，启动者必须是该经理；请求中的 deliveryManagerId 必须与预分配相同，不能借启动自我分配。预分配/改派由业务负责人操作，不改变销售归属。任务及验收细节仍属 DC-004。

FINANCE_RELATED 仅授予获财务能力的主体账务投影；不授予销售跟进或完整客户资料。跨部门读权限不得自动转成跨部门写权限。ALL 也不跳过职责分离和状态检查。

### 4.2 关联、字段和即时生效

- 对嵌套路由校验 contact→customer、quoteVersion→quote→opportunity→customer、task→project→order、application→order；对 body 的 paymentId、报价来源、证据/批准引用同样校验业务归属。ID 存在不能代替关联校验，不匹配统一 404。
- 客户创建者默认成为主负责人；创建商机等子对象先验证父客户业务访问权。分配者须同时有源客户范围和目标有效用户范围：销售经理仅本团队内移交，跨团队仅业务负责人 ALL；协作调整亦同。
- 销售投影：授权客户、联系人、商机、报价、订单合同及收付状态摘要；银行核对凭证、账户和完整流水不随 order:read 返回，需 payment:read/refund:read。交付投影：订单号、客户名称、经指定的项目联系人、交付范围及必要合同条款，不含其他商机、跟进及银行数据。财务投影：客户账务身份、订单金额/计划/结算、收付凭证，不含销售跟进。用户本人资料仅 id/name/loginName/departmentId，不含密码哈希及他人权限。
- 审计检索同时要求 audit:read 和事件目标的当前可见范围；无可见业务目标的身份/配置事件仅系统管理审计范围可见。不得通过 before/after 快照泄漏当前无权资源；所有投影服务端白名单。
- 每次请求读取权威用户状态、角色及关系，不以 Token 内旧权限作授权依据；V1 不缓存授权结果。停用时递增 credential_version、撤销刷新会话；访问 Token 携带该版本，每次请求对比数据库。权限/归属变更提交后开始的请求使用新值；写命令事务内重验，并锁相关授权关系与业务行，涉及共同资源的变更遵守统一顺序：相关用户→相关角色→相关部门→客户→订单→子记录，各层按 ID 排序。用户行保护其角色成员变更，角色行保护权限/scope 变更，部门行保护团队结构变更；验证使用当前读，禁止复用事务早期快照。目标集合变化则回滚重新获取，不逆序追加锁。授权撤销与已在执行的写操作按持锁提交顺序线性化；不能保证撤回已返回的数据。

### 4.3 授权管理和职责分离

`role:manage` 只允许配置身份管理能力，不代表可授予业务能力。任何包含业务权限、业务 scope 或 role:grant_business 的角色，其权限/scope 修改及分配/移除还须 role:grant_business；不得修改会影响本人有效业务授权的角色、给本人增减业务角色、修改本人部门以扩大 TEAM。通用用户 PATCH 不接受 status/credential_version/password_hash；停用走专用命令。部门变更若影响任何业务角色的 TEAM 范围，同样需要 role:grant_business；管理员不能通过组织调整扩大自己的范围。

role:grant_business 只由受保护的 business_owner 角色提供；该权限及该角色模板不能通过普通角色权限编辑修改。首位业务负责人由受评审的初始化脚本建立并留审计；后续由另一名持该能力的业务负责人分配，禁止自授。管理员仅持 user:manage/role:manage，不能修改业务负责人账号的登录身份或部门、停用该账号或授予自己业务角色；此类受保护账号变更还须另一名 role:grant_business 持有人。禁止停用或撤销最后一名有效业务授权负责人。账号恢复使用受控运维流程，不通过通用 PATCH 绕过。

申请人与最终审批人不同；withdraw 限当前轮提交人且仍有订单范围及动作权限。财务默认登记人与确认人不同；冲正及退款的复核链细节由 DC-003 明确，在复核依据尚未可验证前拒绝执行。业务负责人“特例”不等于自动持有财务确认、冲正执行、交付启动或验收权限；需另一授权人按本节显式配置且仍受职责分离。未定义的豁免/复核端点默认拒绝，待 DC-002/003/006 补契约。

## 5. 防止越权的实例

1. 销售可调用 `GET /customers/:id` 但该 ID 不在本人、协作或团队可见范围：拒绝。
2. 销售能创建订单，不意味着可审批自己的订单；审批需授权且职责分离。
3. 交付经理可查看分配项目，不能据此获取客户的所有商机及财务详情。
4. 系统管理员可分配账号权限，默认不能为自己直接批准大额退款；高风险授权动作应审计。
5. 人员离职停用后，撤销刷新会话并按 §4.2 的 credential_version 检查拒绝旧访问令牌。

## 6. 测试验收

- 每种角色覆盖 401、403、对象级拒绝、允许数据范围。
- 认证通过但操作未授权，拒绝并不产生业务更新。
- 客户负责人变更后，旧负责人的访问权限按新归属即时生效。
- 同一用户作为申请人及审批人时，按职责隔离规则拒绝自审批。
- 审计日志包含操作者、动作、目标对象、结果及 requestId；不记录敏感凭证。
- 覆盖客户移交后旧负责人/商机负责人权限失效、协作保留、多角色 scope 不串用、跨团队目标分配拒绝、嵌套 ID 错配、跨部门字段过滤。
- 覆盖管理员自授业务权限、通过角色模板/部门扩大本人权限、修改受保护账号及撤销最后一位业务负责人均被拒绝；授权撤销与业务写并发按共同锁顺序验证。

## 7. 仍待确认

审批金额门槛、真实组织部门数据、财务复核链细节、敏感客户的额外限制、未来跨部门共享流程。上述未决项不得绕过 §4 的默认拒绝策略；客户继承、Token 失效和权限生效机制已在 §4 确定。

## 8. API 授权总表

默认角色是 seed 建议；每项仍按 §4 检查。缩写：销=销售，销经=销售经理，交=交付成员，交经=交付经理，财=财务，业=业务负责人，管=系统管理员。销售范围 S=销 SELF/COLLABORATOR、销经 TEAM、业 ALL；D=交/交经 ASSIGNED_PROJECT；F=财 FINANCE_RELATED；I=身份管理对象范围。持久化 scope_code 中 SELF/COLLABORATOR 合并为 SELF_COLLABORATOR，I 对应 IDENTITY，有效员工对应 AUTHENTICATED，公司目录对应 CATALOG，其余同名。以下路径省略 /api/v1；未列新端点禁止仅凭“授权员工”放行。

| API / 操作组 | 原子权限 | 默认角色与范围 | 附加限制 |
|---|---|---|---|
| GET health | 无 | 公开受限 | 仅探活 |
| POST auth/login、refresh | 无业务权限 | 凭证/刷新会话有效 | 限流、轮换、防重放 |
| POST auth/logout；GET auth/me | 当前会话 | 本人 | 不返回他人数据 |
| GET/POST users；GET/PATCH users/:id；POST disable | user:manage | 管 I；业按授权 | GET 本人可走受限投影；受保护账号见 §4.3 |
| POST users/:id/assign-roles | role:manage | 管 I；业按授权 | 业务角色另需 role:grant_business，禁止自授 |
| GET/POST roles；PATCH roles/:id；GET permissions；PUT roles/:id/permissions | role:manage | 管 I；业按授权 | 权限及 scope 替换须版本检查；业务角色变更另需 role:grant_business |
| 业务角色/scope 配置及分配的附加检查 | role:grant_business | 业 I | 不能单独代替 role:manage；保护模板、自授和最后负责人限制见 §4.3 |
| GET departments | department:read | 所有有效员工 | 仅部门 id/name/parentId，不含员工名单 |
| GET customers、customers/:id、contacts | customer:read | S；D/F 仅必要投影 | 联系人隶属校验 |
| POST customers | customer:create | 销、销经、业 | 本人为初始负责人 |
| PATCH customers/:id；POST/PATCH contacts | customer:update | S | 不可修改归属；父子匹配 |
| POST customers/:id/assign | customer:assign | 销经 TEAM、业 ALL | 源和目标均校验；审计 |
| GET opportunities、/:id、follow-ups | opportunity:read | S | D/F 不开放完整商机接口 |
| POST opportunities | opportunity:create | S | 校验父客户 |
| PATCH opportunities/:id；POST close-won/close-lost/follow-ups | opportunity:update | S | 允许字段白名单，不改归属 |
| GET service-products | product:read | 销、销经、交经、业，公司目录 | 不授予管理权 |
| POST/PATCH service-products | product:manage | 业，公司目录 | 不影响历史价格 |
| GET opportunity quotes、quotes/:id、版本详情 | quote:read | S | 完整来源链匹配 |
| POST opportunity quotes、quote versions | quote:create | S | 草稿内容契约待 DC-010 |
| POST version submit | quote:submit | S | 冻结内容 |
| POST version record-acceptance | quote:record_acceptance | S | 不能自己充当客户接受事实；须依据 |
| GET orders、/:id、approvals | order:read | S；D/F 仅订单必要投影 | 审批明细仅 S，D/F 仅状态摘要 |
| POST orders | order:create | S | 报价和客户范围匹配 |
| PATCH orders/:id | order:update | S | 仅草稿，禁止 status/归属等字段 |
| POST order submit | order:submit | S | 冻结审批快照 |
| POST order withdraw | order:withdraw | S | 当前提交人、未表决 |
| POST order approve/reject | order:approve / order:reject | 销经 TEAM、业 ALL | 非申请人；金额授权门槛待确认 |
| POST order change-requests | order:request_change | S | 申请有效性待 DC-006 |
| POST change-request approve | order:approve_change | 销经 TEAM、业 ALL | 非申请人；需客户接受及复核 |
| POST cancellation/termination-requests | order:request_cancel / order:request_terminate | S；交经 D | 非最终批准 |
| POST cancellation-request approve | order:approve_cancel | 销经 TEAM、业 ALL | 非申请人；财务复核不是此权限 |
| POST termination-request approve | order:approve_terminate | 业 ALL | 非申请人；交付核算及财务复核 |
| POST orders/:id/assign-delivery-manager | delivery:assign | 业 ALL | 目标为有效且具启动能力的交经；受控预分配 |
| GET order delivery、project tasks | delivery:read | 交/交经 D；销/销经 S、业 ALL 只读范围及进度 | 不扩大客户读取范围 |
| POST order delivery/start | delivery:start | 交经 D | 不能借请求体自分配 |
| POST project tasks | delivery:task_manage | 交经 D | 不得自行扩大合同范围 |
| PATCH project task | delivery:task_update | 交本人任务、交经 D | 不可直接写验收/范围生效状态 |
| POST project task accept | delivery:accept | 交经 D | 交仅提交证据，入口待 DC-004 |
| POST order complete | order:complete | 交经 D | 当前范围有效验收；特殊授权仍需此能力 |
| GET payment-terms、payments | payment:read | 财 F | 销/交通过订单投影读摘要，不读财务明细 |
| POST order payments | payment:record | 财 F | 不代表确认 |
| POST payment confirm | payment:confirm | 财 F | 非登记人 |
| POST payment reverse | payment:reverse | 财 F | 复核依据可验证，不允许自复核 |
| GET order refunds | refund:read | 财 F、业 ALL | 最小财务投影 |
| POST order refunds | refund:create | 财 F | 不代表批准 |
| POST refund approve | refund:approve | 财 F、业 ALL | 非申请人；门槛/复核链待 DC-003 |
| POST refund record-settlement | refund:settle | 财 F | 已有有效批准；实际退款依据 |
| GET audit-logs | audit:read | 管 I、业 ALL | 目标范围与字段过滤见 §4.2 |

业务负责人默认额外持 role:manage、role:grant_business；不默认持 user:manage。财务/交付复核、豁免以及批量交接的新增端点权限随相应待办补齐，未定义前不启用，不以管理员权限兜底。

## 9. M1 接入约束（2026-10-30，DC-001）

DC-001 的基线已经定义，但 M0 `permission.policy.ts` 只执行 user:manage、role:manage、department:read 三个映射；不能直接用它放行业务范围。M1 应新增固定销售范围 Policy 和写事务授权能力，继续复用 M0 身份校验；具体任务见 [M1 实施计划](plans/m1-implementation-plan.md)。

| 操作组 | M1 允许的固定范围 | 必需的额外检查 |
| --- | --- | --- |
| customer:create/read/update；opportunity:read/create/update；quote:read/create/submit/record_acceptance；order:read/create/update/submit/withdraw | 同条 grant 的 SELF_COLLABORATOR、TEAM 或 ALL；不是角色名白名单 | 子资源经当前客户继承；创建客户时 customer:create 校验有效 grant，负责人固定为操作者；其他创建先验证父对象 |
| customer:assign | TEAM 或 ALL | 同时验证源客户与目标用户范围、有效销售资格；协作调整同样受控；商机责任人交接/批量契约由 D-07 决定 |
| order:approve/reject | TEAM 或 ALL | 当前 round 非提交人、审批门槛/快照有效（D-05）；COLLABORATOR 不授予审批 |
| product:read/manage | CATALOG | 动作不可相互代替；管理仍需显式 product:manage，历史价格不回写 |

上表列出允许的 action/scope 组合，不给任何账号自动增加权限；seed 默认角色仍按 §8，出现差异须走受控变更。customer:create 的 scope 仅确定创建资格，不能接受客户端 ownerId 或借此跨团队创建；D-07 的目标资格不能只按 role.code 字符串推断。

SELF_COLLABORATOR 的两个分支必须区分：负责本人客户不等于协作成员审批；协作成员的读写只适用于本来允许协作的动作。ASSIGNED_PROJECT、FINANCE_RELATED 在 M1 没有真实关联实体，仍默认拒绝，不能把必要投影伪造成全部销售数据。

列表 where、总数、详情、嵌套对象、状态命令、幂等重放都复用相同固定策略。无动作权限的列表为 403；不可见详情/错误父子关系为 404；不能先无范围读取客户再过滤输出，也不能向无权用户披露当前版本、重复客户或审批快照。

读取沿用同一 RepeatableRead 快照；写入使用 ReadCommitted 的当前读与 §4.2 锁顺序。幂等 Key 的争用位于业务锁之前（现有组件协议），业务锁依次为全体相关用户→角色→部门→客户→已有订单→子记录，各层数值 ID 排序。子记录的跨表固定顺序在 T05/T13 明确并进行逆序竞争测试。客户写入/交接保护客户行；角色成员撤销保护用户行；权限替换保护角色行；组织调整保护相关部门，双方必须遵循同一协议。

用户/角色/部门集合须在业务锁前解析，持锁后重验。拥有者、团队祖先、成员集合变化时完整回滚并重新计划，不能在客户锁后补锁用户或部门；userLocks 的 100 项上限应在批量 DTO 和业务校验中提前控制。不得把 AuthorizationService.withRead 返回的上下文缓存成业务写许可，也不得在幂等 authorize 回调内调用另开的 withRead 事务。

## 10. D-06 / D-08 已批准 CRM 对象规则（2026-10-30）

业务批准来源见 [决策记录](decisions/m1-d06-d08-proposal.md)，规则见 requirements §14、接口见 api-design §10。复用 §4/§9 固定 action/scope，不改既有 BR、职责分离或授权管理；下列路由均待实现，不自动扩大任何账号/seed 权限。

| 操作 | 动作与范围 | 对象和状态检查 |
| --- | --- | --- |
| duplicate-check、客户/联系人读取 | customer:read + SELF_COLLABORATOR/TEAM/ALL 同条 grant | 只查当前可见客户；可见候选及 hasMore 同一快照；excludeCustomerId 须可读否则 404 |
| 客户创建 | customer:create 的有效 grant | owner 固定 actor；创建权限不隐含读取，不能据此获取重复候选 |
| 客户 PATCH、archive/restore、联系人新增/PATCH/deactivate/设主 | customer:update + 当前客户根范围 | 普通 PATCH 不收 owner/协作者/status；archive 无进行中商机，restore 只恢复目录管理；归档禁止其他 CRM 写；主联系人变更不转移归属 |
| 商机创建/读取 | opportunity:create/read + 当前父客户范围 | 当前客户根→商机链验证；创建要求 ACTIVE，owner 不独立授权 |
| 商机编辑/change-stage/close-won/close-lost、跟进追加 | opportunity:update + 当前父客户范围 | 服务端检查阶段、版本、有效联系人、原因与计划时间；父子错配 404，不按作者或商机 owner 额外放行 |
| 跟进列表 | opportunity:read + 当前父客户范围 | 包含更正与原记录但只限本商机；无编辑/删除权限或管理员旁路 |

信用代码全库唯一可能触及不可见客户，但不能返回其 ID/name/owner/团队/版本/联系人/数量；统一 409 BUSINESS_RULE_VIOLATION 固定消息，不区分可见性。查重本身只给最多 5 个可见客户的 id/name/status/matchReasons，隐藏匹配与无匹配同为空，不返全库 exists/total。业务负责人已接受保存成功/409 带来的最小占用信号，不宣称完全隐藏存在性；不增加匿名/批量探测或全库查重 grant。

ARCHIVED 客户及终态商机历史仍依当前客户 scope 可读，不因归档/终结变成公开或被隐式删除。归档不释放信用代码、不撤销读取、不取消历史订单；WON 不代替订单批准，LOST 不撤销订单。联系人正文只在受控读取返回；财务/交付不因本文获得销售跟进或完整联系人。写结果和幂等仅安全标量，日志/审计不存联系方式全文，审计查询仍按当前目标可见性。

每次写和重放重新验证权威身份/动作/当前客户范围；原负责人/作者/创建者不保留越权访问。遵循用户→角色→部门→客户→已有订单（确实涉及时）→子记录；CRM 子记录跨类固定 Opportunity→CustomerContact→FollowUp，同类 ID 排序。主联系人切换、有效联系人≤100、归档与商机创建/状态、追加与终结在客户锁下串行，不逆序补身份锁；该锁表仍需 T05 实库验证。受控交接及目标资格保留 D-07/T09，不用 ordinary PATCH 绕过。

验收覆盖：无 grant 403，不可见/父子错配 404，停用身份 401；TEAM 动态范围、同快照 where/count、客户移交/撤权与写入和重放竞争；隐藏候选不改变 hasMore；联系人/跟进正文不进入日志或幂等；状态禁止与职责权限分别测试。完整矩阵见 requirements §14.3 CRM-01～18。设计批准不表示这些测试已通过。
