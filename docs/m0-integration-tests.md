# M0 集成测试验收

本轮仅补齐现有 M0 实现的集成验收，不实现新的管理命令或业务模块，不修改数据库结构或 Migration。测试直接使用真实 Nest 应用、HTTP 和本地 MySQL；不以 mock 替代数据库约束和权限验收。

## 执行

使用项目指定的 Node 24.22.2 / pnpm 10.34.9，先执行冻结锁安装、Prisma 客户端生成及 build。已有本地非生产数据库须已应用两份受审查的 M0 Migration；凭据从忽略的 `.env` 或进程环境读取。`localDatabaseUrl()` 拒绝 production 和非回环地址。测试不会创建数据库、启动服务或自动应用迁移。

```powershell
. ./scripts/use-local-tools.ps1
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm lint
pnpm typecheck
pnpm build
pnpm services:check
pnpm test:m0
pnpm smoke
pnpm openapi:export
```

`test:m0` 顺序执行既有普通测试与全部数据库测试，任何一项失败都会使命令失败；缺少数据库也会失败，不静默跳过。单独运行数据库集成测试用 `pnpm test:db`。CI 新增独立 `m0-integration` 作业，使用与 infra 一致的固定 MySQL/Redis 镜像，在临时空库明确执行 migrate deploy、字典 seed、服务检查与同一 `test:m0` 命令。runner 专用凭据不是部署凭据；本地测试不会执行这些建库/迁移步骤。远端 CI 是否通过须以实际运行记录为准。

## 覆盖与文件

| 验收项                                                                                               | 测试文件（apps/api/test 下）    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| 实际表、类型、FK/RESTRICT、唯一键、actor CHECK、迁移校验和、字符集、UTC、JSON null、事务回滚         | database/m0.test.ts             |
| 登录、轮换、并发单次消费、登出隔离、停用、凭证版本、会话过期、审计失败回滚                           | database/auth.test.ts           |
| 默认拒绝、动作/scope 配对、本人/他人投影、分页、ID、撤销即时生效及快照并发                           | database/authorization.test.ts  |
| 成功审计同事务、尝试独立持久化、故障回滚、核对不覆盖成功                                             | database/audit.test.ts          |
| 重放、同 Key 冲突、并发一次执行、等待超时、授权撤销、失败与提交未知                                  | database/idempotency.test.ts    |
| 真实登录→本人/列表读取→授权新增与撤销→刷新→登出；运行响应对照 OpenAPI；审计 requestId 与敏感字段检查 | database/m0-integration.test.ts |
| DTO、统一响应、序列化、JWT、策略、脱敏与错误处理的无数据库回归                                       | 各普通 *.test.ts                |

新增测试使用运行时导出的 OpenAPI 对照实际状态码、字段、必填项、类型、列表元素、枚举、nullable、UUID 和 UTC 时间；仅实现当前 M0 响应使用的 schema 子集，不宣称是完整 OpenAPI 校验器。错误 details 按契约允许自由对象，具体校验明细由已有 validation 测试验证。新增测试不手工签发 JWT，也不替换应用的 Service 或数据库连接。

夹具随机命名，角色成员关系只绑定本次账号；复用已有权限字典且不修改它们，仅清理本次创建的行。finally 关闭应用、按外键顺序清理夹具并断开客户端。应使用专用本地测试数据库，进程被强制终止时 finally 无法保证执行，需按随机前缀人工核对残留，不能对既有数据整体清空。

## 验收边界

通过现有实现的集成测试不代表所有 M0 规划功能均已开发：用户/角色写入、自授防护、最后负责人、受保护 business_owner 初始化、完整组织树写校验、自动后台尝试核对/保留期清理仍未开放。本轮通过直接修改隔离夹具验证权限读取变化，不把这些修改冒充管理 API。

未执行全新库迁移、历史库升级、备份恢复、真实断网或进程崩溃演练；现有数据库测试只核对当前库的迁移记录和实际约束。订单等后续模块的不变量与职责分离不在本轮范围。不得据此宣称完整 M0 产品功能或生产上线验收完成。
