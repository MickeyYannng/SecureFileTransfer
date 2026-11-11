# Phase 2.2 单文件分块上传验收记录

## 1. 完成范围

Phase 2.2 在现有认证长连接上实现单文件上传，不使用 HTTP 上传 API：

- `UPLOAD_INIT/READY`、二进制 `UPLOAD_CHUNK`、`UPLOAD_ACK`、`UPLOAD_FINISH/COMPLETE`、`UPLOAD_ABORT/ABORTED`、`UPLOAD_ERROR`。
- 延续 100 字节大端固定头，包含版本、类型、标志、请求/任务 UUID、文件大小、偏移、payload/metadata 长度和分块 SHA-256。
- 浏览器用 `File.slice()` 以 1 MiB 窗口增量计算整文件 SHA-256，再按默认 256 KiB 顺序分块；收到服务端 ACK 才发送下一块。
- 服务端用临时文件流式、位置明确的写入；检查任务归属、会话、长度、顺序偏移、边界和每块摘要，每块持久化后 ACK。
- 完成时核对接收字节、临时文件大小和整文件摘要，以硬链接原子且不覆盖地提交到用户私人目录。
- GUI 提供选择、进度、平均速度、状态/错误、取消，以及成功后的文件列表刷新。

本阶段没有实现下载、断点续传、多文件并发、VIP 限速、公钥认证、TLS 或 Docker Compose。

## 2. 安全与资源策略

- 每次初始化、分块、完成和取消都从 SQLite 重新验证绑定会话；客户端不能指定 `userId`。
- 路径只接受服务器校验的逻辑相对路径，拒绝 `..`、绝对路径、反斜杠、NUL、Windows 保留名和符号链接/目录联接越界。
- 初始化阶段检查单文件大小、用户总字节、文件数、可用磁盘空间、全局/用户活跃任务和同名目标。
- 进程内互斥地预留文件字节数、文件数和目标路径，阻止同一服务实例中的并发配额绕过与同名竞态。
- WebSocket 禁用压缩并限制最大 message；每连接串行处理并限制待处理消息数量。异常块会使任务失败，释放预留并清理临时文件。
- 临时文件使用独占创建；完成文件绝不覆盖。断开、取消、过期、错误摘要、大小不符和 I/O 错误不会留下可见残缺文件。
- 日志不记录密码、原始 Token、文件内容或宿主绝对路径。

注意：配额预留目前仅适用于单 Node 进程；多实例部署前必须使用共享事务或租约。TLS/WSS、Origin allowlist 和系统级 Windows ACL 属于 Phase 3，因此当前 `ws://` 仅限本机开发。

## 3. 自动化测试映射

| 验收项 | 覆盖位置 |
| --- | --- |
| 0 字节、小文本、1 MiB 二进制上传和 SHA-256 | `apps/server/src/upload.test.ts` |
| 100 MiB 流式文件上传、源/目标 SHA-256、连接仍可用 | `apps/server/src/upload.slow.test.ts` |
| 错误整文件摘要、声明大小不一致 | `upload.test.ts` |
| 错误/重复/乱序 offset、错误分块摘要 | `upload.test.ts` |
| 未认证、Bob 跨用户路径、`../` 和绝对路径 | `upload.test.ts` |
| 断线、主动取消后的临时文件清理 | `upload.test.ts` |
| 活跃任务和已提交文件同名冲突 | `upload.test.ts` |
| 单文件、总字节、文件数及活跃任务限制 | `upload.test.ts` |
| 上传完成后 `AUTH_ME` 与心跳继续 | `upload.test.ts` |
| 固定头编解码和长度不一致拒绝 | `packages/protocol/src/index.test.ts` |
| Phase 1/2.1 回归 | `apps/server/src/server.test.ts` 及全仓测试 |

测试全部使用真实 WebSocket 和临时文件系统目录，不 mock 文件写入或网络协议。普通测试不生成 100 MiB 文件；慢速测试单独运行并只在项目 `.cache/test-runs`（E 盘）创建测试数据，结束后清理。

