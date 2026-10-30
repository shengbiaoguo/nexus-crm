# M1 实施计划：客户到确认订单

- 日期：2026-10-30；性质：开发准备、设计核查和任务拆分，不是业务实现或发布批准。
- 本轮仅改文档；未新增业务代码、Controller、Prisma 模型、Migration、账号或数据库。

后续实施注记：前置基础能力已单独补齐一轮，具体实现与验证见 [M1 前置基础能力](../m1-foundations.md)。T03 创建适配和 T02 有界核对入口已有实现；T01 仅完成 Bootstrap，T05 仅完成对象 guard/身份锁，未完成管理写接口或真实销售表查询。下文保留计划制定时的核查/工作量，不因后续基础设施测试通过而宣称全部任务完成。

- 结论：M0 可复用底座已具备，但 **M1 尚不能无条件开工至确认订单**。销售对象授权、写入锁协议、创建命令审计适配及安全账号准备需补齐；DC-005/010 仍有必须明确的业务决定。可以先做不依赖未决业务规则的前置任务，不得用假设开放受阻接口。

2026-10-30 业务批准更新：D-06/D-08 已设计闭合，正式契约见 requirements §14、data-model §12、api-design §10、permission-matrix §10 及批准记录。T00 其余 D-01～05/07 仍未决；以下制定时核查描述保留历史，当前门禁以本注记和进度表为准。任务编号与依赖不变。

## 1. 范围、依据与文档效力

目标闭环为：受控身份→客户/联系人→商机/跟进→服务目录→报价完整版本→提交/记录客户接受→订单草稿及合同条款→冻结审批快照→确认/拒绝/撤回；并交付 BR-010 的批量客户/商机交接。不会因开发方便将交接降为 V1.1。

依据：[项目规则](../../AGENTS.md)、[需求](../requirements.md) §3/4/5/10/13、[数据模型](../data-model.md) §3/4/8/11、[API](../api-design.md) §2/3/9、[权限矩阵](../permission-matrix.md) §4/8/9、[ADR 索引](../adr/README.md)。已阅读 ADR-001～005：001/003/004/005 是现行 Accepted；002 保留历史，已被 005 替代。本方案落实既有架构，不推翻 ADR，故不新增或覆盖 ADR。实现如需改变锁锚点、幂等原子性或迁移机制，先写 superseding ADR，再调整任务。

未决业务规则以 API §9.4 的 D-01～D-08 登记，**不能由本计划替业务方定案**。本次直接修复技术缺口和文档不一致；“设计补充”“设计关闭”“实现通过”是三个不同状态。表中候选字段/约束如受 D 项影响，不构成生成 Migration 的授权。

不包含：交付项目、任务、验收、首款到账/豁免、收款/冲正/退款、结项、订单变更/取消/终止；不实现 M2/M3 Controller、空策略或固定无阻断查询。M1 仅前置订单的合同付款条款，不是开发财务模块。

## 2. M0 前置依赖核查

代码核查位置均相对 `apps/api`；测试证据是现有测试覆盖范围，不能外推为生产或未来业务验收。执行结果记录在 §10。

