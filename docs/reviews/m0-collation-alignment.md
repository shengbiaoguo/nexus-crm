# M0 排序规则统一

日期：2026-10-30。用户确认采用新增迁移、显式统一排序规则的方式。目标为 utf8mb4 / utf8mb4_0900_ai_ci，覆盖十张应用表及其字符列，不改写 init_m0 或 Prisma 元数据表。

## 应用前检查与 SQL 审查

- Prisma validate 通过，数据库默认值已是目标值；现有十张表为 utf8mb4_unicode_ci。
- 对所有含字符列的唯一键按目标规则检查，没有冲突。不输出实际键值。
- 将十张表的数据及 SHOW CREATE TABLE 保存到 Git 忽略的 artifacts/before-m0-collation.json；该文件可能含敏感数据，不打印、不提交、不覆盖。此开发快照不是生产完整备份或自动恢复工具。
- 使用 migrate dev --create-only --name align_m0_collation 生成空迁移，应用前填入 Prisma Schema 无法表达的排序规则 SQL。
- 新迁移 20261030020831_align_m0_collation 先移除 audit_logs_attempt_id_fkey，转换十张表，再按原来的 DELETE/UPDATE RESTRICT 恢复同名外键。该字符 FK 的两侧都是 CHAR(36)，其余 BIGINT 外键类型不变。
- 无表/数据删除，无 FOREIGN_KEY_CHECKS 关闭，无 _prisma_migrations 修改。MySQL DDL 隐式提交，转换不是一笔可自动回滚的事务；失败需停止并核对迁移、表及外键状态，不能自动 reset 或盲目标记 resolved。

## 实际结果

- migrate deploy 成功，migrate status 显示两个迁移均已应用。
- information_schema 确认十张表默认值及全部字符列均为 utf8mb4_0900_ai_ci；元数据表仍为原值。
- 十张应用表的数据按主键排序与迁移前快照逐项比较，完全一致；角色/权限及审计数量不变。
- 6 项真实 MySQL 集成测试通过，包括新增排序规则/新迁移校验和测试，以及原有唯一性、FK、CHECK、UTC/Json、并发和回滚测试。
- 7 项常规测试及 lint、typecheck、build、API smoke 均通过。前端原有约 596 kB 构建提示仍在。
- Prisma migrate diff 无差异；排序规则最终以实库测试为准，不仅依赖 Schema diff。db:verify 导出已加入表/列 collation 字段。
- 已应用的 init_m0 未修改，其校验和测试继续通过。

## 后续规则与交付

Prisma Schema 不编码该表级偏好。新建表的迁移必须在应用前显式声明 DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci；现有 CI 的 SQL 审查已覆盖后续 CREATE TABLE 声明。数据库将来改变默认值不会同步已有表，需另行新增迁移。

历史 init_m0 保留 unicode_ci，按顺序应用修正迁移后达到当前目标。AGENTS、README 和迁移目录说明已同步。没有新增业务表或修改 Auth/RBAC 行为；本地数据快照不纳入 Git。
