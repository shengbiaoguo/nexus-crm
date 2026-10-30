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
| GET | `/customers` | 客户列表 | `customer:read` + SELF/COLLABORATOR/TEAM |
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
