# 幂等基础组件（2026-10-30）

后续前置补齐：增加 createsEntity/new-target 的真实成功审计目标适配，以及独立的有界尝试核对 CLI，见 [M1 前置基础能力](m1-foundations.md)。下文“本次未实现”的描述保留首次组件交付边界；后台调度尚未安装，未开放 M1 业务端点。

以 Accepted ADR-005 为当前契约，ADR-002 仅为历史；尝试与成功审计遵循 ADR-003，业务锁顺序遵循 ADR-001 和 permission-matrix.md §4.2。复用 idempotency_records、command_attempts、audit_logs 与共享 DatabaseModule，不改 schema、Migration、依赖版本或业务模块。不新增生产 HTTP 端点，不给登录/续期或只读接口自动缓存结果。

## 服务入口

2026-10-31 T03 工程审查及创建契约补强见 [T03 记录](t03-creation-review.md)。新建实体必须同时声明服务端 `createsEntity:true` 和 `entityId:'new'`；`new` 保留给此模式。entityType/operationId 及 targets（包含已有父 ID）稳定进入现有 v1 指纹，生成 ID 不进入请求指纹。客户端不能提交这些组件配置。

创建回调在同一 tx 中插入并返回 201、规范无符号 BIGINT 字符串 id，且 responseFields 必须保存 id；成功 AuditLog 记录该真实 ID，尝试仍保留 new 并通过 resultRef 关联。首次执行、普通重放、提交未知恢复和核对器消费 new 结果共用相同的 201/ID 校验。恢复看到原尝试已 SUCCEEDED 时仍验证创建结果；无法核实的已完成摘要返回 IDEMPOTENCY_RESULT_UNKNOWN，保留既有事实，不自动再创建。无需新增列或改变 v1 hash、旧非创建命令、锁/审计/保留协议。

业务模块导入应用中同一 DatabaseModule 注册对象对应的 IdempotencyModule，并注入 IdempotencyService。调用 `execute(command)` 时提供以下**服务端定义**：

| 字段                            | 责任                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| identity                        | AuthGuard 校验的 sub/sid/cv；用户 scope 仅从 identity.sub 生成                                                         |
| key                             | 原始 Idempotency-Key 头值，必须是单个 UUID，组件规范为小写                                                             |
| requestId                       | 本次服务端 request ID，不参与请求指纹                                                                                  |
| operationId                     | 稳定命令标识；不能由客户端自由选择                                                                                     |
| entityType / entityId / targets | 审计目标及完整、规范化的路径关联 ID，ID 保持字符串                                                                     |
| dto                             | 通过业务 DTO 校验后显式映射的纯 JSON；默认值已展开，金额为规范 Decimal 字符串、BigInt ID 为字符串、时间为 UTC 字符串   |
| responseFields                  | 服务端定义的结果摘要字段白名单；不能由客户端提交                                                                       |
| authorize(tx, phase)            | 当前动作及对象范围校验，拒绝抛 ApiException；必须同时覆盖首次执行和重放                                                |
| execute(tx, dto)                | 首次执行业务、状态/版本/职责分离重验；只使用传入 tx 与冻结的 DTO，返回 httpStatus、body 和可选审计 before/after 白名单 |

业务回调返回的 httpStatus 支持 200/201/204；204 的 body 必须为 null。其他成功响应 body 只保留白名单内的 JSON 标量字段，例如 id/status/version/amount；不支持嵌套业务全文、数组或凭据。未选字段丢弃，选中密码/Token/银行/联系方式等敏感字段则拒绝。UTF-8 JSON 超过 64 KiB 在提交前拒绝并回滚，不截断或返回未保存的完整结果。

返回 `IdempotencyResult`，由已有 ResponseInterceptor 设置首次状态码，将 body 放入标准 data/requestId 包裹。重放添加 `Idempotency-Replayed: true`，requestId 使用本次值；204 无响应体。组件不持久化 requestId 响应包裹、HTTP 头或原始敏感 DTO。

## 执行顺序与权限边界

1. 校验 Key/元数据，生成指纹和冻结的 DTO 副本。在 ReadCommitted 短事务检查账号 ACTIVE、cv、本人刷新会话有效，并调用 authorize 的 preflight 阶段。此阶段只检查当前动作/对象授权，不写业务，不作会阻断有效重放的旧版本/最终状态检查，不持有长时间锁。
2. 独立短事务写 STARTED 尝试；预写失败返回 503 AUDIT_UNAVAILABLE，不调用业务。会话级锁等待时间临时限制并恢复，不能通过跳过可靠尝试绕过审计故障。
3. 使用 AuditService.withTransaction，在 ReadCommitted 业务事务中争用 UNIQUE(scope,key)。PROCESSING 不独立提交。该平台 Key 资格位于业务锁层级之前，保证相同 Key 的等待不会先被业务行锁无限阻塞。
4. 取得 Key 后，将操作者（默认 SHARE）和 userLocks 中的全部相关用户按数值 ID 排序，分别用 FOR SHARE / FOR UPDATE 一次取得所需模式，再检查账号/会话并调用 authorize 的 transaction 阶段。调用者必须按角色→部门→客户→订单→子记录顺序锁定其余授权关系和业务对象，各层按 ID 排序，再作当前读取。组件不掌握尚未实现的业务对象，不能替代这些锁和对象范围检查。用户共享锁与停用/角色成员变更的排他锁互斥；会修改的用户必须预先声明 UPDATE，不能在角色锁之后临时升级或追加更小 ID 的用户。锁目标集合变化时应回滚重新确定，不能逆序追加。
5. 若已有相同指纹的 COMPLETED 行，重放首次状态与摘要；仅将本次尝试结束为 REPLAYED，不再次执行业务或写成功审计。不同指纹返回 409 IDEMPOTENCY_KEY_REUSED。不会根据旧 expectedVersion 或已完成状态拒绝有效重放。
6. 首次执行才调用业务回调；结果、业务写入、成功审计、尝试 SUCCEEDED 同事务提交。状态/版本和职责分离检查必须放在业务回调中，而不是 authorize 的重放检查中。成功审计 action 与 operationId 一致，使用同一 actor/target/requestId/attemptId。

