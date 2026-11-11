# Phase 2.1 实现与验收记录

## 范围与结论

Phase 2.1 已实现用户认证、SQLite 管理、WebSocket 会话认证、用户目录隔离和 GUI 文件管理框架。没有实现文件内容上传/下载、断点续传、多文件并发、VIP 限速、公钥认证或 Docker。

## 新增模块

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| Migration | `apps/server/migrations/001_initial.sql` | `users`、`sessions`、索引和约束 |
| Database | `apps/server/src/database.ts` | migration runner 和全部参数化 CRUD |
| Authentication | `apps/server/src/auth.ts` | Argon2id、随机 Token、Token 哈希、过期和撤销 |
| Storage boundary | `apps/server/src/storage.ts` | 每用户 UUID 根目录、路径和符号链接校验、配额统计 |
| Runtime config | `apps/server/src/config.ts` | 数据库、存储、会话及配额环境配置 |
| Initialization | `apps/server/src/init-database.ts` | migration 和 Alice/Bob 幂等初始化 |
| Protocol | `packages/protocol/src/index.ts` | 认证、当前用户、退出和文件列表消息/错误码 |
| GUI | `apps/client/src/App.vue` | 登录、用户信息、认证状态、文件列表框架、退出和重认证 |

## 安全实现

- 密码使用 Argon2id，参数为 19 MiB memory cost、2 次迭代、单并行度、32 字节输出；PHC 字符串保存在 SQLite。
- 会话 Token 来自 `randomBytes(32)`，原始值只发给客户端一次；数据库只保存 SHA-256 Token 查找值。
- 会话具有 `expires_at`、`revoked_at` 和 `last_seen_at`；每次受保护请求重新查询，不信任缓存用户或客户端 `userId`。
- GUI 只把 Token 保存在页面内存，不写 `localStorage`；刷新页面需要重新登录，网络重连则用内存 Token 重新认证。
- 用户查询和会话查询全部使用 prepared statement 参数，migration DDL 是版本控制内静态 SQL。
- 路径只允许逻辑相对路径；逐段 `lstat`，拒绝绝对路径、`..`、反斜杠、NUL、Windows 设备名和 symbolic link/junction。
- `quotaBytes`、`maxFiles`、`maxFileSizeBytes` 可配置并随列表返回；Phase 2.2 写入前必须强制检查。
- 日志只记录连接 ID、消息类型和通用错误，不记录用户名对应密码、原始 Token或请求 payload。

## 初始化

复制 `.env.example` 为被 Git 忽略的 `.env`，设置 `SFT_SEED_ALICE_PASSWORD` 和 `SFT_SEED_BOB_PASSWORD`，然后执行：

```powershell
npm run db:init --workspace @sft/server -- --seed-test-users
```

该操作幂等：已有同名用户不会被覆盖，也不会在控制台打印密码。删除数据库或用户属于高风险数据操作，不是初始化脚本的一部分。

## 实际测试

最终执行：

```powershell
npm run build
npm test
```

构建成功。测试覆盖并通过：

1. Alice 登录及 `AUTH_ME`。
2. 错误密码和 SQL 注入用户名登录失败。
3. 未认证 WebSocket 文件列表请求被拒绝。
4. Alice/Bob 文件可见性隔离。
5. `../`、Windows/Unix 绝对路径被拒绝。
6. Windows junction 或 POSIX symlink 越界被拒绝。
7. 退出后当前连接失去权限，Token 在新连接上显示已撤销。
8. Token 在现有连接和重连后均受过期检查。
9. HELLO、服务端 PING/客户端 PONG 和 Token 重连认证继续工作。
10. Vue 严格类型检查。

测试使用真实 WebSocket、真实 `node:sqlite` 内存数据库、真实 Argon2id 和 E 盘 `.cache/test-runs` 文件系统目录，不是 mock。测试生成目录在结束时清理。

## 已知限制与 Phase 2.2 建议

- 尚未用浏览器自动化工具执行真实点击流程；GUI 已通过构建和类型检查，认证协议由 WebSocket 集成测试覆盖，仍需人工浏览器演示确认。
- Node 22 的内置 SQLite 会显示 experimental warning；当前 Windows Node 22.17 已验证，后续应固定最低版本 22.5 并在提交环境复测。
- Element Plus 仍为全量导入，Vite 提示 bundle 超过 500 KiB；不影响功能，后续可按需加载。
- Phase 2.2 应复用 `resolveForCreate`，先实现单文件小分块上传：声明大小/摘要、配额预检、临时文件、顺序 offset、分块 ACK、整文件 SHA-256、fsync 与原子改名，再镜像实现下载。
