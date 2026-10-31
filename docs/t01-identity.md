# T01 受控身份准备与管理写入口

日期：2026-10-30（Asia/Shanghai）。范围依据 M1 计划 T01、permission-matrix §4.2/4.3/8、requirements 的 DC-001 基线及 ADR-003/005。T01 无 CRM 表依赖，不受 D-01～D-08 未决业务决策阻塞；未修改这些决策或执行 T05～T09。原有首位负责人 Bootstrap 已具备，本次复用并回归，不重复初始化。

## 最小接口契约

所有路径以 `/api/v1` 为前缀，要求有效 Bearer 身份；动作权限和 IDENTITY 必须来自同条当前授权。没有管理员/角色名旁路。

| 接口                           | 输入 / 输出                                                     | 授权与行为                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET `/users/:id/access-state`  | 返回 `{id,status,version,roleIds}`                              | user:manage 或 role:manage；同一读取快照。仅为版本化管理命令准备状态，不暴露登录资料、密码、凭证版本、会话。无写入或幂等 Key |
| POST `/users/:id/assign-roles` | `{expectedVersion,reason,roleIds}` → `{id,status,version}`，200 | role:manage；完整替换集合，空数组移除全部角色；新增、移除业务角色还需另一受保护业务负责人的 role:grant_business              |
| POST `/users/:id/disable`      | `{expectedVersion,reason}` → `{id,status,version}`，200         | user:manage；普通销售账号允许系统管理员停用；受保护账号另需另一业务负责人的 role:grant_business                              |

写入必须有 UUID `Idempotency-Key`。expectedVersion 为 JSON 整数 1～4294967294，避免递增溢出；reason 为 trim 后 1～500 字符；roleIds 为至多 100 个不重复的规范十进制无符号 BIGINT 字符串，不作 Number 转换。集合数值排序后参与 v1 指纹，数组顺序不改变授权语义。未知字段、null、隐式数字/字符串转换、重复或越界 ID 拒绝 400。目标不存在或请求的角色不存在/未启用为 404；版本不符 409；停用目标、无变化新命令、最后负责人保护等为 409；有效同 Key 重放在当前授权通过后返回首次快照和重放响应头。

这是既有管理动作的技术细化，不新增业务资格或业务 scope。access-state 是必要的最小读取配套：原 M0 用户详情没有 version/角色绑定，role:manage 也不隐含 user:manage，故不能让客户端猜版本或扩大原用户资料投影。原 GET 用户接口保持原白名单。用户 POST/PATCH、部门调整、角色/权限模板编辑、账号恢复均未开放，仍返回未注册路由；无完整身份 CRUD 的声明。

## 保护与事务

- 根据真实权限码和 scope 判断业务角色；除固定身份管理授权外的权限或 scope 均按业务能力保护。包括 role:grant_business 的角色始终受保护；该附加能力只有匹配当前受保护 business_owner 模板的实际授权才有效，不能靠另建同权限角色绕过。
- business_owner 的名称、状态和完整权限配对必须匹配既有 seed 模板，否则失败关闭。模板/权限编辑端点不开放，不修改 seed。受保护账号的角色绑定变更也需另一负责人，不能通过身份角色调整绕过其保护。自授/自撤业务角色、自停用受保护账号被拒绝；role:grant_business 不替代 role:manage 或 user:manage。业务负责人默认没有 user:manage，停用仍须另一授权人显式配置对应身份管理角色。
- 先在授权快照解析操作者、目标及全部受保护角色成员；沿用 100 用户锁上限，预留 actor/target 后至多 98 名受保护成员，超过安全执行容量返回 503，不截断或跳过保护。这个上限是本命令锁计划容量，不是业务角色人数决策。
- IdempotencyService 先争用 Key，再按数值 ID 锁全体用户；WriteLockService 按同一集合重入，再按 ID 锁角色、部门。新增角色预先纳入计划，受保护角色从一开始取 UPDATE，其余 SHARE，不事后升级/逆序补锁。持锁后重验成员/角色/部门完整集合，变化即回滚 409，调用方重读重试。
- 当前有效负责人定义为 ACTIVE 用户持有当前 ACTIVE 且完整匹配的受保护角色。用户集合锁及受保护角色锁串行化撤权/停用和 Bootstrap；首次执行前显式阻止移除最后一名负责人。两个负责人互相撤权或停用最多一条成功，另一条重新验证身份/附加授权时拒绝，至少保留一名。
- 角色替换只增删必要 UserRole、递增 User.version，不改密码/部门/cv。每请求查权威角色使撤权对同一 Token 立即生效。停用原子写 DISABLED、递增 version 和 credential_version、撤销该账号全部未撤销刷新会话；角色绑定、历史 User/FK/审计保留。
- 沿用 STARTED 预写、同事务业务+成功 AuditLog+SUCCEEDED+幂等结果、确定回滚 FAILED/未知提交核对协议；只存 `{id,status,version}` 标量结果。审计白名单为前后角色 ID/状态/版本、脱敏原因和业务授权要求标记，不保存凭据。
- 成功移除业务角色后，目标当前角色已不体现原操作的附加授权要求。因此重放还检查同主体/Key/操作/目标的成功尝试关联审计标记，**仅用于增加当前授权要求，不用于授予权限**；缺失证据失败关闭。曾有 grant、现在失去 grant 的操作者不能重放原业务撤权结果。

## 显式本地账号准备

原 `pnpm identity:bootstrap --initialize-business-owner` 不变：新登录名、无人已获受保护角色、严格匹配基线、scrypt、安全系统审计；任意已有成员（包括停用）阻止再次 Bootstrap，不提供恢复。