授权回调必须由业务 Service 固定实现，不能接受客户端的 permission/scope/actorId；preflight 与 transaction 都要查权威库。该入口没有通用表达式规则或默认管理员放行，也不把 M0 读取用的 AuthorizationService.withRead 当作写入授权。

## 指纹 v1

userLocks 由服务端预先确定，最多 100 项；组件自动补入操作者、去重保留较强模式并按数值 ID 排序。它是锁协议配置，不接受客户端提交，也不参与业务请求指纹。

- scope 固定为 `user:<不可变用户ID>`，与会话、操作和目标无关；不同用户可独立复用相同 UUID。
- SHA-256 输入是规范 JSON：apiVersion=v1、稳定 operationId、entity 的 type/id、全部 targets、规范 DTO。对象键按 JS 字符串顺序排序，数组顺序保留，null 与缺失不同。拒绝 undefined、BigInt、Date、非有限/不安全整数、稀疏数组、访问器和非纯 JSON 对象。
- Key、requestId、Token 不进入指纹。expectedVersion 属于 DTO 语义，必须进入指纹。组件无法猜测各业务金额、时间和默认值语义，调用者负责规范化，不能把未经映射的 DTO 类实例直接传入。
- fingerprint_version=1 的黄金测试固定了序列化及哈希，后续升级不得破坏保留窗口内的旧比较。

## 等待、失败及未知提交

Key 插入使用临时 SESSION innodb_lock_wait_timeout=2；成功、唯一冲突和锁等待超时路径均恢复原值。超时由完整业务事务退出并回滚，返回 409 IDEMPOTENCY_IN_PROGRESS、Retry-After: 1，不使用 Promise.race 留下后台执行业务的 SQL。2 秒是 Key 的数据库锁等待上限，端到端还包含认证、审计、连接获取及网络耗时；预写故障仍按 ADR-003 返回 AUDIT_UNAVAILABLE。

MySQL 的锁等待超时默认只回滚当前语句，不能误认为整个事务已回滚，参考 [MySQL 8.4 错误处理](https://dev.mysql.com/doc/refman/8.4/en/innodb-error-handling.html)。组件不在捕获后继续提交业务，也不自动重试业务回调。

当业务回调已经进入或事务已准备提交却抛出异常时，组件按以下流程核对，而不把 Prisma/网络错误等同于回滚：

- 使用独立 PrismaClient/连接池，在新事务中争用原 scope/key；此客户端仅在恢复时创建，结束后释放，不影响正常共享池的生命周期。
- 找到已完成、同指纹结果：重新认证和授权后重放。原尝试已经 SUCCEEDED 时不覆盖；本次未结束的重试尝试置 REPLAYED。
- 可以重新插入同一唯一 Key 且原尝试未成功：原事务不再占有该 Key，在当前没有自动清理的条件下可确认未提交该结果。探测行在同一恢复事务中删除，并记录 FAILED；返回原业务拒绝或泛化 503，仍不自动重做业务。
- 无法获得明确结果：独立限时持久化 UNKNOWN，返回 503 IDEMPOTENCY_RESULT_UNKNOWN，客户端保留原 Key 核对；UNKNOWN 更新不能覆盖 SUCCEEDED/REPLAYED。UNKNOWN 写入也失败返回 503 AUDIT_UNAVAILABLE，并保留已有 STARTED 线索。
- 没有完成结果但存在相同 scope/key 的 UNKNOWN 或超过 5 分钟的 STARTED 时，新执行被阻断，不会因为结果已被清理而盲目重做。已存在的完成结果仍可在授权后返回。

本次没有连接代理断网或真实进程崩溃演练；提交确认丢失、恢复不可用等测试在真实 MySQL 事务外层注入异常，验证核对与状态转换路径，不宣称覆盖所有驱动/基础设施故障模式。

## 保留与未实现事项

成功结果在最终数据库时间更新时记录 completed_at，expires_at 采用 8 天，给 ADR-005 至少 7 天的窗口保留余量；业务事务超时 10 秒，不从业务事务开始时间扣减保留期。过期但未清理的结果仍可继续重放或识别 Key 冲突。

本次不启动清理任务、不新增恢复后台作业或运维 HTTP 接口。将来的清理器只能清理完成且已过保留期的结果；必须先核对并保护同 Key 的 STARTED/UNKNOWN 尝试，不能清理这些线索。清理后 Key 可能成为新请求，客户端不能主动复用 Key；业务唯一性约束必须独立存在。

未知结果的自动事实核对、人工处置入口、真实断网/进程崩溃演练，以及与订单等真实命令的锁集合、业务唯一性接入，仍需在对应任务中完成。组件禁止事务内外部支付、文件上传或其他不可回滚副作用。测试只修改随机创建的夹具用户版本作为事务探针，不开放或实现用户编辑业务端点。

## 测试

普通测试覆盖黄金指纹、Key 校验、规范化拒绝、摘要投影/64 KiB、HTTP 状态/重放头/Retry-After/本次 requestId。真实 MySQL 测试覆盖重试、跨操作/目标/参数冲突、不同用户作用域、并发一次执行、约 2 秒超时、回滚重试、重放授权撤销、提交确认丢失恢复、UNKNOWN 阻断、保留/清理后行为、审计故障和会话配置恢复。
