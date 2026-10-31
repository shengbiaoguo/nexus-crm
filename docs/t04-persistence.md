# T04 CRM 持久化批次 A 执行记录

日期：2026-10-30（Asia/Shanghai）。范围仅 Customer / CustomerMember / CustomerContact / Opportunity / FollowUp 持久化；依据 requirements §14、data-model §12、api-design §10、permission-matrix §10 及 D-06/D-08 全部批准记录。未执行 T05～T07，未添加业务 Controller / Service、React 页面、报价/订单/财务表或 expected_amount，未提交 Git Commit。

## 环境、迁移与审查

执行前 Schema 为 10 个 M0 模型，仅 `20261030014538_init_m0`、`20261030020831_align_m0_collation` 两份迁移。只读确认 NODE_ENV=development，MySQL 8.4.13 位于 127.0.0.1:3306，目标 nexus_crm；Redis PING 通过。现有配置不含独立 shadow / 空库 / 历史升级库，实例最初也没有这些库，因此先停止对应写操作。用户在本会话确认开发库迁移授权，并明确授权创建 nexus_crm_shadow、nexus_crm_m1_empty、nexus_crm_m1_history 三个本地测试库；复用未提交的本地配置，未输出凭据，未启动服务或访问生产。

1. 冻结锁离线安装，复用 `F:/.pnpm-store`；Node 24.22.2 / pnpm 10.34.9，锁文件无变更。
2. 修改 Schema，Prisma format / validate / generate 通过。Prisma config 增加可选 SHADOW_DATABASE_URL；本次仅进程内设置，指向获准的独立 shadow，未复用业务库作为 shadow。
3. 创建获准测试库；历史库先 migrate deploy 原有 M0 迁移，加入随机停用 User + AuditLog 夹具；对开发库和历史库所有 M0 表保存行数和排序后内容 SHA-256，记录旧迁移 checksum，不保存原始账号或审计正文。
4. 实际执行 `pnpm prisma:migrate:dev --create-only --name m1_crm`，生成 `20261030090155_m1_crm`。在尚未应用的新 SQL 内，将五表默认 collation 修正为批准值，把辅助列补为 STORED 生成列，并增加四个 CHECK；未修改历史迁移。审查发现所有 ALTER 仅针对新 CRM 表，无 M0 ALTER、删表、重建、数据写入或级联删除；5 表 / 12 RESTRICT FK、全部 UK/索引/类型通过审查。
5. 审查后通过 `pnpm prisma:migrate:deploy` 将这份确定的迁移应用开发库，避免再次生成 SQL；空库 replay 全部三份迁移，历史 M0 库只追加 A。两类路径均成功，全部 M0 数据内容摘要与旧 checksum 均保持一致，历史用户和审计未丢失。数据库保留，不重置或删除。

最终约束和 Prisma 生成列映射见 [data-model §12.4](data-model.md)。CustomerMember 使用复合主键，未添加无已批准语义的候选 member_role，保留 D-07；这是候选落库收敛，不改变已批准协作权限。MySQL CHECK/生成列表达式和 collation 不能由 Prisma Schema 完整表达，故保存在新迁移 SQL，并由独立 SQL 审查及 information_schema / 行为测试保护。数据库到 Schema diff 为空，生成列未造成客户端写入或后续 Schema diff 冲突。

## 实际检查结果

