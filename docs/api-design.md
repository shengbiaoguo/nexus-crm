# Nexus CRM — API 契约设计 V0.2

- 日期：2026-10-29
- 状态：**设计草案 / 待实现验证**；非已经实现的 OpenAPI 文件
- 依赖：`requirements.md` V0.7、`permission-matrix.md` V0.2、`data-model.md` V0.2、ADR-001/003/004/005；ADR-002 已被 ADR-005 替代
- 边界：内部员工使用、单企业、REST JSON、模块化单体 NestJS + MySQL + Prisma；不包含客户端在线支付或银行直连
- 优先级：M0 身份权限；M1 客户→商机→报价→订单；M2 交付与财务；M3 变更/取消/终止

## 1. API 基本规范

### 1.1 基础与版本

- Base URL: `/api/v1`；TLS/HTTPS 必需（本地开发除外）；JSON 使用 `application/json; charset=utf-8`。
- 集合资源采用复数名词，如 `/customers`、`/orders`。路径中的 `:id` 为十进制 **字符串**，映射 MySQL BIGINT，JS 不转换为 Number。
- 读取用 GET，创建用 POST，受限字段编辑用 PATCH；**状态转换一律为动作命令 POST**，禁止 `PATCH /orders/:id {"status":"COMPLETED"}`。
- `DELETE` 仅用于允许彻底删除的无业务引用草稿/辅助数据；核心客户、报价版本、订单、收款及审计记录不提供物理删除端点。
- 关键命令附带 `Idempotency-Key: <UUID>`；针对已读取版本的更新/审批携带 `expectedVersion`；请求链路使用 `X-Request-Id`（由网关/服务器生成或验证，无条件信任客户端值不可取）。
- `Authorization: Bearer <accessToken>`。权限校验顺序：认证 → 动作权限 → 对象级数据范围 → 职责分离 → 在事务中重验业务状态及版本。对于不可见对象，允许统一返回 404 防止对象枚举。
- 输入 DTO：未知字段拒绝（对应现有 `ValidationPipe`），字符串去空格、长度和枚举受控；`null` 与字段缺失语义不同；金额以小数**字符串**传输（如 `"35000.00"`），币种 `CNY`。
- 默认时间 RFC 3339 UTC，如 `2026-10-29T06:10:00.000Z`。不在通用 DTO 中接收客户端决定的 `createdBy`、`ownerRole`、`approvedBy` 等受保护字段。
- CORS、速率限制、请求体大小、导出上限属于部署配置，具体阈值待确认。

### 1.2 统一成功响应

HTTP 状态码真实表达结果；不要把所有错误包装成 200。统一包裹 `data` 和 `requestId`；仅列表包含 `meta`。`204 No Content` 无响应体。

单对象 `200/201`：
```json
{
  "data": { "id": "10001", "status": "DRAFT", "version": 1 },
  "requestId": "req_01JABC..."
}
```

列表 `200`：
```json
{
  "data": [{ "id": "10001", "name": "宏达制造有限公司" }],
  "meta": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 },
  "requestId": "req_01JABC..."
}
```

幂等请求重放时返回首次 HTTP 状态与业务结果快照，并在响应头加入 `Idempotency-Replayed: true`；`requestId` 用本次链路 ID（不强求字节级重放完整 HTTP 头）。结果并非当前订单的最新状态；客户端可重新 GET。

### 1.3 统一错误响应

```json
{
  "code": "ORDER_STATE_CONFLICT",
  "message": "当前订单状态不允许该操作",
  "details": { "expected": "PENDING", "actual": "CONFIRMED" },
  "requestId": "req_01JABC..."
}
```

- `details` 为安全、结构化、可选信息，不包含堆栈、SQL、凭据或越权资源详情。
- 字段校验错误 `400 VALIDATION_FAILED`：`details.fields = [{"field":"amount","reason":"must be decimal string"}]`。
- 错误 `code` 是稳定机器标识；`message` 是可读文案，不应被前端解析以判断业务分支。
- 生产环境 500 返回泛化文本，内部详情写入结构化运行日志。

### 1.4 通用 HTTP 状态与业务错误码

| HTTP | Code | 含义 / 处理 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | DTO 字段非法、参数未知、格式不合规 |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | 未认证或 access token 过期 |
| 403 | `PERMISSION_DENIED` / `SELF_APPROVAL_FORBIDDEN` | 动作/数据范围/职责分离拒绝 |
| 404 | `RESOURCE_NOT_FOUND` | 不存在，或按策略隐藏无权访问的对象 |
| 409 | `ORDER_STATE_CONFLICT` | 当前状态不允许转换 |
| 409 | `VERSION_CONFLICT` | 乐观并发冲突，需重读 |
| 409 | `BUSINESS_RULE_VIOLATION` | 唯一键/业务前置条件冲突；具体模块优先用细分码 |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 相同幂等标识对应不同请求语义 |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | 同键请求尚在执行，可配 `Retry-After` |
| 409 | `DELIVERY_ALREADY_STARTED` | 不能走普通取消流程 |
| 409 | `DELIVERY_NOT_ACCEPTED` | 未满足当前有效交付验收条件 |
| 409 | `BLOCKING_APPLICATION_EXISTS` | 有冲突的待处理申请 |
| 409 | `PAYMENT_ALREADY_REVERSED` | 收款不能重复冲正 |
| 409 | `CUSTOMER_CREDIT_CODE_EXISTS` | 企业信用代码唯一冲突 |
| 422 | `PAYMENT_AMOUNT_INVALID` | 金额业务约束不成立 |
| 429 | `RATE_LIMITED` | 限流，返回 Retry-After（适用时） |
| 500 | `INTERNAL_ERROR` | 非预期服务错误 |
| 503 | `SERVICE_UNAVAILABLE` | 必需依赖不可用、不能安全完成请求 |
| 503 | `AUDIT_UNAVAILABLE` | 关键尝试预写或失败记录无法持久化；不宣称业务成功/确定失败 |
| 503 | `IDEMPOTENCY_RESULT_UNKNOWN` | 提交结果尚不能核实，保留原 Key 核对，禁止换 Key 自动重做 |

注：数据库唯一约束失败通常映射特定 409；是否以 400 或 422 表达语义错误保持项目内一致，此处建议格式错误用 400、业务金额语义错误用 422。未执行成功时不产生成功审计。

### 1.5 列表、排序与筛选

