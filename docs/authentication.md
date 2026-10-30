# JWT 与 Refresh Token（2026-10-30）

本次仅实现认证，复用 `users` / `refresh_sessions`，无 schema 变化或新 Migration。不实现用户管理、账号停用 HTTP 命令、角色编辑或业务 RBAC Policy。BR-010 认证侧行为已实现：DISABLED 账号不能登录、续期或使用旧 Access Token。

## HTTP 契约

路径位于 `/api/v1`，沿用 `data/requestId` 成功包裹和统一错误响应。

| 接口                 | 输入                                            | 成功                                                              |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| POST `/auth/login`   | `{loginName, password}`                         | 200，令牌对                                                       |
| POST `/auth/refresh` | `{refreshToken}`                                | 200，轮换后的令牌对                                               |
| POST `/auth/logout`  | `Authorization: Bearer <accessToken>`，无请求体 | 204，无响应体，撤销当前会话                                       |
| GET `/auth/me`       | 同上                                            | 200，`{id, loginName, name, permissions:[{roleCode,code,scope}]}` |

令牌对为 `{accessToken, refreshToken, tokenType:"Bearer", expiresIn:900, refreshExpiresAt:<UTC ISO 时间>}`。登录、续期和 me 返回 `Cache-Control: no-store`。me 返回当前有效角色的权限与 scope 配对摘要，不构成业务对象授权；无权限的有效账号可以读取自己身份。

登录名去首尾空格，长度 1–100；密码保留空白，长度 1–256；Refresh Token 为 43 字符 base64url。未知字段、null 和类型不符返回 400。账号不存在、密码错误、账号停用统一返回 401 `UNAUTHENTICATED`；Access Token 到期返回 401 `TOKEN_EXPIRED`。配置/数据库不可用返回 503 `SERVICE_UNAVAILABLE`，审计失败返回 503 `AUDIT_UNAVAILABLE`，不返回底层异常。

## 配置与凭证

- 精确依赖 `jose@6.1.3`。JWT 固定 HS256、`typ=at+jwt`、issuer=`nexus-crm`、audience=`nexus-crm-api`，携带字符串 sub/sid、整数 cv、iat/exp，有效期 15 分钟。不保存权限或角色；不接受其他算法和用途。校验原则参考 [RFC 8725](https://www.rfc-editor.org/rfc/rfc8725.html)。
- `AUTH_JWT_SECRET` 必须是密码学随机 32 字节的规范 base64url 编码（43 字符），通过安全环境配置注入，不写入 Git、前端或日志。缺失时认证返回 503；探活和 OpenAPI 导出仍可运行，不连接 MySQL/Redis。无默认密钥或启动时自动生成生产密钥。
- Refresh Token 使用随机 32 字节，数据库仅保存 SHA-256 哈希，每次续期原子替换同一会话的哈希。有效期为登录起算的 7 天，续期不延长。旧刷新凭证立即失效，相同凭证并发最多一次成功。独立登录创建独立会话，登出不撤销其他会话。
- 密码采用 Node 异步 scrypt：N=32768、r=8、p=1、随机 16 字节盐、64 字节输出和恒定时间比较。格式为 `scrypt$32768$8$1$<salt hex>$<hash hex>`；受控账号初始化须调用 `hashPassword`。无明文或历史格式猜测回退，未知账号仍执行 KDF。字典 seed 不创建账号，本次不创建真实账号或默认密码。
- 每次受保护请求读取权威账号 ACTIVE 状态、校验 cv 等于 credential_version，并检查会话未撤销且未过期。登出使同会话新旧 Access Token 全部失效；刷新轮换不撤销尚有效的 Access Token。

## 事务与停用接入

登录、续期、登出使用 `AuditService.withTransaction` 和 ReadCommitted 隔离级别；锁顺序为用户→会话。参数化 SELECT FOR UPDATE 获取锁，随后由 Prisma 映射字段并当前读取。登录 KDF 在事务前执行，持锁后重验账号、密码哈希及凭证版本。会话写入与成功审计同事务提交；审计不保存密码、Token 或哈希。普通认证不在 ADR-003 关键命令尝试清单内，不创建伪造的幂等或 command_attempts 记录。

未来停用命令必须遵守 permission-matrix.md §4 的权限、受保护账号和最后负责人限制，在同一用户锁下置 DISABLED、递增 credential_version、撤销全部刷新会话并记录审计。不能仅更新状态又恢复状态而保留旧会话。本次测试仅在自己创建的随机夹具上模拟该事务并清理，不开放管理入口。停用与认证写入按用户锁提交顺序线性化，已返回的数据无法撤回。

数据库 COMMIT 结果不明时不自动重试或重放敏感令牌，返回 503；客户端可能需要重新登录。对已撤销会话重复登出返回 401。

## 已知边界

- 旧 Refresh Token 被拒绝，但不保留历史 token hash 或令牌家族，不能将旧令牌重放关联到后继凭证并自动撤销。完整家族盗用检测需要另行评审持久化模型与 Migration。
- 登录与续期共享每个直连 IP 每分钟 20 次的进程内限制，最多 10000 个活跃 IP 桶，DTO 失败也计入。重启重置，多实例不共享；默认不信任转发 IP。生产入口需另配可信代理和共享限流，阈值按部署环境确认。
- 未新增前端令牌存储、Cookie/CSRF 流程、账号创建/恢复/改密、自动密钥轮换或会话清理任务。客户端接入须单独设计，部署必须使用 HTTPS。
- 停用测试覆盖认证侧，不代表账号管理、受保护负责人规则或完整 M0 已交付。

## 验证

`pnpm test` 包含密码、JWT 签名/算法/用途/声明/过期、HTTP 校验/未知字段/匿名拒绝、限流和配置测试。`pnpm test:db` 使用明确配置的本地非生产 MySQL，覆盖 HTTP 登录、续期、一次消费、登出、跨会话隔离、账号停用、凭证版本、到期、续期与登出竞争及审计失败回滚。不创建数据库或启动系统服务。