| 检查                                                                                                | 本次结果                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 冻结锁安装                                                                                          | 通过；仅既有 @scarf/scarf 构建脚本忽略提示                                                                  |
| Prisma validate / generate                                                                          | 通过，15 模型                                                                                               |
| `node scripts/review-m0-sql.mjs` / `node scripts/review-m1-sql.mjs`                                 | 通过；旧 SQL 不变，新 SQL 无 M0 破坏性操作                                                                  |
| `pnpm lint` / `pnpm typecheck` / `pnpm build`                                                       | 通过；Admin 保留既有大于 500 kB 产物提示                                                                    |
| `pnpm test`                                                                                         | API 28 / Admin 1 全部通过，零失败/跳过                                                                      |
| `pnpm test:db`                                                                                      | 开发库真实 MySQL 44 项全部通过，零失败/跳过（原 39 + CRM 5）                                                |
| 空库升级后 m0.test + crm.test                                                                       | 11 项全部通过，零失败/跳过                                                                                  |
| 历史 M0 库升级后 m0.test + crm.test                                                                 | 11 项全部通过，零失败/跳过                                                                                  |
| `pnpm services:check`                                                                               | 本地 MySQL 8.4.13 只读查询和 Redis PING 通过                                                                |
| `pnpm smoke` / `pnpm openapi:export`                                                                | 编译后 API health/docs/OpenAPI 通过，不依赖 MySQL/Redis；未新增 CRM 路由                                    |
| `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`            | 返回 empty migration                                                                                        |
| `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` | 获准 shadow 重放迁移后返回 empty migration                                                                  |
| `pnpm format:check` / `git diff --check`                                                            | 最终通过；首次 format:check 指出工程记录及既有实施计划格式，Prettier 修正后通过；计划与格式化后的 HEAD 一致 |

CRM 5 项覆盖：精确五表列清单、类型/必需索引/唯一键/12 FK 目标及生成表达式/本次 checksum；非空代码全库唯一、归档不释放、多个 NULL 和同名共存；两个独立并发插入相同代码仅一条提交；并发指定主联系人仅一条提交、普通联系人不被布尔 UK 误限、停用不能保留主标记、清主后可另设主；五模型各 FK 的孤儿拒绝、RESTRICT、停用历史用户与审计、更正引用保留原文。并发测试直接验证数据库约束，不冒充后续客户锁下自动替换或业务成功审计的 HTTP 测试。

M0 测试保留既有类型、actor CHECK 行为、两个历史 checksum、外键 RESTRICT 断言，并补强为 M0 十条 FK 名称精确子集；全库清单演进为 15 应用表、22 FK、6 CHECK。CRM 测试逐一核对新 FK 的列和目标；未删减重要约束。CI 沿用 frozen-lock 安装及既有 test:db 路径，增加相同 M1 SQL 审查；远端 CI 本次未运行。

## 复现和边界

`scripts/verify-m1-migration.mjs` 为显式本地一次性升级演练工具，普通 test/test:db 不自动建库。准备参数为 `--prepare-authorized-local-databases`：只接受上述固定本地开发库及三个新库名，任一测试库已存在即拒绝，无覆盖/重置；使用原有两份 M0 SQL 的隔离副本部署历史库。随后按正文生成、审查、应用 A，再传 `--verify-authorized-local-upgrade` 部署空库/历史库并比较 M0 摘要。验证要求空库尚无表，不能在已使用的目标上重复运行；本次已验证重复 prepare 被保护性拒绝，无数据库修改。摘要及隔离历史迁移副本仅在忽略的 artifacts 内。

未运行生产、远端 CI、备份恢复、真实进程崩溃/代理断网演练；这些不记为 T04 已通过的检查，M1 全链路和恢复演练仍保留 T17。信用代码规范化/不可清空、同客户更正、追加不可变、100 有效联系人、归档和终结锁竞争、授权读取均需后续业务实现，T04 仅证明存储约束。本次 T04 持久化验收通过，到此停止。

建议 Commit Message：`feat(crm): add customer opportunity persistence`。

## 本次修改文件

- Schema / 迁移：`apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/20261030090155_m1_crm/migration.sql`、`apps/api/prisma/migrations/README.md`。
- 配置：`apps/api/prisma.config.ts`、`.env.example`（独立 shadow 占位说明）。
- 测试与审查：`apps/api/test/database/crm.test.ts`、`apps/api/test/database/m0.test.ts`、`scripts/review-m1-sql.mjs`、`scripts/verify-m1-migration.mjs`、`.github/workflows/ci.yml`。
- 文档：本记录、`docs/data-model.md`、`docs/plans/m1-progress.md`、`docs/engineering-initialization.md`；`docs/plans/m1-implementation-plan.md` 仅修复既有格式检查问题，不修改编号、计划或依赖。