- `page` 从 1 开始；`pageSize` 默认 20、最高 100；偏移分页用于 V1 内部后台，后续大数据集合可切到游标模式。
- `sortBy` 必须为模块白名单字段，`sortOrder=asc|desc`；默认 `createdAt desc, id desc` 保障稳定排序。
- 过滤字段明确列入端点定义；未授权的列表必须在数据库查询层施加数据范围条件，不先查所有数据再由前端隐藏。
- 搜索统一 `q`，模糊匹配须限定字段与索引策略；全量导出单独设计。

## 2. 接口清单（OpenAPI 风格摘要）

说明：标记 `M0/M1/M2/M3` 为计划实施里程碑；本表**不表示接口已经实现**。`P` 为操作权限码；读取仍附加数据范围检查。

### 2.1 系统、身份与角色（M0）

2026-10-30 认证实现注记：JWT + Refresh Token 的四个认证端点已实现，DTO、有效期、错误与边界见 [认证契约](authentication.md)。其他接口的实现范围以以下 RBAC 注记为准。

2026-10-30 RBAC 实现注记：本次另实现 GET `/users`、`/users/:id`、`/roles`、`/permissions`、`/departments` 的 M0 读取授权。权限配对、对象范围、分页和字段投影见 [授权契约](authorization.md)。用户/角色写接口及其他业务模块仍未开放。

| Method | Path | 用途 | P / 备注 |
|---|---|---|---|
| GET | `/health` | 探活 | 开发/运维，公开内容受限 |
| POST | `/auth/login` | 账号密码登录 | 频率限制，错误不泄露账号存在性 |
| POST | `/auth/refresh` | 刷新短期 access token | Refresh rotation，防重放 |
| POST | `/auth/logout` | 注销当前会话 | 认证有效 |
| GET | `/auth/me` | 当前身份、权限摘要 | 认证有效 |
| GET | `/users` | 用户列表 | `user:manage` |
| POST | `/users` | 创建员工账号 | `user:manage` |
| GET | `/users/:id` | 查询员工 | `user:manage` 或本人受限资料 |
| PATCH | `/users/:id` | 修改员工非敏感字段 | `user:manage` |
| POST | `/users/:id/disable` | 停用员工并撤销会话 | `user:manage`，幂等命令 |
| POST | `/users/:id/assign-roles` | 分配角色 | `role:manage`；业务角色另需 `role:grant_business`，禁止自授，审计 |
| GET | `/roles` | 角色列表 | `role:manage` |
| POST | `/roles` | 创建角色 | `role:manage` |
| PATCH | `/roles/:id` | 编辑角色 | `role:manage` |
| GET | `/permissions` | 权限字典 | `role:manage` |
| PUT | `/roles/:id/permissions` | 替换权限及固定 scope 集合 | `role:manage`；业务角色另需 `role:grant_business`，版本检查/审计 |
| GET | `/departments` | 部门树 | `department:read`，仅 id/name/parentId |

### 2.2 CRM 客户与商机（M1）

| Method | Path | 用途 | P / 备注 |
|---|---|---|---|
| GET | `/customers` | 客户列表 | `customer:read` + SELF/COLLABORATOR/TEAM/ALL（动作与 scope 成对） |
| POST | `/customers` | 新建客户 | `customer:create`，信用代码数据库去重 |
| GET | `/customers/:id` | 客户详情 | `customer:read` + 数据范围 |
| PATCH | `/customers/:id` | 更新允许字段 | `customer:update`，`expectedVersion` |
| POST | `/customers/:id/assign` | 主负责人变更/协作调整 | `customer:assign`，审计归属变更 |
| GET | `/customers/:id/contacts` | 联系人列表 | 客户读取权限 |
| POST | `/customers/:id/contacts` | 增加联系人 | `customer:update` |
| PATCH | `/customers/:id/contacts/:contactId` | 编辑联系人 | `customer:update` |
| GET | `/opportunities` | 商机列表 | `opportunity:read` + 数据范围 |
| POST | `/opportunities` | 创建商机 | `opportunity:create` |
| GET | `/opportunities/:id` | 商机详情 | `opportunity:read` |
| PATCH | `/opportunities/:id` | 编辑未终结商机 | `opportunity:update` + 版本 |
| POST | `/opportunities/:id/close-won` | 赢单 | `opportunity:update`，不可替代订单确认 |
| POST | `/opportunities/:id/close-lost` | 输单 | `opportunity:update`，原因必填 |
| GET | `/opportunities/:id/follow-ups` | 跟进记录 | `opportunity:read` |
| POST | `/opportunities/:id/follow-ups` | 新增跟进 | `opportunity:update`，记录作者 |

### 2.3 服务目录与报价（M1）

| Method | Path | 用途 | P / 备注 |
|---|---|---|---|
| GET | `/service-products` | 服务目录 | `product:read` |
| POST | `/service-products` | 新建服务 | `product:manage` |
| PATCH | `/service-products/:id` | 修改目录价/状态 | `product:manage`，历史报价不联动 |
| GET | `/opportunities/:id/quotes` | 商机报价列表 | `quote:read` |
| POST | `/opportunities/:id/quotes` | 创建报价单 | `quote:create` |
| GET | `/quotes/:id` | 报价详情与版本摘要 | `quote:read` |
| POST | `/quotes/:id/versions` | 产生新报价版本草稿 | `quote:create` |
| GET | `/quotes/:id/versions/:versionNo` | 不可变版本详情 | `quote:read` |
| POST | `/quotes/:id/versions/:versionNo/submit` | 提交报价 | `quote:submit` |
| POST | `/quotes/:id/versions/:versionNo/record-acceptance` | 记录客户接受报价依据 | `quote:record_acceptance`，当前客户范围，审计、依据 |

### 2.4 订单、审批及变更（M1/M3）

| Method | Path | 里程碑 | 用途 | 权限 |
|---|---|---|---|---|
| GET | `/orders` | M1 | 订单列表 | `order:read` + 数据范围 |
| POST | `/orders` | M1 | 根据已接受报价版本创建草稿 | `order:create` |
| GET | `/orders/:id` | M1 | 详情含当前版本、状态摘要 | `order:read` |
| PATCH | `/orders/:id` | M1 | 仅编辑草稿允许字段 | `order:update` |
| POST | `/orders/:id/submit` | M1 | 提交订单审批，冻结审批快照 | `order:submit` |
| POST | `/orders/:id/withdraw` | M1 | 撤回尚未表决的申请 | `order:withdraw`，当前轮提交人 |
| POST | `/orders/:id/approve` | M1 | 审批通过 | `order:approve` |
| POST | `/orders/:id/reject` | M1 | 审批拒绝，退回草稿 | `order:reject` |
| GET | `/orders/:id/approvals` | M1 | 审批历史 | `order:read` |
| POST | `/orders/:id/change-requests` | M3 | 提交订单金额/交付范围变更申请 | `order:request_change` |
| POST | `/orders/:id/change-requests/:requestId/approve` | M3 | 变更生效 | `order:approve_change` |
| POST | `/orders/:id/cancellation-requests` | M3 | 发起取消申请 | `order:request_cancel` |
| POST | `/orders/:id/cancellation-requests/:requestId/approve` | M3 | 批准普通取消 | `order:approve_cancel` |
| POST | `/orders/:id/termination-requests` | M3 | 发起终止申请 | `order:request_terminate` |
| POST | `/orders/:id/termination-requests/:requestId/approve` | M3 | 终止批准与结算记录生效 | `order:approve_terminate` |
| POST | `/orders/:id/complete` | M2 | 结项 | `order:complete` |

