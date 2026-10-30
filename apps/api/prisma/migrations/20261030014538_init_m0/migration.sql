-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `login_name` VARCHAR(100) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `department_id` BIGINT UNSIGNED NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `credential_version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_login_name_key`(`login_name`),
    INDEX `users_department_status_idx`(`department_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `departments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `parent_id` BIGINT UNSIGNED NULL,
    `name` VARCHAR(100) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `departments_parent_idx`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(64) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `version` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `roles_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(100) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `permissions_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `role_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_roles_role_idx`(`role_id`),
    PRIMARY KEY (`user_id`, `role_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `role_id` BIGINT UNSIGNED NOT NULL,
    `permission_id` BIGINT UNSIGNED NOT NULL,
    `scope_code` ENUM('SELF_COLLABORATOR', 'TEAM', 'ASSIGNED_PROJECT', 'FINANCE_RELATED', 'ALL', 'IDENTITY', 'AUTHENTICATED', 'CATALOG') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `role_permissions_permission_idx`(`permission_id`),
    PRIMARY KEY (`role_id`, `permission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refresh_sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refresh_sessions_token_hash_key`(`token_hash`),
    INDEX `refresh_sessions_user_revoked_idx`(`user_id`, `revoked_at`),
    INDEX `refresh_sessions_expiry_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `actor_id` BIGINT UNSIGNED NULL,
    `system_actor` VARCHAR(100) NULL,
    `action` VARCHAR(100) NOT NULL,
    `entity_type` VARCHAR(64) NOT NULL,
    `entity_id` VARCHAR(100) NOT NULL,
    `before_json` JSON NULL,
    `after_json` JSON NULL,
    `request_id` VARCHAR(100) NOT NULL,
    `attempt_id` CHAR(36) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_entity_time_idx`(`entity_type`, `entity_id`, `created_at`),
    INDEX `audit_logs_actor_time_idx`(`actor_id`, `created_at`),
    INDEX `audit_logs_request_idx`(`request_id`),
    INDEX `audit_logs_attempt_idx`(`attempt_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_records` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `scope` VARCHAR(64) NOT NULL,
    `key` CHAR(36) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `fingerprint_version` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    `status` ENUM('PROCESSING', 'COMPLETED') NOT NULL DEFAULT 'PROCESSING',
    `http_status` SMALLINT UNSIGNED NULL,
    `response_body` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `idempotency_records_status_expiry_idx`(`status`, `expires_at`),
    UNIQUE INDEX `idempotency_records_scope_key_key`(`scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `command_attempts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `attempt_id` CHAR(36) NOT NULL,
    `actor_id` BIGINT UNSIGNED NULL,
    `system_actor` VARCHAR(100) NULL,
    `operation_id` VARCHAR(100) NOT NULL,
    `entity_type` VARCHAR(64) NOT NULL,
    `entity_id` VARCHAR(100) NOT NULL,
    `request_id` VARCHAR(100) NOT NULL,
    `idempotency_scope` VARCHAR(64) NOT NULL,
    `idempotency_key` CHAR(36) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `status` ENUM('STARTED', 'SUCCEEDED', 'REPLAYED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'STARTED',
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `error_code` VARCHAR(100) NULL,
    `result_ref` VARCHAR(255) NULL,

    UNIQUE INDEX `command_attempts_attempt_id_key`(`attempt_id`),
    INDEX `command_attempts_status_started_idx`(`status`, `started_at`),
    INDEX `command_attempts_scope_key_idx`(`idempotency_scope`, `idempotency_key`),
    INDEX `command_attempts_actor_idx`(`actor_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_department_id_fkey` FOREIGN KEY (`department_id`) REFERENCES `departments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `departments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `refresh_sessions` ADD CONSTRAINT `refresh_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_attempt_id_fkey` FOREIGN KEY (`attempt_id`) REFERENCES `command_attempts`(`attempt_id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `command_attempts` ADD CONSTRAINT `command_attempts_actor_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Reviewed MySQL CHECK constraints: each event has exactly one explicit actor.
-- Prisma Schema does not represent CHECK expressions; keep these in migration history.
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_check`
    CHECK ((`actor_id` IS NOT NULL AND `system_actor` IS NULL)
        OR (`actor_id` IS NULL AND `system_actor` IS NOT NULL AND CHAR_LENGTH(TRIM(`system_actor`)) > 0));

ALTER TABLE `command_attempts` ADD CONSTRAINT `command_attempts_actor_check`
    CHECK ((`actor_id` IS NOT NULL AND `system_actor` IS NULL)
        OR (`actor_id` IS NULL AND `system_actor` IS NOT NULL AND CHAR_LENGTH(TRIM(`system_actor`)) > 0));
