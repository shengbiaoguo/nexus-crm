# 全局异常与统一响应

依据 API 契约 §1.2–1.4 与 ADR-003。业务核心规则及权限执行逻辑不在本次范围内。

- Controller 返回经过字段白名单选择的数据，由全局 `ResponseInterceptor` 包装为 `{ data, requestId }`。不要手工返回同名信封；普通对象中的 `data` 字段仍作为业务数据处理。
- 列表返回 `new ListResult(items, meta)`，生成 `{ data, meta, requestId }`。只有显式列表结果带分页 meta。不会自动计算总数或读取数据库。
- HTTP 200/201 等状态保持原样；204/304 没有响应体。null 保持 null，普通 void 结果映射为 data:null。BigInt 转为十进制字符串，Date 转 UTC ISO 字符串；不支持的输出类型应先显式映射，避免隐式丢失精度。
- 当前统一拦截器适用于 JSON API；下载、流式响应等端点尚未实现，新增时应明确其响应方式，不把二进制结果作为普通 DTO 返回。
- `requestIdMiddleware` 在 JSON 解析前生成 UUID，覆盖客户端 X-Request-Id。成功与错误体的 requestId 均取相同响应头；404、JSON 解析错误也包含该 ID。运行日志只包含 ID、方法、状态和耗时。
- `ErrorFilter` 保留 HTTP 状态。普通 HttpException 使用安全的默认错误码与文案，不透传框架响应对象中的 message/code/details。401、403、404、409、422、429、503 分别有默认映射；未列举的 4xx 使用 HTTP_ERROR，未列举的 5xx 使用 INTERNAL_ERROR。500 和非预期异常统一隐藏内部信息。
- Service 可抛出 `ApiException(code, publicMessage, details?)`。code 取 API 契约白名单，其 HTTP 状态固定；包括 VERSION_CONFLICT、TOKEN_EXPIRED、AUDIT_UNAVAILABLE 等。这里只定义传输方式，不实现这些业务能力。message 和 details 必须由调用方显式选择公开且已授权的内容，不能直接传入数据库错误或请求体。可预期的 503 可以返回明确的公开业务提示。
- DTO 校验保留 VALIDATION_FAILED 及 details.fields。异常不会被成功拦截器包装；错误日志只记录 requestId、错误码，不输出异常文本、SQL、凭据或请求体。

Swagger 的 health 成功响应保持现有信封。全局通用错误 schema 供端点复用；未来具体端点须按实际行为声明状态及响应 DTO，统一拦截器不能自动推断业务 OpenAPI 类型。

本次没有 schema/Migration 变更，不运行数据库测试，不新增业务接口、认证或权限决策。