所有审批/取消/终止命令：需要同数据库事务内写入审批/业务状态/业务审计，并遵循 ADR-001 与 ADR-005；关键尝试按 ADR-003 预写。完整申请流程含拒绝、撤回、失效等命令在 M3 按 DC-006 细化；未有完整契约的动作不开放，不以通用 PATCH 替代。

### 2.5 交付与财务（M2/M3）

| Method | Path | 里程碑 | 用途 | 权限 |
|---|---|---|---|---|
| POST | `/orders/:id/assign-delivery-manager` | M2 | 启动前预分配或改派经理 | `delivery:assign`，业务负责人 ALL，版本校验、审计、幂等 |
| GET | `/orders/:id/delivery` | M2 | 查询交付项目 | `delivery:read` |
| POST | `/orders/:id/delivery/start` | M2 | 启动交付 | `delivery:start` + 首款或豁免 + 订单互斥 |
| GET | `/delivery-projects/:id/tasks` | M2 | 任务列表与有效交付范围 | `delivery:read` |
| POST | `/delivery-projects/:id/tasks` | M2 | 新建交付任务 | `delivery:task_manage` |
| PATCH | `/delivery-projects/:id/tasks/:taskId` | M2 | 更新任务进度 | `delivery:task_update` |
| POST | `/delivery-projects/:id/tasks/:taskId/accept` | M2 | 验收交付项 | `delivery:accept` |
| GET | `/orders/:id/payment-terms` | M2 | 付款计划 | `payment:read` |
| GET | `/orders/:id/payments` | M2 | 实收记录与冲正摘要 | `payment:read` |
| POST | `/orders/:id/payments` | M2 | 登记待确认收款 | `payment:record` |
| POST | `/payments/:id/confirm` | M2 | 财务确认收款 | `payment:confirm` + 职责分离 |
| POST | `/payments/:id/reverse` | M2 | 冲正已确认收款 | `payment:reverse` + 复核 |
| GET | `/orders/:id/refunds` | M3 | 查询退款义务及进度 | `refund:read` |
| POST | `/orders/:id/refunds` | M3 | 创建退款申请 | `refund:create` |
| POST | `/refunds/:id/approve` | M3 | 退款审批（非实际付款） | `refund:approve` |
| POST | `/refunds/:id/record-settlement` | M3 | 记录外部银行退款事实 | `refund:settle` |
| GET | `/audit-logs` | M0+ | 受限业务审计检索 | `audit:read`，严格字段过滤 |

## 3. 关键命令契约（核心）

### 3.1 通用命令要求

- 下列命令均禁止直接由客户端设置最终 `status`，通过身份、授权及前置条件计算状态结果。
- `expectedVersion` 为非负或正整数（以实体版本初始 1 为准），由先前 GET 返回；不同模块可对审批快照或交付范围增加 `scopeVersion`。
- 所有强副作用命令须验证 `Idempotency-Key`，遵循 ADR-005：scope=user:不可变用户ID，操作和目标仅进入指纹；同主体同键跨操作/目标/参数冲突返回 409；并发同键不会二次执行。
- 多实体状态写入、幂等结果及成功审计置于**同一 MySQL 事务**；不存在银行/OSS 的外部 I/O 与该事务原子提交的假设。
- 关键命令按 ADR-003 在事务前独立预写 command_attempts；预写失败返回 503 AUDIT_UNAVAILABLE 且不执行业务。成功审计/尝试成功/幂等结果同业务提交，确定回滚后独立记录 FAILED；记录写入失败返回 503 并保留待核对线索。提交未知返回 503 IDEMPOTENCY_RESULT_UNKNOWN，STARTED/UNKNOWN 不伪装为驳回。普通未授权/校验错误仅尽力而为运行日志。
- 错误应可按 `requestId` 关联；为防止信息泄露，受限资源的 actual status/版本不可随意展示给未授权者。

### 3.1.1 幂等公开契约（DC-008）

2026-10-30 实现注记：可复用幂等 Service、指纹 v1、事务结果及尝试审计已实现；接入要求、恢复探测、留存和验证边界见 [幂等基础组件](idempotency.md)。本次不新增或开放下面的业务命令端点。

- Key 为规范化小写 UUID。同一用户跨会话/操作唯一，不同用户独立。指纹 v1 包含 API 主版本、稳定 operationId、路径目标及规范化 DTO（含 expectedVersion）；规范化规则见 ADR-005。
- 当前认证/动作/对象范围检查后才允许回放，回放不受旧 expectedVersion 或已结束状态阻断。并发等待最多 2 秒，仍进行返回 409 IDEMPOTENCY_IN_PROGRESS、Retry-After: 1。
- V1 不缓存失败；技术失败与确定业务拒绝均回滚 Key。COMMIT 未知用原 Key 查询，不能确认时返回 503；客户端不得换 Key 自动执行。
- 从成功提交起至少保留 7 天；过期但尚未清理可继续重放，清理后可能作为新请求，不保证返回“Key 已过期”。客户端不得复用 Key，超窗口未知结果先查询/人工核对。资金唯一规则独立于这个窗口，仍由 DC-003 补齐。
- 仅存 ID/状态/版本/金额摘要等最小结果，响应快照上限 64 KiB，超限提交前拒绝并回滚；无 Token、银行凭证和敏感个人全文。

### 3.2 订单草稿创建

`POST /api/v1/orders` （M1，`order:create`）

Headers: `Idempotency-Key: <UUID>`
```json
{ "acceptedQuoteVersionId": "3001", "customerTermsAcceptanceRef": "evidence-2026-001" }
```

输出 `201`：`data = { id, orderNo, status:"DRAFT", version:1, totalAmount:"35000.00", currency:"CNY" }`。

前置：报价版本已确认接受、客户与商机范围合法；同一报价不可被重复意外创建相同业务订单（是否允许一报价多订单仍为业务待定，V1 默认单张有效订单并对引用建立业务唯一性约束）。事务：订单主表、明细价格快照、报价来源关联、幂等结果、审计。历史报价版本不可变。