| 能力                      | 当前实现证据                                                                                             | 对 M1 的结论/补齐                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 共享数据库及生命周期      | src/app.module.ts、infrastructure/database.module.ts、prisma.service.ts；Auth/Authorization 共用注册对象 | 可复用；新模块继续复用一个注册对象，不能每模块新建池；恢复客户端例外沿用现有组件                                                                       |
| 模型和迁移                | prisma/schema.prisma 仅 10 个 M0 模型；init_m0、align_m0_collation 两份历史迁移                          | 身份/平台可依赖，业务表尚不存在；按 §5 分批扩展，不重建 M0                                                                                             |
| JWT/会话/停用认证         | auth/*；database/auth.test.ts 覆盖真实登录、刷新并发、停用和审计回滚                                     | 认证可复用；测试中模拟停用不等于已有账号停用/角色分配生产命令                                                                                          |
| 身份读取和固定 Policy     | authorization/permission.policy.ts 仅三个 M0 动作；authorization.service.ts.withRead 为 RepeatableRead   | 不支持 M1 的 SELF_COLLABORATOR/TEAM/ALL/CATALOG；T05 实现固定策略及当前写入授权，不能照搬身份 where                                                    |
| 安全身份准备/业务授权管理 | seed-baseline.ts 只建字典/角色；没有受控负责人初始化、assign-roles、disable 写路由                       | T01 补最小受控路径及保护；不能给自己 SQL 插角色或创建默认管理员密码。完整身份 CRUD 不是 M1 闭环的硬前置，未实现入口保持关闭                            |
| DTO/响应/错误/日志        | application.ts、http/_、logging/_；普通测试覆盖校验/BigInt/UUID/错误脱敏                                 | 可复用；业务 Decimal 显式映射字符串，不能依赖通用序列化器猜测；新增错误码需同步契约                                                                    |
| 成功审计/尝试状态         | audit/audit.service.ts；数据库测试覆盖原子成功、回滚、markOverdueUnknown 不覆盖成功                      | 可复用服务方法；尚无定时/运维核对入口，T02 接入有界核对，不以技术日志代替                                                                              |
| 幂等/恢复                 | idempotency/*；独立 STARTED、Key 等待、事务结果、恢复与授权重验                                          | 可复用；业务必须提供完整锁集合和 authorize；新建自增实体的实际审计对象适配是 T03 门禁                                                                  |
| 输出限制                  | responseSnapshot 只接受显式标量字段，上限 64 KiB，拒绝联系信息                                           | POST/PATCH 返回安全摘要，GET 获取详情；不能用嵌套合同/联系人全文作命令结果                                                                             |
| 测试/CI                   | test:m0、database/*.test.ts、.github/workflows/ci.yml                                                    | 现有 31 项实库测试只证明 M0；m0.test.ts 的整库表名/FK/CHECK/10 表数量断言必须在 T04 演进，保留 M0 子集精确校验并增加 M1 总清单，不能改为只检查“表存在” |

准入层级：T00/T01/T02/T03 与已明确的 CRM 数据设计可先准备；首个业务写入口须先通过相应安全前置。报价内容/订单建模和审批分别等待 D-01～05；生产业务写入还需要 T02 核对作业与运行手册，不能仅凭本地单次测试开通。

## 3. 设计审查结论与未决门禁

| 项                | 核查前状态                             | 本轮修复                                                                                              | 当前结论与关闭门槛                                                                                             |
| ----------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| DC-001            | 设计基线已修订；仅 M0 身份读取部分实现 | 权限 §9 列出 M1 action/scope、创建/交接、重放和完整锁集合约束；本计划 T01/T05/T09/T17 明确实库验收    | 设计基线可用，**M1 实现未关闭**；客户移交、团队变化、嵌套链、职责分离/重放均需实库验证；审批门槛还受 D-05 阻断 |
| DC-005            | 付款条款来源/完整审批快照未闭合        | API §9.2、模型 §11.2 增加订单草稿条款入口、完整 JSON/hash/schema version、轮次/撤回与付款条款前置边界 | **部分技术补齐，未关闭**；D-01/02/03/04/05 的相关决定及样例齐备后才关闭设计；T12～16 完成后再谈实现关闭        |
| DC-010            | 报价内容入口、不可变和接受/过期未闭合  | API §9.1、模型 §11.1 增加完整版本创建入口、来源快照、版本号与锁版本区分、接受内容哈希绑定             | **部分技术补齐，未关闭**；D-01/02/04 决定及状态/边界用例齐备前不得开发受影响报价写逻辑                         |
| DC-007（M1 部分） | 批量交接仍未定义                       | 登记 T09/D-07 和 BR-010 追踪；修正 follow_ups 阶段为 M1，与 API §2.2 一致                             | 未关闭；批量事务/部分失败/协作者保留不能擅自决定；M2 报表仍另行处理                                            |

### 3.1 决策输入清单

| 决定                            | 最晚阻断点                   | 应交付的可评审材料                                                               |
| ------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| D-01 金额/数量与税折/舍入       | T08 的金额部分、T10/11/12/14 | 正常/零/负/最大/小数/溢出例表，行额与总额期望；Decimal 列精度；禁止浮点          |
| D-02 证据、接受状态和有效期     | T10/11、T12/14/15            | 状态转换表、UTC 边界、旧版接受影响、证据归属和失效测试；不承诺文件签名/法务系统  |
| D-03 合同付款条款               | T12/14/15                    | 字段/到期基础/首付定义、计划与合同一致性、create/PATCH/submit 例子及证据内容绑定 |
| D-04 来源订单唯一性/草稿修改    | T12/14                       | 所有订单唯一还是有效订单唯一；终态后重建；明细差异许可；对应数据库约束方案       |
| D-05 审批等级/金额门槛/快照有效 | T12 单决策约束、T15/16       | 权限如何表达门槛、非提交人检查、过期/重提规则和唯一决定前提；不发明阈值          |
| D-06 去重/人工提示（已批准）              | T06                          | 归一化例子、可见范围内提示、隐藏重复安全响应；不假造相似度业务算法               |
| D-07 交接业务语义               | T09                          | 批量请求/响应、事务边界、责任人与可见性区别、协作保留和跨团队目标规则            |
| D-08 CRM 枚举/字段（已批准）              | T04 受影响列、T06/07         | 最小字段/状态表、主联系人语义、跟进限制和终结规则                                |

业务负责人给业务决定，后端将其落实为 API/权限/模型与验收样例，评审记录写回 design-review-changelog.md。并非要求本轮停止等答复：本轮准备可完成，但后续开发任务必须尊重这些门禁。

## 4. NestJS 模块、目录和事务责任

建议路径均为将来的 `apps/api/src/<目录>`，本轮不创建目录/空 Controller。按可交付切片注册模块；Controller 仅承接运行时 DTO、身份及 HTTP，业务与权限在 Service。packages/shared 只放已实现的传输契约，不导出 Prisma 或业务 Service。

| 模块/目录                                                   | 责任及导出                                                                        | 直接依赖                                                              |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 既有 Auth/Authorization、audit、idempotency、infrastructure | 身份、原子执行、审计、共享 DB；扩展明确接口而非复制实现                           | 既有模块                                                              |
| SalesAccessModule / sales-access                            | 固定销售 action/scope 的 SQL where；当前写授权、锁集合解析与重验；不提供独立 HTTP | Authorization、共享 Database；不依赖 CustomersModule，避免循环        |
| CustomersModule / customers                                 | 客户、协作关系、联系人、分配及批量客户交接；导出接受 tx 的小范围归属校验/锁方法   | Auth、SalesAccess、共享 Database、Audit/Idempotency                   |
| OpportunitiesModule / opportunities                         | 商机、责任人、跟进、经批准的终结动作；导出接受 tx 的商机来源解析                  | 同上；复用 SalesAccess 客户范围                                       |
| CatalogModule / catalog                                     | 服务目录/参考价格和启停；输出可供报价复制的投影                                   | Auth、固定 CATALOG 权限、共享 DB、Audit/Idempotency                   |
| QuotesModule / quotes                                       | 报价容器、版本/行项、提交、接受证据元数据；导出同 tx 的来源快照读取               | Auth、SalesAccess、Opportunities、Catalog、共享 DB、Audit/Idempotency |
| OrdersModule / orders                                       | 来源解析、订单/明细、合同条款、审批轮次/快照/决定；导出 OrderTransactionService   | Auth、SalesAccess、Quotes、共享 DB、Audit/Idempotency                 |

审批是 OrdersModule 内的 `OrderApprovalService`，付款条款是 `OrderTermsService`；无需独立 Approval 微服务或 PaymentsModule。业务 Service 调用其他模块时传入同一个 tx；禁止被调 Service 另开事务或使用根 PrismaClient 写入。跨模块校验不得从 Controller 相互调用。

依赖方向为 `Orders → Quotes → Opportunities`、`Quotes → Catalog`，各销售模块依赖 SalesAccess 和同一个数据库注册对象；不反向依赖订单。客户交接与商机责任人修改共同依赖 SalesAccess；若批量操作需组合，只在明确 Service 内编排同 tx，不引入通用 workflow/strategy 引擎。

### 4.1 共同写入协议

1. HTTP DTO/身份→纯 JSON 规范化（ID/Decimal/UTC）→服务端稳定 operationId/targets→当前动作与对象范围预检。
2. 幂等组件独立预写 STARTED；在业务事务争 Key；完整相关用户锁在最前，再按角色→部门→客户→已有订单→子记录顺序当前读取并重验。用户/部门集合变化则整个事务回滚重计划，不能在持有客户锁后补锁更低层资源。
3. SalesAccess 提供锁计划和当前授权，Orders 内的公共入口负责参数化 orders FOR UPDATE、订单状态/版本检查和相同 tx 的下游操作；入口不再包装第二次 $transaction。订单创建没有既存行，先锁来源/归属及业务唯一性，插入后后续命令才锁 orders。
4. quote/version/目录/approval 等子记录的跨表锁等级、共享/排他模式在 T05/T13 写成明确表并实库测试；不是把全局 SERIALIZABLE 或 Redis 锁当替代品。客户归属/协作变更锁 customer，普通子资源写与其互斥；授权管理和团队变更遵循同协议。
5. 首次执行才检查业务状态、expectedVersion、职责分离、金额、证据和轮次；业务+成功审计+最终结果+attempt 成功同 tx 提交。重放重验当前权限而不拒绝旧业务版本；不在事务内上传附件或调用外部证据平台。
6. 确定回滚/提交未知分别沿用 ADR-003/005，不伪造失败；响应只存安全标量，重放返回原快照和本次 requestId。D-05 的审批人门槛应属于当前动作许可，状态/当前轮提交人约束属于首次执行规则，两者不可混淆。

### 4.2 新建实体的幂等/审计适配门禁（T03）

现有 IdempotentCommand.entityId 进入指纹，AuditService 还要求 attempt 的完整目标上下文与成功审计相同；它不能直接在执行后把 target 换成新自增 ID。每次调用先造随机目标或预写客户行会破坏重放或原子性。

T03 先评审并实现一个窄范围创建适配：请求目标保持稳定的服务端 collection/已有父对象标识；新实体 ID 只在原事务插入后产生；成功审计记录真实对象，attempt 仍保留原请求目标，并以真实 resultRef 关联。AuditService 必须显式校验原 attempt 上下文，只有可信执行回调可提供真实结果目标，不能取消 actor/requestId/attempt 状态校验。恢复/重放从已保存摘要和服务端约定恢复结果引用，无结果时不重做创建。既有命令的指纹 v1 黄金值和原上下文校验路径保持兼容；新增接口不假定该适配已经存在。若评审要求新持久化字段，单列新 Migration 按 ADR-004，不编辑旧迁移。本计划不预先伪造 SQL 或最终函数签名。

## 5. Prisma 逻辑模型、外键及索引计划

### 5.1 共通物理约束

- 模型 PascalCase、属性 camelCase、数据库 snake_case；实体 id 与全部 FK 为 BIGINT UNSIGNED（Prisma BigInt），version 为 UNSIGNED INT 初始 1；时间 DATETIME(3)/UTC。字符串技术长度在每个 DTO/Schema 任务中一并固定，避免 DTO 接受而库截断。
- 金额 Decimal(18,2)，币种 CHAR(3) CNY；数量列精度依 D-01 确认，不先猜 Decimal 位数。外部编号独立唯一，用服务端随机编号/数据库可并发方案，长度与碰撞有限重试评审后固定，不用无锁 MAX+1。
- 下表除明确可空外，父 FK 必填；所有历史/业务关系 onDelete/onUpdate RESTRICT。created_by、submitted_by、accepted_by、approver_id、author_id 等均 FK users，保留停用历史；不要给全部表机械添加软删字段。
- 所有新 CREATE TABLE 显式 utf8mb4/utf8mb4_0900_ai_ci；CHAR/VARCHAR/ENUM 字符列核查实际 collation，不改 _prisma_migrations。唯一性受到大小写/重音排序规则影响，代码与规范化例表要一致。
- 单列 FK 仅保证存在，来源链/父子一致还需同 tx 校验，能用无冗余结构或复合唯一/FK加强时在 SQL 审查中明确；不能声称普通 FK 已校验整条来源链。

### 5.2 模型清单

`UK` 表示业务唯一约束，`IX` 表示查询索引；复合索引列顺序按真实 where/排序验收，避免与 PK/UK/FK 的前缀索引重复。此表不是可执行 Schema。

| Prisma / 表                                      | 必需字段与关系（通用 id/时间略）                                                                                                                                                | UK / IX 与应用不变量                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer / customers                             | name、normalized_name、可空 credit_code；owner_id→User；status/version/created_by；名称不唯一                                                                                   | UK(credit_code)，多个 NULL 合法；IX(owner_id,status,created_at,id)、IX(normalized_name)；credit_code 归一化 D-06，status D-08                        |
| CustomerMember / customer_members                | customer_id→Customer、user_id→User；协作语义/必要 member_role                                                                                                                   | 复合 PK 或 UK(customer_id,user_id)；IX(user_id,customer_id)；主负责人单独保存；资格/修改只经 assign                                                  |
| CustomerContact / customer_contacts              | customer_id→Customer；name、可空 phone/email；主标记与 version、created_by                                                                                                      | IX(customer_id,created_at,id)；已批准至多一个有效主联系人；客户锁自动切换+可空生成客户键 UNIQUE，不能仅检查后 insert                                                           |
| Opportunity / opportunities                      | customer_id→Customer、owner_id→User（仅责任）、title、description?、stage、close_reason?、closed_at?/version/created_by；expected_amount 等 D-01 后批次 B 扩展                                                                     | IX(customer_id,stage,created_at,id)、IX(owner_id,stage)；一个客户多商机；owner 不赋予独立可见性；stage/金额边界 D-08/01                              |
| FollowUp / follow_ups                            | opportunity_id→Opportunity、author_id→User；content、next_follow_up_at?、correction_of_id?；customer 从商机推导，不冗余                                                                      | IX(opportunity_id,created_at,id)；只追加，不开放历史修改/删除；当前接口仅商机跟进                                                                    |
| ServiceProduct / service_products                | code/name/base_price/status/version/created_by                                                                                                                                  | UK(code)；按 status/稳定分页评估 IX(status,created_at,id)；停用/改价不影响已复制报价                                                                 |
| Quote / quotes                                   | opportunity_id→Opportunity；quote_no、current_version_no、version/created_by；status 如非必要从版本派生，不另造流程                                                             | UK(quote_no)；IX(opportunity_id,created_at,id)；quote 行锁分配版本号                                                                                 |
| QuoteVersion / quote_versions                    | quote_id→Quote；version_no、锁 version、status、currency/amount、valid_until?、content_hash；submitted/accepted 元数据与 User FK                                                | UK(quote_id,version_no)；按接受/到期查询确定 IX(quote_id,status,valid_until)；证据形式/状态 D-02；提交后内容不可变                                   |
| QuoteVersionItem / quote_version_items           | quote_version_id→QuoteVersion、product_id?→ServiceProduct；line_no/description_snapshot/quantity/unit_price/amount                                                              | UK(quote_version_id,line_no)；product FK 反向索引；价格/描述独立快照；D-01 确定计算                                                                  |
| Order / orders                                   | order_no；customer_id→Customer、opportunity_id→Opportunity、source_quote_version_id→QuoteVersion；status/contract_amount/currency/version/created_by；正式条款接受引用/内容绑定 | UK(order_no)；来源 UK/有效唯一方案等 D-04；IX(customer_id,status,created_at,id)、IX(status,created_at,id)、来源/商机 FK 索引；服务端检查完整来源一致 |
| OrderItem / order_items                          | order_id→Order、source_quote_item_id?→QuoteVersionItem；line_no/描述/数量/单价/金额快照                                                                                         | UK(order_id,line_no)；来源反向索引；来源 item 必须属于订单来源版本；M1 草稿修改许可 D-04                                                             |
| PaymentTerm / payment_terms（合同条款前置）      | order_id→Order；plan_version/term_no/due_amount/currency；到期/首付字段 D-03；不设实收字段                                                                                      | UK(order_id,plan_version,term_no)；金额计划与订单一致由 tx 校验；M2 才接入应收/到账规则                                                              |
| OrderApprovalRound / order_approval_rounds       | order_id→Order、round_no、order_version、snapshot_schema_version、snapshot_json/hash、status、submitted_by→User/submitted_at、ended_at?                                         | UK(order_id,round_no)；IX(order_id,status)；订单行锁保证单活动轮次；snapshotVersion 由 round_no 输出，不重复增加同义列；结束原因区分拒绝/撤回        |
| OrderApprovalDecision / order_approval_decisions | approval_round_id→Round、approver_id→User、decision/reason/decided_at                                                                                                           | UK(approval_round_id) **须 D-05 确认单级**；approver FK 索引；不自审批；并发仅一个决定                                                               |

合计 14 个 M1 候选模型（其中 PaymentTerm 为必要合同前置）；不要求一次创建。D 项会影响列定义和 UK，未解决时只推进不受影响批次，不先加“临时业务默认值”。orders 的 delivery_manager_id/effective_scope_version 在 M2 按真实需求新增，不提前建交付/财务空表。客户 industry 的迁移示例是 ADR-004 的演进教学，不是自动增加 industry 的业务需求。

审批快照、接受依据元数据、付款条款在 Orders/Quotes 内保存，不新建通用 evidence、workflow、event、strategy、approval_engine 或额外锁表。完整证据外部系统若确有需求需另行决策，本轮不承诺实现。

### 5.3 增量 Migration 批次与发布

| 批次（将来由 Prisma 生成真实时间戳） | 内容与依赖                                                             | SQL/兼容性验收                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A `m1_crm`（T04）                    | Customer/Member/Contact/Opportunity/FollowUp；D-06/08 已批准；不含 expected_amount | 既有 M0 仅增加必要反向关系；空库从 M0 起升级、历史 M0 数据升级保留；真实 FK/UK/NULL/collation、BR-006 并发；同步 M0 测试范围 |
| B `m1_catalog`（T08）                | ServiceProduct；D-01 批准后同时追加 Opportunity.expected_amount 可空列，不预设零/负值语义        | 唯一 code、状态、Decimal/边界检查；历史目录变更不影响后续快照                                                                |
| C `m1_quotes`（T10）                 | Quote/Version/Item；依赖 A/B 与 D-01/02                                | 空/已有客户商机升级；版本/行序唯一、产品 FK、提交不可变的 Service 测试；不回填虚构接受证据                                   |
| D `m1_orders`（T12）                 | Order/Item/PaymentTerm/Round/Decision；依赖 C 与 D-01～05              | 先把受批合同条款和快照结构一起前置，避免“有 submit 无条款表”；唯一性/引用链、审批并发和历史快照持久化                        |
| E 按需追加（T03/T17）                | 仅评审证明确需的创建适配列、索引或纠正；不预先造文件                   | 既有数据先可空扩展→受控回填/核验→独立 Contract；不重写旧 SQL，不假设 down migration                                          |

每批执行次序：明确契约→改 schema→在获准专用 dev/shadow 库 `migrate dev --create-only --name ...`→审查真实 SQL/锁风险/显式 collation→提交 schema+SQL+测试→在获准测试库应用。生产只 migrate deploy，且必须先备份并验证恢复。当前任务不运行这些命令、不建库、不编写时间戳 SQL。

新表是 Expand；M0 历史账号/审计无业务回填，不能给每个旧用户自动分客户或业务权限。每批在全新库和保留身份/审计数据的历史库验收，比较迁移前后计数/校验、数据库实际约束和已应用 checksum；新旧版本兼容、失败恢复与备份还原报告纳入 T17。不存在未经评审的手工 ALTER、db push/reset 或自动 down。

## 6. 需求—API—权限—实体—测试追踪

下列路径省略 `/api/v1`，大括号表示各动作分别展开。T 编号与 §7 对应；业务语义由现行需求或明确标注的技术假设提供，不增造 BR。M2/3 的规则只标边界，不纳入本次 M1 实现。

| 依据                     | API/能力                                                                                   | 权限与范围                                                                         | 数据实体                                           | 任务/关键场景                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| BR-001                   | GET/POST customers；GET/PATCH customers/:id；POST assign；GET/POST contacts、PATCH contact | customer:create/read/update/assign；本人/协作、TEAM/ALL 配对；目标范围             | Customer/Member/Contact                            | T04/05/06/09；一个 owner、多协作、越权/父子错配、分配后旧范围消失             |
| BR-002                   | GET/POST opportunities；GET/PATCH /:id；close-won/lost；GET/POST follow-ups                | opportunity:create/read/update；当前父客户范围，owner 不独立授权                   | Opportunity/FollowUp                               | T07；同客户多个商机、客户移交后继承、终结规则 D-08                            |
| BR-003                   | POST 商机 quotes、POST versions、GET quotes/versions、POST submit                          | quote:read/create/submit；销售范围                                                 | Quote/Version/Item、ServiceProduct                 | T08/10/11；V1/V2 独立、改目录不改历史、并发版本号、不覆盖提交内容             |
| BR-006                   | 客户创建/更新的信用代码唯一与受限疑似重复提示                                              | customer:create/update/read；不可泄漏不可见客户                                    | Customer/Contact                                   | T04/06；归一化重复并发一成功、多 NULL、相似名不阻断、隐藏重复安全错误         |
| BR-007                   | POST quote version record-acceptance；POST orders；GET order                               | quote:record_acceptance、order:create/read；完整来源链                             | QuoteVersion、Order/Item                           | T03/11/12/14；未接受不能下单、过期/证据 D-02、来源错配404、不同 Key 唯一 D-04 |
| BR-005、需求 §4          | PATCH 草稿；submit/approve/reject/withdraw、GET approvals                                  | order:update/submit/approve/reject/withdraw/read；非提交人及门槛                   | Order/Item/PaymentTerm/Round/Decision              | T13～16；CONFIRMED 普通 PATCH 不可改合同，已结束不能新决定，重提留历史        |
| BR-008（M1 前置部分）    | 订单草稿合同付款条款与 submit 快照                                                         | order:create/update/submit/read；不是 payment:confirm                              | PaymentTerm、Round.snapshot                        | T12/14/15；无条款/证据拒绝；**不验证到账/豁免/交付启动**，留 M2               |
| BR-010                   | 受控 disable/角色分配、客户 assign、批量客户/商机交接（路由待 D-07）                       | user:manage/role:manage + 保护规则；customer:assign 与待确认商机交接权限；目标团队 | User/Session/UserRole、Customer/Member/Opportunity | T01/05/09；停用会话失效、历史 actor 留存、跨团队拒绝、责任人与授权区分        |
| 需求 §1/6、API §2.3      | GET/POST service-products、PATCH /:id                                                      | product:read/manage + CATALOG                                                      | ServiceProduct                                     | T08；无默认管理员放行、改价和停用不改报价快照                                 |
| INV-006、ADR-001/003/005 | order submit/approve/reject/withdraw 与所有强副作用命令                                    | 当前动作/范围，重放重新授权                                                        | Order/Round/Decision、Audit/Attempt/Idempotency    | T02/03/13/16/17；相反审批、撤回竞争、同 Key/不同 Key、断言实际一次副作用      |
| DC-001、权限 §4          | 全部列表/详情/命令/重放                                                                    | 同条动作+scope；SQL 过滤；TEAM 动态；不存在的 M2 scope 拒绝                        | 权威身份/组织和当前 Customer 根                    | T01/05/09/17；撤权/移交与写并发、计数不泄漏、字段白名单                       |
| BR-004/009、INV-004/005  | 收款/冲正/启动/取消/完成等未来 API                                                         | M2/M3 后评审，不在 M1 放行                                                         | 尚未建表的财务/交付/申请实体                       | M1 仅保留共同订单锁入口；相关真实不变量待 M2/M3，不把 mock 空结果当通过       |

具体端点的稳定 operationId、DTO 字段和错误码在对应 T 任务提交前写回 API；permissions seed 只校对，不自动覆盖现有角色或扩大已有权限。新业务接口的 OpenAPI 与权限映射必须一一对应，未实现的接口不进入生成文档。

## 7. 可独立提交的任务与验收

每项含实现、必要自动化测试、文档和评审修订；任何涉及 schema 的提交必须带受审查 Migration。建议提交主题为 `feat/test/chore(m1): <任务内容>`；不合并所有 Controller 到一次提交。大于 5 人日的任务可再按“数据/Service/HTTP”拆提交，但各提交要可编译、可验证，受阻 HTTP 不提前注册。

| ID / 建议提交主题                                                 | 直接依赖及工作量（人日）           | 交付及验收/测试场景                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T00 `docs(m1): resolve implementation contract gates`             | 本计划；2～4（不含等待业务答复）   | 将 D-01～08 分项形成决定、DTO/状态表/响应例子和测试期望；更新 DC 状态。未决定的功能仍阻断，不用代码默认值代答。可按 CRM/报价/审批分批签收                                                                                                                                                                                    |
| T01 `feat(identity): prepare controlled M1 identities`            | 无业务表依赖；5～8                 | 最小受控账号/首位负责人初始化（显式输入、秘密不落日志/仓库、幂等冲突不覆盖），复用 hashPassword；最小 assign-roles/disable 及模板/自授/最后负责人保护。无完整身份编辑时入口保持关闭；真实 MySQL 测试两个负责人并发撤销/停用、管理员自授拒绝、cv/会话撤销、历史 actor 保留、用户→角色锁顺序、审计失败回滚；不自动创建真实账号 |
| T02 `feat(audit): add bounded attempt reconciliation`             | 无业务表依赖；2～3                 | 复用 markOverdueUnknown 接入显式有界作业/CLI 与运行手册；多执行器竞争幂等、到期条件、锁等待有限、不覆盖 SUCCEEDED/REPLAYED；恢复结果证据不足保持 UNKNOWN，不能仅凭无 Key 宣称失败或自动重执行业务；不开清理任务先删线索                                                                                                      |
| T03 `feat(idempotency): support audited entity creation`          | 无业务表依赖；2～3                 | 按 §4.2 先评审窄适配；真实 MySQL 创建夹具证明稳定指纹、一次插入、真实对象审计/resultRef、提交未知恢复；不同请求冲突、失败释放 Key、越权不能重放；旧 v1 指纹和全部 M0 回归不变；不修改历史 Migration                                                                                                                          |
| T04 `feat(crm): add customer opportunity persistence`             | T00 中 D-06/08 受影响定义；2～3    | 批次 A；FK/UK/索引/字符集/UTC/RESTRICT、多个 NULL、并发信用代码冲突；演进整库表/FK/CHECK断言为 M0 精确子集+当前全清单，保留历史 checksum 校验，其他 M1 批次同步更新全清单；空库/历史 M0 升级测试不改旧迁移                                                                                                                   |
| T05 `feat(authorization): add fixed sales scopes and write locks` | T01/T04；4～6                      | SQL where 的 SELF_COLLABORATOR/TEAM/ALL，CATALOG 单独配对；同一快照授权+列表+总数；ReadCommitted 写入重验/锁集合；本人/协作/上下级/跨团队/无部门/停用部门/错误scope/角色名伪装；成员或部门变动与业务写竞争、集合变化回滚；未实现财务/项目 scope 默认拒绝                                                                     |
| T06 `feat(customers): add scoped customers and contacts`          | T03/T04/T05；D-06/08；3～5         | 按 §6 逐个开放客户/联系人路由；运行时 DTO、字段/长度/null、BigInt、分页稳定排序、信用代码/提示、父子关系；create actor owner；PATCH 不收 owner/成员；联系人正文不进幂等摘要/日志；401/403/404/400/409、版本竞争、回滚无成功审计                                                                                              |
| T07 `feat(opportunities): add opportunities and follow ups`       | T03/T04/T05/T06；D-08；3～4        | 商机/跟进列表详情创建编辑及经确认的 close 动作；终结后编辑规则、丢单原因、作者身份；同客户多商机、错误父客户、旧 owner 不能越过客户范围、版本冲突；赢单不偷偷确认订单；跟进仅追加                                                                                                                                            |
| T08 `feat(catalog): add versioned service products`               | T00 中 D-01、T03/T05；2～3         | 批次 B+目录 HTTP；code 唯一、Decimal 字符串、显式 CATALOG/管理权限、启停和乐观锁，非管理员旁路；后续 T11 补跨模块改价不改历史回归                                                                                                                                                                                            |
| T09 `feat(crm): add controlled assignment and bulk handover`      | T01/T03/T05/T06/T07；D-07；3～5    | 单客户 owner/协作修改及批量客户/商机责任交接；先落定各 API/权限/数组上限和事务失败语义，再实现；源/目标团队、有效销售资格、版本/父子链；旧协作保留按决定测试；同一客户交接与订单写/重放竞争在 T17 回归；userLocks 100 项上限提前校验，无整库批量写                                                                           |
| T10 `feat(quotes): add immutable version persistence`             | T04/T08；D-01/02；2～3             | 批次 C；FK、quoteNo/版本/行号唯一、产品引用/RESTRICT、原始快照和提交接受元数据；并发版本序号与行项原子创建；无额外销售阶段引擎                                                                                                                                                                                               |
| T11 `feat(quotes): implement version submission and acceptance`   | T03/T05/T07/T08/T10；D-01/02；4～6 | 完整创建/读取/提交/接受，动作与 scope 配对；新版本/目录变化不改旧内容，哈希/证据不匹配拒绝；有效期等边界依决定；未知字段、负/溢出/舍入、越权、嵌套错配、并发提交/接受、审计回滚和 Key 重放                                                                                                                                   |
| T12 `feat(orders): add contract terms and approval persistence`   | T10；D-01～05；3～5                | 批次 D，一次前置必要的条款/完整快照结构；来源链、金额精度、来源唯一假设与单级决定约束均有已批准依据；round JSON 能独立还原/复算；历史账号/报价不可级联删除，不新增 M2 表                                                                                                                                                     |
| T13 `feat(orders): add shared order transaction protocol`         | T03/T05/T12；3～4                  | OrderTransactionService 运行于已有 tx、orders 参数化行锁、固定子记录锁序、当前授权/来源重验；真实 MySQL 竞争锁、角色撤销、客户交接、死锁/超时、异常回滚；不嵌套事务，不为锁改订单状态，不写 M2 假阻断查询                                                                                                                    |
| T14 `feat(orders): create and edit audited order drafts`          | T03/T11/T12/T13；D-01～04；3～5    | 接受报价→草稿/行快照/条款/证据；草稿 PATCH 白名单和整体条款替换；拒绝来源错配/未接受/重复来源，过期依据按决定；同 Key 一次创建、不同 Key 业务唯一仍成立、Decimal/版本冲突；CONFIRMED 不可普通编辑                                                                                                                            |
| T15 `feat(orders): freeze and expose approval snapshots`          | T14；D-03/05；3～4                 | submit 与审批历史读取；完整性/证据绑定验证、冻结 schema version/hash/轮次/PENDING 同事务；旧快照不受目录/报价/重新提交影响；大快照容量上限、字段投影、失效证据、审计失败回滚、重复 submit 和并发提交                                                                                                                         |
| T16 `feat(orders): implement approval rejection and withdrawal`   | T15；D-05；3～5                    | approve/reject/withdraw；审批人非提交人及门槛、round 属于订单、expectedVersion、单次决定；两个相反审批、approve vs withdraw、旧轮次/新 Key 冲突；拒绝原因、撤回身份、重提留历史；同 Key 重放不以旧版本拒绝；审计/attempt/业务原子性                                                                                          |
| T17 `test(m1): verify the complete sales to order flow`           | T01～16，D 全部闭合；4～6          | 真实 HTTP 登录→新建客户→商机→报价 V1/V2→客户接受→草稿条款→提交→他人确认，外加交接/撤权/重放；全角色字段投影、404不可见、无银行/凭据泄漏、提交未知/故障/并发；空库与历史升级、备份恢复、schema/migration一致性、CI 同脚本与 SQL 审查；未决功能不得以 skip 算通过                                                              |

“独立提交”不表示没有依赖；依赖未合入时任务保留分支/草案，不向主分支提交无法构建的半成品。每项验收最少包括 lint/typecheck/build、对应普通测试、实库权限/约束/并发测试、Swagger/OpenAPI 对照及失败路径，不只验证 happy path。

## 8. 依赖关系与工作量

下表为精确依赖边的简要视图，细分 D 决策见 §3；可独立推进表示任务层面，不要求多 agent 或另起进程。数据库 Schema/Migration 交付仍顺序审查，避免并发生成迁移冲突。

| 阶段 | 先决链                                        | 可独立推进的工作                                               |
| ---- | --------------------------------------------- | -------------------------------------------------------------- |
| 前置 | T00 决策 + T01 身份 + T02 核对 + T03 创建适配 | T01/02/03 不依赖业务表；T00 可逐项完成                         |
| CRM  | T04→T05→T06→T07→T09                           | T08 目录在 T05/T03 与金额决定后可推进                          |
| 报价 | T07/T08→T10→T11（精确依赖按 §7）              | T10 在持久化依赖满足后可先于部分 HTTP 完成，不提前注册报价接口 |
| 订单 | T10→T12→T13；T11/T13→T14→T15→T16              | T12/13 可与 T11 的 HTTP 实现交错推进，不能绕过 D-01～05        |
| 验收 | T02/T09/T16 及所有其余任务→T17                | 约束/单模块测试随任务完成，不留到 T17 才补                     |

单名熟悉 NestJS/Prisma/MySQL 的后端工程师，含实现、测试、文档和常规 review 修订，T00～17 合计 **53～82 人日**（按每工作日 1 人日，约 11～17 个工作周）。不是固定交付日期或业务承诺，不含业务答复等待、组织数据整理、生产环境审批/部署、前端开发或正式法务/证据系统集成。估算不是依据外部价格或人员 SLA。

建议预留约 15%～20% 风险缓冲，整体资源预算约 **61～99 人日**；遇到多级审批、复杂税折/里程碑条款或证据系统需求需重新估算，不默默塞进当前任务。先验收 T00～05 和第一个客户切片，再以实际速度更新后续估算，不一次性承诺全部 Controller 日期。

## 9. 风险及处置

| 风险                                           | 影响与处置                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 将“M0 集成测试通过”误认为业务权限/写管理已完成 | 未授权读取/写入；T01/T05 是首个业务写入口前置，不手动扩权绕过                                                   |
| DC-005/010 和 D 决策未定                       | 模型/金额/证据/审批反复；按功能门禁停止受影响编码，先补样例和决定，不提前关闭审查项                             |
| 新实体 ID 与预写/成功审计上下文冲突            | 重试重复创建、审计目标不实；T03 专项故障/恢复测试，保留旧指纹兼容性                                             |
| TEAM 动态组织、角色/成员变动与业务写交错       | TOCTOU 或死锁；完整锁集合、当前读、统一等级，目标集合变化回滚重计划；缺部署组织数据不假造                       |
| 批量交接过大、userLocks 上限/事务 10 秒        | 大锁集合/超时；D-07 确认事务语义，DTO 有界、服务端锁集合预检查；不改超时来掩盖无界请求                          |
| 单报价唯一性与未来终态重建冲突                 | 过强约束或并发重复；D-04 决定后才定 UK，幂等不能替代业务唯一性                                                  |
| 只存 hash 或把审计 JSON 当合同                 | 历史不可恢复/泄露；完整独立快照、版本化规范及投影；幂等只保存标量摘要                                           |
| 新表让 M0 实库测试固定计数失败                 | 回归误报或为过关削弱约束；T04 保留 M0 精确子集和新全库清单，T10/12 同步扩展                                     |
| 迁移被重写、MySQL DDL 非原子/版本差异          | 历史漂移/数据丢失；ADR-004 增量审查、空库/历史库/恢复演练；本地 8.4.13 与 CI 8.4.7 均需实际验证，不声称已跑远端 |
| 将合同付款条款扩成财务模块或借后续需求造表     | 任务失控；M1 不开放 payment/delivery/refund/申请 API，M2 再按真实模型迁移                                       |

## 10. 本轮交付、验证及停止点

本轮文件：新增本计划；定点修订 requirements.md §13.1、data-model.md §8/10/11、api-design.md §9、permission-matrix.md §9、design-review-changelog.md 的 M1 准备记录，并在 engineering-initialization.md 记录此次纯文档准备。不覆盖历史 ADR/迁移、不改变 BR-001～010。

验证采用现有项目命令和文档一致性核对；实际执行结果见工程初始化记录的同日 M1 准备条目。旧测试运行不能验收尚未编写的 M1 功能；本轮没有生成新 OpenAPI 路由、应用 Migration 或执行受控账号初始化。未来 T17 还需独立的 M1 实库和迁移/恢复报告。

停止点：本准备任务完成即停止；不从 T01 或其他任务自动开始编码。下一轮可明确选择前置任务或首个已满足门禁的切片；DC-005/010 仍需相应业务决定，不能跳过进入订单审批开发。

## 11. D-06/D-08 批准后的 T04 准入复核

2026-10-30 业务负责人批准全部推荐方案，无另附修订；D-06/D-08 的业务定义、DTO/枚举、响应/异常、权限、状态/并发验收已同步正式文档，因此 T04 直接业务门禁已满足，可在下一轮进入批次 A 实施。T01 和完整 T05 是后续业务 HTTP 前置，不在原依赖图中阻断 T04 持久化设计。

已批准范围补充：T06 包含只读 POST duplicate-check、archive/restore、联系人 deactivate；T07 包含 change-stage 和 follow-up.correctionOfId。客户两态、商机五阶段、有效主联系人零或一、跟进仅追加按正式契约，不重拆 T00～T17。expected_amount 从 A 移至 D-01 明确后的 B，非金额 CRM 可独立交付。

T04 运行 migrate dev 前仍须确认获准专用 dev/shadow 数据库、凭据、连通性、已有 seed/历史基线及可验证的空库/历史库环境；历史测试连通记录不是当前授权或连接证明，不自动建库/启服务。主联系人生成列的 Prisma/SQL 映射、FK/CHECK/索引与 collation 是待 T04 完成的技术审查；CustomerMember 的既有结构可落库，D-07 未决的资格/批量交接/协作限制不可猜测入库。受审查真实 SQL、空库/历史 M0 升级、checksum/全清单/并发测试通过前不标 T04 完成。生产部署仍须 ADR-004 兼容及备份恢复流程。

本次只更新文档，不启动 T04，不生成 Schema/Migration，不改变 ADR 或 BR-001～010。
