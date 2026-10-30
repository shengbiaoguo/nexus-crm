# RBAC 与对象级授权（2026-10-30）

后续前置补齐：现已增加销售对象 guard、同事务身份读取与身份写锁协调，见 [M1 前置基础能力](m1-foundations.md)。下文保留最初 M0 读取接口的实现范围；新增 guard 不表示 Customer/Order repository、列表 SQL 或管理写接口已经完成。

本次在现有 M0 身份模型上实现读取授权，遵循 permission-matrix.md §4/§8、现行 ADR-001/003/004/005；不改 BR-001～010。不新增 schema、Migration、依赖包、角色写入或业务模块。

## 已实现接口与规则

所有路径位于 `/api/v1`，要求有效 Bearer Access Token。Controller 只接收参数并调用 Service；权限和数据范围在 Service 内执行。

| 接口               | 授权                                      | 字段白名单                                 |
| ------------------ | ----------------------------------------- | ------------------------------------------ |
| GET `/users`       | `user:manage` 与 `IDENTITY` 配对          | id/name/loginName/departmentId             |
| GET `/users/:id`   | 本人，或上述用户管理授权                  | 同上，不包含密码、会话、凭证版本、他人权限 |
| GET `/roles`       | `role:manage` 与 `IDENTITY` 配对          | id/code/name/status/version，不含成员名单  |
| GET `/permissions` | `role:manage` 与 `IDENTITY` 配对          | id/code/description                        |
| GET `/departments` | `department:read` 与 `AUTHENTICATED` 配对 | 有效部门的 id/name/parentId，不含员工名单  |

部门接口以分页的扁平树节点表示组织关系，客户端根据 parentId 组装树；不是递归返回完整组织树。没有角色授权的账号也能读取本人资料，但不隐式获得任何列表权限。默认角色 seed 已包含员工部门读取授权，运行时不按角色名称硬编码放行。

所有列表返回既有 `{data,meta,requestId}`，meta 含 page/pageSize/total/totalPages；page 默认 1、范围 1–1000000，pageSize 默认 20、范围 1–100。只接收这两个查询字段；本次不开放筛选或客户端排序，固定 createdAt desc、id desc。用户详情沿用 `{data,requestId}`。ID 为无前导零的十进制字符串，范围 1–18446744073709551615，禁止转换为 JS Number。响应均使用 Cache-Control: no-store。

未登录或权威会话无效返回 401；DTO 校验失败返回 400；列表操作无权限返回 403 PERMISSION_DENIED；不可见或不存在的用户详情统一 404 RESOURCE_NOT_FOUND。数据库不可用返回泛化 503 SERVICE_UNAVAILABLE，不泄漏连接参数或底层异常。

## 授权如何执行

- `AuthGuard` 验证 JWT。`AuthorizationService.withRead` 在新的 MySQL RepeatableRead 事务快照中再次验证账号 ACTIVE、credential_version、会话归属/撤销/有效期，并读取当前有效角色和授权。不从 JWT、客户端参数或旧请求缓存读取权限。
- 固定 Policy 只支持本次三个 M0 权限映射；未知操作、错误 scope 和通配符均默认拒绝。动作与 scope 必须匹配同一条 role_permissions；不能将一个角色的动作和另一个角色的 IDENTITY/ALL 拼接。ALL 不等同于 IDENTITY，role:grant_business 不能单独代替 role:manage。
- 用户详情通过数据库 where 同时约束目标 ID 和可见范围：无 user:manage 时范围仅 actor.id。不是先读取所有用户再在内存或前端过滤。管理员也使用相同字段白名单。
- 角色停用、授权替换或成员关系撤销提交后开始的新查询使用新权限。一次读取中的授权、结果和总数使用同一个快照；并发撤销不能撤回已经开始读取的数据。withRead 仅用于读取，不是业务写入的授权事务入口。
- 本次读取不产生业务成功审计，也不创建 command_attempts 或幂等记录。拒绝由现有 HTTP 安全/运行日志记录，不记录请求凭据、不伪造业务成功。

## 数据库生命周期

原 `auth/auth.database.ts` 的懒加载生命周期封装移至 `infrastructure/PrismaService`，由 `DatabaseModule` 导出。AppModule 创建一次动态数据库模块，并把同一个模块注册对象传给 AuthModule 和 AuthorizationModule；两者复用一个 PrismaClient/连接池，应用关闭时统一断开。

不在每个模块重新创建数据库连接池，不使用全局可变客户端。HTTP 探活及 OpenAPI 导出仍不创建数据库连接。命令行 seed/核查脚本继续管理各自进程中的客户端，不因此改动无关脚本。

## 验证与边界

`pnpm test` 验证固定映射默认拒绝、同条授权配对、未知操作、匿名拒绝、失败关闭及 OpenAPI 契约。`pnpm test:db` 在明确配置的本地非生产 MySQL 上验证普通用户越权拒绝、本人安全投影、具有正确权限时允许、跨角色范围不串用、停用角色/替换授权/撤销成员关系即时生效、字段白名单、分页/ID/未知字段校验，以及读取与撤销并发。夹具只增删本次随机命名用户/角色及自己创建的字典行，不修改已有 seed 授权。

客户、商机、订单、交付和财务模型尚未实现，本次不假造这些对象的数据库范围条件。SELF_COLLABORATOR、TEAM、ASSIGNED_PROJECT、FINANCE_RELATED、完整父子关系校验和职责分离，须在对应业务模块接入真实权威关系时实现并用 MySQL 验证，不能使用此 M0 读取 Policy 放行。

用户/角色新增、编辑、停用、角色分配及权限替换写接口仍未开放。本次不宣称完成受保护 business_owner、自授防护、最后负责人或业务授权写入并发验收。未来写入必须按 permission-matrix.md §4.2 锁用户→角色→部门→业务对象，在同一事务内当前读取并重验动作/对象/状态/职责分离；关键授权变更另须遵守 ADR-003/005 的尝试、成功审计和幂等协议，不可将本次读取快照作为写入许可。