### 3.3 提交审批

`POST /api/v1/orders/:id/submit` （M1，`order:submit`）

```json
{ "expectedVersion": 1, "remark": "合同已核对" }
```

Header: `Idempotency-Key` 必填。成功 `200` 返回订单 `status:PENDING`、新 `version`、`approvalRoundId`、`snapshotVersion`。前置：DRAFT、明细和付款条款完整、客户正式交易条款接受证据有效。事务冻结**审批快照**与审批轮次，更新订单状态并记审计。

### 3.4 审批通过 / 拒绝

`POST /api/v1/orders/:id/approve` 或 `/reject`（M1）

```json
{ "approvalRoundId": "8001", "expectedVersion": 2, "decisionReason": "条款有效" }
```

拒绝时 `decisionReason` 必填。前置：`PENDING`、审批轮次与快照匹配、审批人拥有对象范围权限且非申请人；已审阅快照内容未被替换。事务：订单状态（通过→CONFIRMED，拒绝→DRAFT）、审批决定、版本递增、业务审计与幂等结果；只有一个决定可生效。重复相同 Key 重放首次结果；不同 Key 针对已结束轮次返回 409。

### 3.5 交付启动（跨模块协调）

启动前预分配：`POST /api/v1/orders/:id/assign-delivery-manager`，请求 `{expectedVersion, deliveryManagerId}`、Idempotency-Key 必填；仅具 delivery:assign 的业务负责人 ALL 可执行，目标须为有效且具 delivery:start 能力的交付经理。锁订单重验 CONFIRMED、从未启动，写 orders.delivery_manager_id 并递增 version、审计及幂等结果，成功 200 返回新版本。改派亦限启动前；启动后的项目人员变更契约留待 DC-004。该动作不启动交付，不授予销售数据或财务权限。

`POST /api/v1/orders/:id/delivery/start`（M2，`delivery:start`）

```json
{ "expectedVersion": 3, "deliveryManagerId": "101", "paymentWaiverApprovalId": null }
```

前置：订单 CONFIRMED、交付从未启动、首款确认金额达到合同条款要求或豁免生效、无有效待处理取消申请。**锁定 orders 行作为共享锚点**，在同一事务内读取并验证这些事实、创建/更新交付项目、写审计与幂等结果。订单仍保持 CONFIRMED；交付进入 IN_PROGRESS。取消审批流程须使用相同锚点与锁定顺序。

调用者必须是预分配经理；body.deliveryManagerId 必须等于 orders.delivery_manager_id，不允许通过启动命令自我分配。豁免批准记录未按 DC-002 明确并可验证前，豁免分支不开放。

### 3.6 普通取消批准（尚未启动）

`POST /api/v1/orders/:id/cancellation-requests/:requestId/approve`（M3，`order:approve_cancel`）

```json
{ "expectedVersion": 4, "decisionReason": "客户正式撤单，财务方案已核对" }
```

前置：CONFIRMED、交付**从未**启动、申请有效且审批前置已完成、已收款处理方案已确认；在订单锚点事务内重查交付启动事实、待处理申请、审批权限。成功订单→CANCELLED，退款执行仍作为独立财务流程；不可因银行未退款而伪造“已退款”。并发中发现交付已启动时，返回 `409 DELIVERY_ALREADY_STARTED`，保留原申请并通过独立处理标记失效/重评；不得伪造为审批人主动驳回。

### 3.7 交付结项

`POST /api/v1/orders/:id/complete`（M2，`order:complete`）

```json
{ "expectedVersion": 5, "scopeVersion": 2, "acceptanceRef": "acceptance-01" }
```

前置：订单 CONFIRMED、完整当前**生效**交付范围中的必需项目均有有效验收凭据、无阻断申请、授权交付结项人；无需尾款全部到账。结项和交付范围生效共用订单锚点事务及锁定顺序，在事务内重验 `scopeVersion` 和验收集合；成功→COMPLETED。对已完成订单新增交付要求不得直接回退状态。

### 3.8 收款登记、确认、冲正

**登记** `POST /api/v1/orders/:id/payments`（M2）
```json
{ "amount": "14000.00", "currency": "CNY", "receivedAt": "2026-10-29T06:10:00.000Z", "externalReference": "BANK-REF-XXXX", "remark": "首付款" }
```
成功 `201` 返回 `payment.status:RECORDED`，并非已确认到账。敏感银行流水号日志脱敏；外部参考号唯一性规则待财务确认。

**确认** `POST /api/v1/payments/:id/confirm`（M2）
```json
{ "expectedVersion": 1, "verifiedReference": "BANK-REF-XXXX" }
```
前置：财务授权、登记未确认、核对凭证符合、职责分离。事务提交确认状态、余额汇总策略（以权威支付明细为基础）、审计、幂等结果；金额不可静默覆盖。

**冲正** `POST /api/v1/payments/:id/reverse`（M2）
```json
{ "expectedVersion": 2, "reason": "录入金额错误", "approvalReference": "FIN-REVIEW-001" }
```
前置：已确认且尚未有效冲正、复核授权。事务创建冲正事实并确保同一笔收款不会被两次冲正；原始记录不物理删除。银行真实退款须走独立 Refund 流程。错误码 `PAYMENT_ALREADY_REVERSED`、`VERSION_CONFLICT`。

### 3.9 订单变更批准 / 终止批准

**变更批准** `POST /api/v1/orders/:id/change-requests/:requestId/approve`（M3）：传 `{expectedVersion, expectedScopeVersion, decisionReason}`。前置：客户已接受、审批权限有效、无冲突申请、变更后金额/收款计划合法。在订单锚点事务内更新有效合同快照、未结清付款计划、交付范围版本及审计；确认收款事实不可覆盖。阻断已完成订单的直接变更。

**终止批准** `POST /api/v1/orders/:id/termination-requests/:requestId/approve`（M3）：传 `{expectedVersion, settlementPlanId, decisionReason}`。前置：交付曾启动、交付工作量结算、财务复核和业务负责人批准；事务更新订单 TERMINATED、终止结算及审计。外部退款另行执行，不宣称随订单事务原子完成。

## 4. 数据范围与字段保护

所有受保护接口的权限码、默认角色、固定 scope 及职责分离以 permission-matrix.md §4/§8 为授权总表；本清单不得另创“授权员工”隐式放行。销售子资源按当前客户继承；商机 owner/createdBy 不独立授权。销售、交付、财务返回不同字段白名单；order:read 不包含完整银行凭证及财务流水。