## 4. Windows 11 运行与演示

首次运行或需要更新测试账号时：

```powershell
Copy-Item .env.example .env
# 在被 .gitignore 忽略的 .env 中设置 Alice/Bob 本地演示密码
npm install
npm run db:seed --workspace @sft/server
npm run dev
```

打开 <http://localhost:5173>，使用首次执行 `db:seed` 时写入数据库的用户名/密码登录。修改 `.env` 或 `.env.example` 不会改变已有 Alice/Bob；`db:seed` 是幂等创建且不会覆盖旧密码。现阶段也没有密码重置命令，不应为改密码而直接删除含用户文件的数据库。登录后选择文件、点击“上传文件”，观察摘要计算、进度、速度和完成状态；成功文件会出现在当前用户列表。Alice 与 Bob 各自只能看到自己的目录。

验证命令：

```powershell
npm run build
npm test
npm run test:slow-upload --workspace @sft/server
```

### 4.1 2026-11-11 实际执行结果

| 命令/检查 | 结果 |
| --- | --- |
| `npm run build` | 通过：协议、服务端 TypeScript 及 Vue/Vite 生产构建成功 |
| `npm test` | 通过：协议 4 项、服务端 20 项、客户端严格类型检查；0 失败/跳过 |
| `npm run test:slow-upload --workspace @sft/server` | 通过：真实 100 MiB 分块上传、源/目标 SHA-256 和连接复用，单项约 1.7 s |
| `npm run dev` | 通过：实际启动后 `/health` 返回 `phase: "2.2"`，Vite 首页返回 HTTP 200；检查后已停止，3000/5173 端口释放 |
| `npm audit --omit=dev` | 通过：0 个已知漏洞（首次受限网络请求失败，联网重试成功） |
| `git diff --check` | 通过；只显示 Windows 工作区 LF→CRLF 提示，无空白错误 |

已验证真实 WebSocket 协议和文件系统行为，但没有启动浏览器自动化执行鼠标点击；GUI 的人工登录、选择文件和取消按钮仍需演示者在浏览器中复核。Vite 提示主 JS chunk 超过 500 KiB，属于 Element Plus 全量导入的性能提示，不影响本阶段构建验收。Node 22 内置 SQLite 仍输出 experimental warning。

## 5. 本次实现文件

- `packages/protocol/src/index.ts`、`index.test.ts`：上传消息类型、100 字节帧编解码与边界测试。
- `apps/server/src/upload.ts`：上传状态机、配额预留、分块持久化、摘要和提交。
- `apps/server/src/storage.ts`：临时目录、用量/磁盘检查和原子提交。
- `apps/server/src/server.ts`、`config.ts`：WebSocket 集成、会话复核、资源限制和错误映射。
- `apps/server/src/upload.test.ts`、`upload.slow.test.ts`：快速与 100 MiB 真实集成测试。
- `apps/client/src/App.vue`、`style.css`：分块摘要/上传和 GUI。
- `.env.example`、协议/架构/计划/需求文档和本验收记录。

## 6. 已知限制与 Phase 2.3 建议

- 没有浏览器自动化框架；构建覆盖 Vue 类型/模板，协议联调由真实 Node WebSocket 客户端覆盖，GUI 点击流程仍需人工演示确认。
- 当前整文件摘要阶段和上传阶段会读取文件两遍，但两次都是分块读取，内存有界。这换取上传前能在 `UPLOAD_INIT` 声明准确摘要。
- 每块 `fsync` 强化 ACK 的持久化语义但降低吞吐；后续可在保持明确 ACK 语义的前提下评估批量同步策略。
- 服务进程被强制终止时临时文件在下次启动清理；Phase 2.2 不恢复未完成任务。
- 下一阶段建议只实现单文件分块下载，复用认证、路径、固定头、顺序 ACK、流式 SHA-256 和长连接，不提前加入 Phase 4 功能。
