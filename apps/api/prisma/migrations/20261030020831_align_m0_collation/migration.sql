-- Custom collation-only migration; Prisma Schema cannot express table collations.
-- Reviewed for MySQL 8.4. Run target-collation uniqueness checks and retain a backup first.
-- Do not modify init_m0, disable FK checks, or alter Prisma's metadata table.

ALTER TABLE `audit_logs` DROP FOREIGN KEY `audit_logs_attempt_id_fkey`;

ALTER TABLE `users` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `departments` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `roles` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `permissions` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `user_roles` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `role_permissions` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `refresh_sessions` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `command_attempts` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `audit_logs` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE `idempotency_records` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_attempt_id_fkey`
    FOREIGN KEY (`attempt_id`) REFERENCES `command_attempts` (`attempt_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