通用 PATCH 不接收 ownerId、customerId、opportunityId、协作集合等归属字段；仅允许受控创建时指定合法父对象，修改走专用交接/分配契约。嵌套 ID 和请求体关联 ID 校验完整父子归属，不匹配 404。多角色动作/scope 成对求值，不能拼接权限。授权写入和业务写按 permission-matrix.md §4.2 共同锁顺序执行。

角色配置的 scopeCode 仅可使用固定映射；业务角色修改及授予另需 role:grant_business，禁止影响本人有效业务授权，受保护 business_owner 模板不可编辑，禁止撤销最后负责人。用户身份/部门修改也受同一保护；停用采用 credential_version 及会话撤销，每请求查权威库，V1 不缓存授权。

- 销售读取客户、商机、报价及订单仅限本人负责/协作或获授权团队范围；数据归属变化要影响后续查询，不只校验创建人。
- 交付仅可读取被分配项目以及完成任务所需最少客户信息；财务可读取账务必需订单，不默认访问全部销售跟进内容。
- 系统管理员默认不拥有财务确认/退款审批权限；高风险操作执行职责分离。
- 导出、统计、详情、列表、操作命令必须复用一致的授权策略，防止“列表安全但详情可越权”。
- 不允许前端提交 `status`、`version` 新值、`approvedBy`、`createdAt`、`paidAmount` 等服务器派生/受控字段。

## 5. OpenAPI 文档与实现验收要求

- 各 Controller 使用 NestJS Swagger 装饰器描述 `tags`, `summary`, `operationId`, 认证、安全方案、路径参数、请求 DTO、2xx/4xx/5xx 响应与示例。
- 一操作一稳定 `operationId`（例 `OrdersController_approve` 或 `approveOrder`），不重复；全局错误 schema 复用。
- 应导出可机器验证的 `openapi.json` 并纳入 CI 检查（M0 初始化时补齐脚本）；文档变更与 DTO/自动化测试同步提交。
- 合约测试：DTO 拒绝未知字段、400/401/403/404/409/422、对象级授权、边界金额字符串、BigInt 字符串序列化、分页与稳定排序。
- 关键业务集成测试使用**真实 MySQL**：并发审批仅一次成功、同 Key 重试不重复执行、取消 vs 交付启动互斥、结项 vs 新交付范围互斥、收款确认/冲正不重复入账。
- 加测：客户移交/角色撤销后的查询与幂等重放、嵌套 ID 错配、字段投影、管理员自授/角色模板提权、多角色 scope 串用、预分配与启动者匹配；关键尝试预写失败/回滚后崩溃/提交未知按 ADR-003/005 恢复。
- 里程碑门禁：M1 公共订单事务入口；M2 提前迁移阻断申请最小表并真实查询，未启用申请 API 不等于可硬编码无阻断；M3 申请创建/撤回/拒绝/失效与生效均接入相同入口，发布前重跑 M1/M2 权限、幂等及跨模块并发测试。详见 data-model.md §8.1。
- `GET /health` 是 Liveness；数据库等依赖的 Readiness 建议另增 `/ready`（由部署访问策略限制），避免公开内部服务细节。

## 6. 暂定项与后续变更清单

1. 角色权限字典/固定范围已按 DC-001 补齐，M0 seed 与 permission-matrix.md §8 同步实现并验证；未来新增端点无明确映射则默认拒绝。
2. 报价接受证据的存储格式、附件引用、有效期、是否允许一报价生成多订单。
3. 财务参考流水唯一策略、支付确认职责分离、退款审批层级、真实银行退款对账流程。
4. 取消申请/终止申请/变更申请的完整驳回、撤回、失效 API 及状态机；M3 细化。
5. DC-007 仍待办：M1 补批量客户/商机交接，M2 补基础报表；均属 V1，不因本契约缺失降为 V1.1。导出/更多统计为 V1.1；批量权限变更未承诺为 V1 必需，另行评审。
6. 幂等作用域、7 天窗口、处理中和失败语义已由 ADR-005 确定，按 §3.1.1 验证，不再作为未决项。
7. 使用 `expectedVersion` 的失败冲突码、客户端重试 UX、外部响应缓存的敏感字段保留策略须实现验证。
8. 目录结构/API 路由与现有 Starter `health` 是否一致，应由实际启动和 OpenAPI 生成测试核实。

## 7. 关联 ADR 与迁移规则

- [ADR-001](adr/0001-order-concurrency-anchor.md)：订单行协调，跨模块事务和重检。
- [ADR-005](adr/0005-idempotency-scope-clarification.md)：当前幂等唯一性、请求指纹、失败/过期及原子提交；[ADR-002](adr/0002-idempotency-persistence.md) 仅保留历史。
- [ADR-003](adr/0003-audit-and-operational-logs.md)：业务成功审计与运行日志分离。
- [ADR-004](adr/0004-prisma-migration-strategy.md)：Schema 演进、Migration SQL 审核及兼容部署。

> 交付标准：此文档是 **契约设计草案**，实际开发时应由 DTO + Swagger 生成 OpenAPI 规格，并对照此文档维护契约测试。不得将规划接口标称为当前已经可调用。

## 8. 本轮修订与待办

DC-001/008/009/011/012 已完成文档修订，尚待真实实现验收。其余 DC-002～007（不含本轮项）、DC-010 的阶段、依赖与门禁以 requirements.md §13 为准，变更明细见 [design-review-changelog.md](design-review-changelog.md)。本次未补完整豁免、财务、验收、报价或 M3 工作流契约。

## 9. M1 准备补充（2026-10-30）

本节是原接口清单的技术细化；D-06/D-08 已于 2026-10-30 获业务负责人批准并在 §10 闭合，D-01～05/07 仍未决，不自动关闭 DC-005/010。本轮仅文档，下面均不是已开放路由。任务和数据映射见 [M1 实施计划](plans/m1-implementation-plan.md)。不改变 Accepted ADR，不新增通用工作流、证据服务或财务执行模块。

### 9.1 报价内容入口（DC-010）

