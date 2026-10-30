# 全局 DTO 参数校验

`application.ts` 使用 `http/validation.pipe.ts` 创建全局 ValidationPipe：转换为 DTO 实例，拒绝未知属性和未知校验对象，关闭隐式类型转换。数字字符串不会自动成为 DTO 数字字段；BigInt ID、金额仍以字符串传输。

校验失败返回 HTTP 400、`VALIDATION_FAILED`、`requestId` 和 `details.fields`。每项包含 `field` 与 `reason`，嵌套路径如 `items.0.name`。reason 使用校验约束名，不输出输入值、DTO 对象或自定义校验消息，避免消息模板泄露敏感输入。JSON 语法错误仍返回通用 400，不伪造字段详情。

后续端点必须使用运行时 DTO class（不能用 interface 或 type-only import），对允许接收的每个字段添加 class-validator 约束。嵌套对象使用 `@ValidateNested()`、`@Type(() => NestedDto)`，必填嵌套对象另用 `@IsDefined()`，数组另设数组类型与长度约束。全局管道不能推断业务字段、授权或对象关联规则。

字符串去空格按字段通过 `@Transform` 显式处理，转换前检查类型；密码、Token 等字段不应被通用 trim 修改。长度、枚举、金额和 ID 格式由各 DTO 的契约明确约束。不要使用隐式转换或无条件 `@Type(() => Number)` 掩盖非法类型。

区分缺失与 null：必填字段正常校验；允许缺失但禁止 null 的字段使用 `@ValidateIf((_object, value) => value !== undefined)` 配合类型约束。`@IsOptional()` 同时跳过 null 和 undefined，仅在契约允许两者时使用。当前没有业务输入端点，测试控制器只存在于测试文件，不会加入生产路由或 OpenAPI。

本次不涉及数据库结构、事务或 Auth/RBAC 执行逻辑。
