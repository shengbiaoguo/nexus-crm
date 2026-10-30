# 结构化日志与审计

2026-10-30。实现依据为 ADR-003、ADR-005、API 契约 §1.3/3.1 和既有 M0 表。未新增业务模块、认证/授权接口或数据库结构。

## 运行日志

`LoggingModule` 提供 `StructuredLogger`，向 stdout 输出单行 JSON：UTC timestamp、level、event、component，以及允许的 requestId、attemptId、method、status、durationMs、code。HTTP 完成日志和异常日志使用响应头同一个服务器 UUID。异常过滤器的 4xx 作为 warn、5xx 作为 error，仅写安全错误码。

采用字段白名单而非序列化整个请求或异常：路径、query、headers、cookies、body、密码、Token、SQL、异常 message/stack 均不进入运行日志。Nest LoggerService 接口只记录固定 nest_log 事件及级别，主动丢弃框架传入的自由文本和异常参数；排障时优先使用关联 ID 与受控的事件字段，不依赖原始堆栈。新增字段必须审查白名单及测试，不能直接增加 message/error/body。

日志输出失败不改变 HTTP 或业务事务结果，运行日志不是成功审计凭据。当前只交付 stdout 日志和 audit_unavailable 告警事件；外部采集、告警投递及留存策略尚未配置。日志里不存幂等 Key 或请求指纹。`createApplication(..., false)` 禁用应用运行日志，用于测试和 OpenAPI 导出。

## 成功审计与关键尝试

`AuditModule` 导出 `AuditService`。Service 无数据库连接或启动定时器；由调用方显式传入既有 Prisma 根客户端，health 不依赖数据库。输入主体必须为一个有效十进制 actorId，或一个明确的 systemActor，不能匿名或同时传入两者；真实用户历史引用由 FK 保护。主体、对象及动作等元数据由服务端构造，不能直接使用请求体决定操作者。

关键命令调用顺序：

1. 完成认证、DTO、动作/对象授权及职责分离检查。本 Service 不代替这些检查。
2. `startAttempt(client, context)` 独立写 STARTED，返回 attemptId。用户 scope 必须等于 `user:<actorId>`，系统 scope 必须等于 `system:<systemActor>`。只接收关联元数据和既有规范指纹，不保存原始请求或计算业务指纹。预写失败返回 503 AUDIT_UNAVAILABLE，调用方必须停止业务。
3. `withTransaction(client, async tx => ...)` 创建并登记真实交互式事务。在同一个 tx 中完成业务状态重检、写入、幂等成功结果及 `recordSuccess(tx, {...context, attemptId, action, before?, after?, resultRef?})`。Service 校验尝试的主体、对象、requestId 和 STARTED/UNKNOWN 状态，条件更新 SUCCEEDED，写入成功审计。关键命令必须传 attemptId；普通非关键审计可以省略。不会自动创建业务表、幂等结果或越过对象锁协议。
4. 成功审计/重放失败会标记本事务不可提交；即使调用方错误地捕获异常，withTransaction 也会回滚。不能把根客户端或任意其他事务传给 recordSuccess/recordReplay。事务能力只在 callback 生命周期内有效，不要在 callback 内启动未 await 的写入。
5. 仅在确认事务回滚后调用 `recordFailureAfterRollback(client, attemptId, errorCode)`，独立记录 FAILED；记录失败返回 AUDIT_UNAVAILABLE 并保留待核对状态。网络/驱动/提交错误不能直接当作确认回滚。
6. 提交结果未知时调用 `markUnknown`；它仅将 STARTED 条件更新为 UNKNOWN，不覆盖已提交的 SUCCEEDED/REPLAYED/FAILED。调用方应按 ADR-005 核对原幂等 Key，未核实前返回 IDEMPOTENCY_RESULT_UNKNOWN，禁止换 Key 自动重做。无法写 UNKNOWN 时保留 STARTED 并告警。

`recordReplay(tx, context)` 只结束本次尝试为 REPLAYED，不增加成功审计。调用方须先验证当前授权及已存幂等结果。终态不能被失败标记、重复成功或恢复更新覆盖。专用 Service 不暴露审计修改/删除方法，也不提供公开审计查询路由。

## 快照和追溯

每个 before/after 快照包含 `value` 和显式 `fields` 路径，如 `['status', 'version', 'items.amount']`。未选字段在每一层被丢弃，数组逐项应用相同投影；只选对象本身不会展开其内部字段。敏感键（密码/令牌/凭据/银行卡/联系人等）替换为 [REDACTED]，字符串中的常见认证头、连接 URL、JWT、邮件和长电话号码/卡号模式也会脱敏。不修改原始对象；每个快照上限 16 KiB、深度上限 12，超限拒绝写入而不截断制造不完整审计。

脱敏模式不能识别任意自由文本中的所有秘密。白名单必须选择必要的状态、版本、金额摘要、依据引用等字段，不选择整段客户资料、审批自由文本或文件内容；不要把秘密放入 action/entityId/resultRef 等元数据。未提供快照存 SQL NULL，显式 null 存 JSON null。

通过 requestId 可关联 HTTP 日志、command_attempts 和 audit_logs；attemptId 关联一次尝试与成功审计；审计同时保留 actorId/systemActor、action、entityType/entityId、前后摘要、UTC createdAt。既有 seed 已接入该 Service，并保持系统主体 seed:m0。无变化时只记录 REPLAYED，不重复成功审计。

## 超时恢复与边界

`markOverdueUnknown(client, now?, attemptIds?)` 是显式恢复入口：默认将开始超过 5 分钟的 STARTED 条件更新为 UNKNOWN，每次最多 100 条；可指定 attemptIds 限定处理集合。逐条条件更新保证与成功提交竞争时不覆盖终态，仅实际变更才输出 attempt_unknown。测试始终限定自身生成的尝试，不处理已有历史记录。

本轮提供恢复服务入口，不自动启动数据库轮询，不安装调度器。部署时仍需安排受控的周期调用，并依据原幂等完成记录/成功审计核实 UNKNOWN；缺少证据时保留 UNKNOWN 人工核对。本轮没有实现幂等业务执行器、通用命令引擎或自动重执行业务。审计保留、数据库最小权限及外部防篡改备份需后续运维落地，不宣称本实现具有法律意义的防篡改能力。

## 验证

- `pnpm test`：字段投影、敏感数据脱敏、运行日志 JSON/白名单、真实 HTTP 日志关联，以及预写/成功审计/失败记录的故障注入。
- `pnpm services:check`：显式、本地、只读 MySQL 版本和 Redis PING。
- `pnpm test:db`：本地 MySQL 真提交及回滚，验证操作者/对象/requestId/attemptId/幂等结果可追溯，验证错误上下文、重复成功及并发恢复不覆盖已成功状态。测试使用独有 UUID/测试用户并按 FK 顺序清理自己的数据；不运行 seed，不更改现有授权模板，不重置数据库。
- lint、typecheck、build、编译后 API smoke、OpenAPI 导出使用根脚本，与普通 CI 工程检查一致。真实数据库测试仍须显式运行，未接入远端 CI 数据库服务。