| 路由 | 请求/结果与边界 |
| --- | --- |
| POST `/opportunities/:id/quotes` | 请求只含已定义的报价容器字段（候选 title）；父商机从路径解析；201 摘要 `{id,quoteNo,version}`。不悄悄产生空的已提交版本 |
| POST `/quotes/:id/versions` | 完整版本请求候选 `{currency,validUntil,items:[{productId?,description,quantity,unitPrice}]}`；客户端不得写 versionNo、总金额、行金额、contentHash、acceptedAt/status。规范化和 Decimal 计算依 D-01；201 摘要 `{id,versionNo,status,version,totalAmount,currency}` |
| GET `/quotes/:id/versions/:versionNo` | 返回该版本内容及提交/接受摘要；先完整校验版本→报价→商机→客户关系与 quote:read，不能只验证 versionNo 存在 |
| POST `.../submit` | `{expectedVersion}`；DRAFT 才能首次提交；锁 quote/版本后计算并冻结 contentHash、记录提交人/UTC 时间；200 摘要 `{id,versionNo,status,version,contentHash}` |
| POST `.../record-acceptance` | 候选 `{expectedVersion,acceptedContentHash,acceptanceRef}`；操作者和记录时间由服务端写入。acceptanceRef 的形式、校验及实际接受时刻是否需另行录入由 D-02 确定。200 摘要 `{id,versionNo,status,version}` |

`versionNo` 是报价内正整数版本序号，`version` 是该实体的乐观锁计数，二者不能混用。创建版本时完整提供内容，不增加未定义的草稿编辑接口；提交后内容不可变，接受只追加状态/证据元数据，不改变明细/hash；修改报价必须新建版本。具体有效期、接受状态转换及新版本对旧接受的影响由 D-02 决定，不能以“内部点击接受”冒充客户真实接受。

上述 POST 统一要求 Idempotency-Key，首次执行有成功审计，重放重新检查当前 quote 动作与客户范围。所有创建结果只返回标量摘要，完整明细另用 GET；这与现有幂等组件兼容。新建实体审计与稳定请求目标之间的适配缺口需先按计划 T03 补齐，不能每次请求随机生成 fingerprint 目标，也不能给真实业务审计写假 ID。

### 9.2 订单草稿内容、条款和快照（DC-005）

§3.2 示例仅展示了最小来源，不能解释为付款条款已从报价自动获得。准备阶段确定的边界是：**付款条款在订单草稿显式录入/替换，submit 前必须完整且有对应正式条款接受依据**；默认首付比例、到期基准、金额公式和证据有效性仍由 D-01/02/03 决定。

| 路由 | 技术契约 |
| --- | --- |
| POST `/orders` | 来源 acceptedQuoteVersionId 必填且只由受权范围内完整来源链解析 customer/opportunity；customerTermsAcceptanceRef 沿用原字段。候选新增 paymentTerms 数组，首次可留待草稿 PATCH 补齐，绝不能因此跳过 submit 校验。是否强制创建即完整由 D-03 确定；复制来源报价明细/币种/金额快照，201 摘要沿用 §3.2 |
| PATCH `/orders/:id` | `{expectedVersion,...已批准的草稿字段}`；条款数组如传入则整体替换且非 null，和订单版本递增同事务。不得修改客户/商机/报价来源、状态、服务器金额/版本。允许编辑的合同字段及是否允许草稿明细偏离报价由 D-04 决定，在此之前不开放明细编辑 |
| POST `/orders/:id/submit` | 沿用 expectedVersion/remark；验证 DRAFT、来源/明细/金额/付款计划完整、正式条款接受依据匹配当前内容。在订单锚点事务写 round、完整 snapshot、hash、PENDING、新 version；不只保存哈希，不写支付事实 |
| POST `/orders/:id/approve`、`/reject` | 沿用 approvalRoundId/expectedVersion/decisionReason；必须检查 round 属于该订单、仍待决、快照与提交版本一致、审批权限/门槛明确、非当前 round 的提交人。审批门槛未确定时不开放 approve，不按“经理”角色名称默认放行 |
| POST `/orders/:id/withdraw` | `{approvalRoundId,expectedVersion,reason?}`；当前轮提交人且仍具动作与对象范围，PENDING 且未形成决定；200 `{id,status:"DRAFT",version,approvalRoundId}`。结束本轮为撤回，不创建 REJECT 决定；与 approve/reject 争同一 orders 行锁 |
| GET `/orders/:id/approvals` | order:read 和当前客户销售范围；分页返回历史轮次及明确的结束原因，提供可恢复的 snapshot 白名单。快照可置于每轮项内，不通过幂等结果回放全文；其体积/分页须在 DTO 任务中给出明确上限 |

审批快照包含 snapshotSchemaVersion、snapshotVersion（本订单 roundNo）、orderVersion、来源报价版本/哈希、合同明细/金额/币种、付款条款、正式条款接受引用与绑定内容。还需 frozenBy/frozenAt；它们不参与报价 contentHash。合同快照哈希使用固定字段顺序、Decimal/ID/UTC 字符串，保存规范化后的 JSON 及哈希，两者可独立复算。其内容限额须在 T00/T13 评审，不能复用 64 KiB 幂等上限当作合同容量结论。

订单所有写入口（包括 PATCH）复用共享事务与授权锁协议；POST/草稿 PATCH 使用幂等标量结果。状态检查在首次执行业务阶段，重放只重新检查当前身份/动作/范围；不能用旧 expectedVersion 拒绝成功重放。提交、审批、拒绝、撤回各自产生对应成功审计，不因回滚生成“审批驳回”。

### 9.3 M1 的其他契约补齐任务

- 客户列表的信用代码精确查询和“缺信用代码”的疑似重复提示必须在当前可见范围内执行；名称不唯一。D-06 已批准，归一化、匹配、字段和人工核实按 §10；无模糊匹配引擎或隐藏记录详情。
- `POST /customers/:id/assign` 请求候选 `{expectedVersion,ownerId,collaboratorIds}`，完整替换/缺失语义、目标有效销售能力校验及批量交接在 T09 定案；不以 PATCH ownerId 绕过。批量客户/商机交接仍为 M1 必做（BR-010/DC-007），路由/原子性/部分失败规则由 D-07 确认，不新增未经评审的批处理表。
- D-08 已批准，商机字段/阶段、终结不重开、主联系人、跟进与筛选白名单按 §10；WON 不等于 CONFIRMED 订单。follow-ups 必须属于商机，作者由服务端设置。
- customer:create、customer:update、opportunity:create/update、product:manage、quote 和 order 写操作的 DTO 任务应逐个补齐长度、数组上限、缺失/null、字段白名单、2xx/400/401/403/404/409/422/503，随后才逐个注册 Controller；本节没有授权一次性生成全部路由。
- 金额/数量格式错误用 400 VALIDATION_FAILED；业务金额/条款条件不满足先采用 409 BUSINESS_RULE_VIOLATION，版本/状态冲突用现有码。不能把 PAYMENT_AMOUNT_INVALID 借作所有报价错误；如需新细分码，先同步契约、共享传输类型及错误白名单，不在本次写代码。

### 9.4 必须保留的业务决定与关闭条件

