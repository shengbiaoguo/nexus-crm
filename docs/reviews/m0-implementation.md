# M0 实施与 init_m0 SQL 审查

日期：2026-10-30。用户已明确继续 M0 模型与首份 Migration，解除此前“仅补总结、先不应用”的暂停；仍不开发 Auth/RBAC 执行逻辑或 CRM 业务表。

## Schema 决定

- 10 个模型：User、Department、Role、Permission、UserRole、RolePermission、RefreshSession、AuditLog、IdempotencyRecord、CommandAttempt。最后一个来自 ADR-003 的既有 M0 要求。
- 8 个实体采用 BIGINT UNSIGNED 自增；UserRole、RolePermission 采用二列组合主键，并有反向查找索引。所有外键列类型一致。
- status 采用 ACTIVE/DISABLED；version、credential_version 从 1 开始。幂等 PROCESSING/COMPLETED，尝试五态依 ADR-003。
- snake_case 表/列通过 @map/@@map 映射；DATETIME(3)、JSON、UTC 及 BigInt 字符串策略见序列化实现和测试。
- 登录名及角色/权限码使用生成 SQL 的 utf8mb4_unicode_ci 唯一性，大小写变体不能创建重复身份。规范化 Key 为小写 UUID，scope=user:十进制ID，指纹及令牌哈希为小写 SHA-256 十六进制；后续写入服务负责格式校验，本阶段不实现认证/幂等执行器。
- AuditLog 和 CommandAttempt 使用可空 actor_id + system_actor，迁移 CHECK 强制二者恰有一个；系统操作可表示为 seed:m0，不创造默认登录账号。审计 attempt_id 是可空非唯一 FK，同一次尝试可对应多条成功审计。
- 幂等记录不与长期审计建立 FK，七天记录清理不删除历史审计或未知尝试。64 KiB 响应上限、状态转换及权限保护仍是后续执行逻辑职责。

## 生成与应用前 SQL 审查

1. 修改前及修改后均执行 prisma validate，通过。
2. 只读检查当前 .env 指定的本地 development 库，表数量为 0，不输出凭证。
3. 执行 `prisma migrate dev --create-only --name init_m0`，生成 `20261030014538_init_m0/migration.sql`。应用前 migrate status 显示 1 个待应用迁移。
4. 审查文件包含 10 个 CREATE TABLE，8 个自增主键、2 个组合主键、6 个额外唯一索引、14 个普通索引、10 个 FK；FK 全部 ON DELETE RESTRICT / ON UPDATE RESTRICT，无级联删除。
5. 索引覆盖部门归属、反向角色权限、会话到期、审计实体/时间/请求/尝试、幂等 scope/key 和状态/到期、尝试状态/开始及 scope/key。
6. 原生成 SQL 未表示系统主体互斥，应用前在版本化 migration.sql 中追加 2 个 MySQL CHECK。不是绕过迁移手工改库；后续测试验证数据库真正执行这些约束。Prisma Schema 不原生表示 CHECK，不能在以后重新生成迁移时丢弃。
7. 无 DROP、TRUNCATE、DELETE、凭证、CRM/订单/财务表；表创建后再加 FK，无创建顺序悬空问题。updated_at 由 Prisma @updatedAt 写入，原生 SQL 写入方必须显式填写；UTC 由连接及应用约定保证。

结论：该新增型迁移可用于已检查的本地空库；不能据此直接用于未知非空库。以下实际应用、测试及 Git 结果在执行完成后补录，不预先宣称通过。

## 实际执行与结果

