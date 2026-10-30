# 架构决策记录（ADR）

状态说明：Accepted 表示本项目当前采用的设计基线，不代表已在运行环境验证。实现变更时如推翻决策，应新建 ADR 标记 Superseded，不直接覆盖历史理由。

| 编号 | 决策 | 文件 |
|---|---|---|
| ADR-001 | ADR-001：订单作为跨模块并发协调锚点 | [0001-order-concurrency-anchor.md](0001-order-concurrency-anchor.md) |
| ADR-002 | Superseded by ADR-005：MySQL 幂等的历史决策 | [0002-idempotency-persistence.md](0002-idempotency-persistence.md) |
| ADR-003 | ADR-003：业务审计与运行日志分离 | [0003-audit-and-operational-logs.md](0003-audit-and-operational-logs.md) |
| ADR-004 | ADR-004：数据库版本演进采用 Prisma Migration | [0004-prisma-migration-strategy.md](0004-prisma-migration-strategy.md) |
| ADR-005 | Accepted：V1 幂等作用域与失败、过期契约（替代 ADR-002） | [0005-idempotency-scope-clarification.md](0005-idempotency-scope-clarification.md) |

2026-10-29 修订：ADR-001 修复无效 BR 引用并补里程碑接入；ADR-003 补可靠失败尝试协议。均保留原架构取舍；ADR-002 的作用域决策发生变化，故以新 ADR-005 替代而不覆盖历史理由。