下表保留决策台账；D-06/D-08 已批准并设计闭合，其余选项仍未决定，不存在预选业务答案。未决路径不开通，不用管理员或固定 true 绕过。

| ID | 待明确事项 | 影响/关闭证据 |
| --- | --- | --- |
| D-01 | 数量是否允许小数及精度；单价/行额/总额舍入；税费/折扣、零/负数边界及溢出 | DC-010/005；批准的金额例表和边界期望后才能固定列精度/计算及 DTO |
| D-02 | 报价有效期及边界时刻；接受证据类型/归属/核验；新版本与旧接受关系；已接受后过期是否允许下单；报价接受和正式条款接受的区别 | DC-010/005；完整状态转换表、时间/证据用例；非空 ref 不算核验 |
| D-03 | 合同付款条款字段与来源；绝对到期日或里程碑；首付识别/金额；计划合计与合同金额关系；条款接受绑定和变更后重新接受 | DC-005；订单 create/PATCH/submit 的完整 JSON、无效用例、PaymentTerm 字段确认 |
| D-04 | 一报价版本单订单/单有效订单/多订单；终态后能否重建；草稿可改哪些合同明细 | DC-010/005；唯一性语义及 SQL 约束方案，不把假设直接迁移 |
| D-05 | 单级审批假设、审批金额门槛、授权的表达及快照有效/过期条件 | DC-005；可执行授权/职责分离矩阵和 approve/reject/withdraw 竞争预期 |
| D-06 | 已批准：代码归一化、全库唯一、可见精确提示、人工核实及最小占用信号取舍 | 设计闭合；§10、requirements §14、批准记录及审查记录；实现测试未验收 |
| D-07 | 批量交接选中/全部范围、商机责任人变化、旧协作者保留、原子或逐项失败、目标有效销售资格 | BR-001/010、DC-007；请求/响应、版本冲突与跨团队用例；不得降为 V1.1 |
| D-08 | 已批准：CRM 最小字段/状态、主联系人、商机终结不重开、跟进仅追加 | 设计闭合；§10、模型 §12、requirements §14；金额仍留 D-01，交接仍留 D-07 |

技术字段默认长度、分页上限、规范化格式及资源限制可由开发按现有规范落实并记录；凡影响上述业务含义，必须有明确决定。DC-005/010 只有相应决定、API/模型同步和验收样例齐备后才可标“设计关闭”，实现关闭还需真实 MySQL/HTTP 测试，不能仅由本次文档补充宣告。

## 10. D-06 / D-08 已批准 CRM 接口契约（待实现）

2026-10-30 业务负责人批准；业务定义、精确字段规则及验收见 [requirements §14](requirements.md)，存储见 [data-model §12](data-model.md)，范围见 [permission-matrix §10](permission-matrix.md)。本节细化 §2.2 的路由，不代表运行时 OpenAPI 已开放。D-01～05/07 未闭合。

### 10.1 DTO、枚举与默认

字符串长度为 Unicode 码点；短文本 NFKC/去首尾空白，客户名另合并内部空白；content/description/reason 只统一换行、去首尾空白，不重写正文。纯文本拒绝 NUL/非法控制字符，允许正文换行/制表符。所有写 DTO 拒绝未知字段与隐式类型转换；POST 可选字段缺失采用下表默认，PATCH 缺失不改、null 只清可空字段，非空文本不能用空串代替。派生值、actor、createdAt/updatedAt/version、ownerId/status/stage 不接受客户端普通写入。

| DTO / 路由（省略 /api/v1） | 请求字段、默认及约束 | 成功响应 data / 状态 |
| --- | --- | --- |
| POST /customers | name 必填 1～200；creditCode? 默认 null；description? 默认 null、最多 2000；只创建客户 | 201 {id,status,version}；status=ACTIVE、owner=actor |
| PATCH /customers/:id | expectedVersion 必填正整数；可选 name/creditCode/description；代码非空不可清空 | 200 {id,status,version} |
| POST /customers/duplicate-check | name 必填；creditCode?/phone?/email? 默认 null；excludeCustomerId? 仅可读客户 ID | 200 {candidates,hasMore}，no-store；只读，不需要幂等 Key，不持久化输入 |
| POST /customers/:id/archive、/restore | expectedVersion，reason 必填 1～500 | 200 {id,status,version}；ACTIVE→ARCHIVED / ARCHIVED→ACTIVE |
| POST /customers/:id/contacts | name 必填 1～100；title?≤100、phone?≤40、email?≤254 默认 null；isPrimary? 默认 false | 201 {id,version}；status=ACTIVE |
| PATCH /customers/:id/contacts/:contactId | expectedVersion；可选 name/title/phone/email/isPrimary，规则同创建 | 200 {id,version} |
| POST /customers/:id/contacts/:contactId/deactivate | expectedVersion，reason 必填 1～500 | 200 {id,status,version}；ACTIVE→INACTIVE，清主标记 |
| POST /opportunities | customerId 必填 ID 字符串；title 必填 1～200；description?≤2000 默认 null | 201 {id,stage,version}；NEW、owner=actor |
| PATCH /opportunities/:id | expectedVersion；可选 title/description，仅进行中 | 200 {id,stage,version} |
| POST /opportunities/:id/change-stage | expectedVersion；stage 必填 NEW/QUALIFIED/NEGOTIATING；reason 必填 1～500 | 200 {id,stage,version}；可前进/回退，不可同阶段新命令 |
| POST /opportunities/:id/close-won、/close-lost | expectedVersion；reason 必填 1～500 | 200 {id,stage,version}；写 closedAt/closeReason，不触发订单操作 |
| POST /opportunities/:id/follow-ups | content 必填 1～4000；nextFollowUpAt? 默认 null；correctionOfId? 默认 null、同商机已有跟进 | 201 {id}；author/createdAt 由服务端写，不改变商机 version |

以上实体写入（包括 PATCH）均复用幂等命令和安全标量结果；查重 POST 为只读例外。更新使用被操作实体 expectedVersion；跟进追加不接收 expectedVersion。ID 为规范无符号 BigInt 十进制字符串，不转 Number。expectedAmount 暂不出现在 DTO，待 D-01 后再开放，不填 0。联系人路径决定 customerId，跟进路径决定 opportunityId，不接收可伪造父 ID。

枚举：CustomerStatus=ACTIVE/ARCHIVED；ContactStatus=ACTIVE/INACTIVE；OpportunityStage=NEW/QUALIFIED/NEGOTIATING/WON/LOST；DuplicateMatchReason=CREDIT_CODE/NAME/PHONE/EMAIL。不新增角色名授权旁路或订单状态码。

### 10.2 归一化、查重和状态校验