| 检查                             | 实际结果                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| prisma validate / generate       | 修改前及模型完成后校验通过；Prisma Client 7.10.1 生成成功                                                          |
| 仅生成                           | migrate dev --create-only，未在 SQL 审查前应用                                                                     |
| 空库安全                         | 最初表数量 0；仅生成后只有空的 _prisma_migrations 元数据表，再次安全检查通过                                       |
| 迁移应用                         | 对已核验空库运行 migrate deploy 成功；无 reset/db push/手工建表                                                    |
| migrate status                   | 1 个迁移，Database schema is up to date                                                                            |
| migrate diff                     | 实库对当前 Schema：No difference detected，exit 0；CHECK 另通过 information_schema 和插入拒绝测试核验              |
| 实际结构                         | 10 张 M0 表 + _prisma_migrations；UNSIGNED BIGINT、DATETIME(3)、Json、10 个 RESTRICT FK 及 2 个 CHECK 验证通过     |
| Seed 第一次 / 第二次             | 首次成功初始化；第二次确认一致，不覆盖权限、不重复成功审计                                                         |
| Seed 数据                        | 7 个角色、46 个权限、113 个角色权限映射；0 用户、0 用户角色、0 会话                                                |
| Seed 可追溯性                    | 1 条系统成功审计，2 条系统尝试（初始化与重跑）；未创建默认登录身份                                                 |
| 常规测试                         | API 6 项（配置、HTTP、字典/默认授权、序列化）+ 前端 1 项，全部通过                                                 |
| 真实 MySQL 集成测试              | 5 项全部通过，包含结构/校验和、唯一键/FK/历史引用、UTC/Json null/CHECK、并发幂等所有者、成功记录回滚与独立尝试保留 |
| 测试清理                         | 身份/审计 fixture 事务回滚；仅按测试独有随机 scope/key 或 ID 清理技术记录；测试后用户/会话/幂等记录均为 0          |
| lint / typecheck / build / smoke | 全部通过；前端原有约 596 kB 分包提示仍在，无构建失败                                                               |

完整实库列、索引、FK、CHECK 和数量由 `pnpm db:verify` 保存为忽略目录 artifacts/m0-database-verification.json，不含密码或 Token 数据。Migration 文件的 SHA-256 与 _prisma_migrations.checksum 已由集成测试比对通过；.gitattributes 固定迁移 SQL 的 LF，避免跨平台换行改变校验和。

## Seed 与序列化实施边界

- 基础 Seed 在本地非 production 库运行；权限字典和角色映射是静态数据，不实现 RBAC 求值。已有模板或字典不符时拒绝并回滚，不覆盖其 scope/status/name、不删除额外角色、不分配任何 UserRole。
- 系统 Seed 尝试先独立记录；配置变化、成功审计、尝试成功同事务。重跑只有 REPLAYED 尝试；提交结果不明保留 UNKNOWN，不伪造失败，也不自动重执行业务。
- 首位真实业务负责人仍需未来受控 bootstrap，本阶段不虚构账号/密码。Auth、会话轮换、权限即时生效、授权防自授、审计核对任务和 HTTP 幂等执行器均未实现。
- serializeJson 只负责类型转换，必须先选出允许字段；不会自动脱敏或授权。SQL NULL/JSON null 使用 Prisma.DbNull/JsonNull 显式区分。MySQL 适配器固定 timezone=Z，并在连接初始化设置 session time_zone=+00:00。
- 数据库集成测试与普通测试脚本分离，不在未配置数据库的 CI 中假装运行成功；CI 继续验证 Schema、生成、SQL 静态检查及无数据库测试。远端 GitHub Actions 本次未运行。

## 交付文件与 Git

本次需纳入同一交付的文件包括 Schema、init_m0/migration.sql、migration_lock.toml、迁移说明；database Seed/验证工具、序列化和环境/适配器调整；数据库及常规测试；root/API scripts、CI SQL 检查、SQL 审查脚本、空库检查；README、AGENTS、设计总结及本文。.env、生成客户端、构建输出和实库验证 artifact 均忽略，不提交。

迁移 SQL 已应用，不再编辑；后续字段/约束变更必须新增 Migration。最终 Git 提交状态与提交号在交付答复中报告，不以此文件清单冒充已经提交。