同一个显式入口增加 `pnpm identity:bootstrap --create-unassigned-user`，严格 JSON 标准输入仅 `{loginName,name,password}`，复用原校验和 hashPassword，密码 16～256 字符。只创建新员工 User，**不分配任何角色、部门或默认权限**；角色必须经上述受控 HTTP 命令由另一授权人分配。新账号已有登录名一律冲突，不覆盖、不恢复、不换密码；并发同登录名只有一次创建。系统 STARTED、创建和成功审计同事务，失败回滚、未知提交需核对，不自动二次创建。

这补齐空环境中“只有首位负责人、尚无可分配的后续账号”的准备路径，无需开放完整用户 CRUD。两个 CLI 都只接受显式单个模式、非交互 stdin、最多 4096 UTF-8 字节，localDatabaseUrl 限本地非生产；不可将密码放到命令行/历史/Git，使用受控秘密通道供给。未在本轮创建任何真实员工或默认账号，未自动调用生产 CLI。生产身份准备仍需独立评审授权。

## Migration、工作树和验证

本任务 **无新增 Migration / Schema / seed 变更**，只复用 User/UserRole/Role/RefreshSession 与平台表；启动时工作树已有 T04 未提交产物，全部保留，不重复应用迁移，不把 T04 文件算作本次新增。真实测试目标沿用此前已获授权的 127.0.0.1 本地 nexus_crm，执行前只读 MySQL 8.4.13 和 Redis PING 通过；未新建数据库、启动服务或访问生产。

数据库测试只创建随机员工夹具及其授权；不删除已有负责人。若库已有实际负责人，Bootstrap 和 T01 全局不变量夹具会显式失败，要求获准隔离环境，绝不清除真实数据。数据库测试文件改为 `--test-concurrency=1`，避免不同文件的 Bootstrap 空负责人前置与 T01 两负责人夹具互相污染；并发用例内部保留真实独立事务，并未改为模拟并发。CI 继续调用同一 test:db 脚本。

本次实际执行结果（非沿用 T04 历史结果）：

| 检查                                   | 结果                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Node / pnpm / 冻结锁离线安装           | 24.22.2 / 10.34.9，复用 F:/.pnpm-store 安装通过，锁文件无变更；保留既有 @scarf/scarf 构建脚本忽略提示 |
| Prisma validate、M0 / M1 SQL 审查      | 通过；未新增或应用 Migration；三份历史迁移 checksum 由实库回归校验                                    |
| lint / typecheck / build               | 全部通过；Admin 保留既有大于 500 kB 产物提示                                                          |
| 普通自动化测试 `pnpm test`             | API 31、Admin 1，全部通过，零失败/跳过；本次新增 3 个普通测试                                         |
| 真实 MySQL `pnpm test:db`              | 54 项全部通过，零失败/跳过；保留原 44 项，新增 T01 10 项；约 110 秒                                   |
| 编译后 API `pnpm smoke` / OpenAPI 导出 | 通过；health/docs/OpenAPI 不依赖 MySQL/Redis；新路由及错误响应已在实库 HTTP 用例核对                  |
| 本地 `pnpm services:check`             | MySQL 8.4.13 只读查询和 Redis PING 通过                                                               |

新增 10 项实库覆盖：新无角色账号创建/哈希/不覆盖/并发唯一/审计回滚；管理状态白名单、管理员业务自授/自撤及受保护账号拒绝、未开放模板/身份编辑 404；角色替换/版本冲突/Key 冲突/归一化重放、同 Token 撤权；业务移除后原调用者失去附加授权拒绝重放；停用的 cv/全部会话/登录/刷新/访问失效及历史保留；两负责人互相撤权、互相停用各仅一成功；审计故障回滚角色/版本/状态/cv/会话/Key；真实插入另一角色命令后原锁计划变化拒绝；外部角色锁阻塞时验证目标用户已被写命令锁住。并发用例没有被 mock 替代；故障注入和调度屏障只控制执行时点，实际事务/行锁/约束来自 MySQL。

以上检查没有未修复的失败。格式检查和最终工作树核对结果同步记于进度表；未运行的生产、远端 CI、备份恢复及真实网络/进程故障演练不列为通过。

## 修改文件与剩余边界

- 新增：`apps/api/src/authorization/identity-write.controller.ts`、`identity-write.dto.ts`、`identity-write.policy.ts`、`identity-write.service.ts`；`apps/api/src/database/provision-identity.service.ts`。
- 修改：`apps/api/src/app.module.ts`、`authorization/authorization.module.ts`（复用同一个 Database/Auth/Idempotency 注册对象）；`authorization/write-lock.service.ts`（预声明额外/排他角色锁并重验）；`database/bootstrap-identity.ts`（显式无角色账号模式）；`apps/api/package.json`（测试文件隔离）。
- 测试：新增 `apps/api/test/identity-write.test.ts`、`apps/api/test/database/identity-write.test.ts`。
- 文档：本文件、`docs/plans/m1-progress.md`、`docs/api-design.md`、`docs/permission-matrix.md`、`docs/authorization.md`、`docs/m1-foundations.md`、`docs/engineering-initialization.md`。

未实现通用用户/角色/部门编辑或恢复、生产初始化与部署、T05 销售 repository/授权查询或其他 T 任务。远端 CI、真实断网/崩溃和备份恢复本次未执行。T01 完成本地验收且 T04 已通过后，下一项满足直接依赖的是 **T05**；T02 专项、T03 签收和未决 D 项仍按原进度保留。

建议 Commit：`feat(identity): prepare controlled M1 identities`。本次不自动提交。