- creditCode 原输入≤64 码点，NFKC→去首尾 Unicode 空白→ASCII 大写，结果严格 18 位 [0-9A-Z]。空串、内部空白/标点非法；不计算校验位、不验真；null/缺失允许，非空已有代码不得清空。归一化先于 v1 请求指纹。全库 UNIQUE（含归档）是最终并发保障。
- phone NFKC/trim，显示只接受数字/+/-/空格/括号，+ 只在首位；派生键为可选 + 加 3～20 位数字，不改国家区号。email 为 trim 后 ASCII 常规邮箱≤254，派生键小写，不删 +tag/点；name 派生 normalizedName 对 ASCII 大写。数据库匹配沿用 utf8mb4_0900_ai_ci。客户端不得写派生键。
- 查重有代码时仅当前可见代码相等；无代码时规范化完整名称或有效联系人 phone/email 相等作 OR 提示，不模糊匹配，不阻止无代码重复创建。按客户去重，最多 5 个、id 升序，hasMore 仅在可见候选内计算；不返回全库 exists/total、联系人正文、owner 或团队。查重不是创建必经步骤，不锁定身份或预留代码。
- 联系人必须 phone/email 至少一项；每客户最多 100 个有效联系人；零或一个有效主联系人，指定新主自动清旧主且双方 version 提升；并发按客户锁串行，后提交者成为主。停用清主、不自动补选；INACTIVE 不编辑/恢复/删除。
- 归档只允许无进行中商机，客户锁串行化与商机创建/阶段变更。归档后客户资料、联系人、商机创建与跟进追加禁写，先 restore；历史可读，不释放代码，不自动废止已有报价/订单；受控交接留 T09。
- 进行中阶段可有理由前进或回退；WON 只从 QUALIFIED/NEGOTIATING 进入，需父客户 ACTIVE、至少一个有效联系人及 reason。LOST 可从任一进行中阶段进入且 reason 必填。两终态不重开、不普通编辑；owner 受控交接留 D-07。WON 是销售人工判断，不等于已接受报价、订单确认、到账或交付许可。LOST 不作新报价/新订单来源，但不取消既有订单/历史报价；T11/T14 接入时落实此边界。
- nextFollowUpAt 必须 RFC3339 UTC Z、毫秒精度；格式合法但首次执行时非未来为 409。终态允许追加说明/更正但计划必须 null；ARCHIVED 不允许追加。correctionOfId 只指同商机已有记录，原文保留；无 PATCH/DELETE，更正不作废旧记录，也无提醒任务。与终结竞争在客户→商机锁下重验；成功重放不因旧状态/时间已过而拒绝。

### 10.3 读取投影、响应与异常示例

GET /customers 及详情只输出当前范围内客户业务字段（id/name/creditCode/ownerId/status/description/version/createdAt/updatedAt/createdBy）；normalizedName 不输出。联系人列表返回 id/customerId/name/title/phone/email/status/isPrimary/version/createdAt/updatedAt/createdBy，不返回派生匹配键；正文仅限有客户读取权限的 GET。商机列表/详情返回 id/customerId/ownerId/title/description/stage/closedAt/closeReason/version/createdAt/updatedAt/createdBy；不返回未开放 expectedAmount。跟进列表返回 id/opportunityId/authorId/content/nextFollowUpAt/correctionOfId/createdAt。字段仍须通过固定 scope 和白名单，不扩财务/交付投影。

各列表 page=1/pageSize=20，pageSize 1～100，createdAt DESC,id DESC；客户筛选限 status/ownerId/creditCode 精确查询，商机筛选限 customerId/stage/ownerId，联系人筛选限路径 customerId/status，跟进限路径 opportunityId；不存在的筛选参数拒绝。where、total 同授权快照，客户或 owner 筛选不扩大范围。

创建客户示例（仅演示格式，不宣称真实企业身份）：

```json
{"name":"示例服务企业","creditCode":null,"description":null}
```

201：

```json
{"data":{"id":"10001","status":"ACTIVE","version":1},"requestId":"00000000-0000-4000-8000-000000000001"}
```

查重 200（只有不可见匹配时与完全无匹配相同）：

```json
{"data":{"candidates":[],"hasMore":false},"requestId":"00000000-0000-4000-8000-000000000002"}
```

可见候选 200：

```json
{"data":{"candidates":[{"id":"10001","name":"示例服务企业","status":"ACTIVE","matchReasons":["NAME","EMAIL"]}],"hasMore":false},"requestId":"00000000-0000-4000-8000-000000000003"}
```

全库代码冲突一律 409，无 details 或输入代码回显，不区分可见性：

```json
{"code":"BUSINESS_RULE_VIOLATION","message":"该客户信息无法保存，请核对企业信用代码或联系有权负责人处理","requestId":"00000000-0000-4000-8000-000000000004"}
```

赢单请求/响应示例（仍需 Idempotency-Key）：

```json
{"expectedVersion":2,"reason":"客户已明确选择合作，后续另行完成报价及订单手续"}
```

```json
{"data":{"id":"20001","stage":"WON","version":3},"requestId":"00000000-0000-4000-8000-000000000005"}
```

错误沿用现有码：401 UNAUTHENTICATED；无动作 grant 403 PERMISSION_DENIED；不可见/不存在/父子或更正来源错配 404 RESOURCE_NOT_FOUND；字段/格式/枚举/null/长度错误 400 VALIDATION_FAILED；已授权目标版本冲突 409 VERSION_CONFLICT；归档禁写/终态改写/同阶段/缺赢单联系人/联系人上限/非法计划时间/代码冲突 409 BUSINESS_RULE_VIOLATION。幂等 409/503、审计 503 沿用 ADR-003/005，未注册跟进改删路由返回 404，不给作者/管理员后门。业务状态细节只在当前授权后返回。

全库唯一性仍有最小代码占用信号，该取舍已获业务批准；只保护详情，不能承诺完全隐藏存在性。查重 Cache-Control:no-store；输入和联系人正文不进技术日志、成功审计全文或幂等快照；内部员工授权及部署限流不因本接口取消。

### 10.4 验收追踪

D-06 归一化/多个 NULL/跨用户并发唯一/可见与不可见提示/同 Key 和失败回滚，及 CRM-01～18 的状态、主联系人、终结、追加更正、权限与迁移场景以 requirements §14.3 为正式期望，原批准记录 §2.7/§3.10 保留来源。T04/T05/T06/T07/T17 分阶段实施真实 MySQL/HTTP 验收；本次未新增 CRM 运行时 OpenAPI 路由或运行 CRM 测试；既有 OpenAPI 导出回归通过。
