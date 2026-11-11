# Phase 2.3 单文件分块下载验收记录

## 1. 完成范围

Phase 2.3 在已有认证 WebSocket 长连接上实现单文件下载，不使用 HTTP 下载接口：

- `DOWNLOAD_INIT/READY`、二进制 `DOWNLOAD_CHUNK`、`DOWNLOAD_ACK`、`DOWNLOAD_FINISH`、双向 `DOWNLOAD_COMPLETE`、`DOWNLOAD_ABORT` 和 `DOWNLOAD_ERROR`。
- 下载分块复用 100 字节大端固定头，类型为 `0x0202`，默认 256 KiB，一次只允许一个未确认块。
- 服务端使用受控逻辑相对路径、只读文件句柄和位置明确的有界读取；客户端逐块验证 SHA-256 后才 ACK。
- 服务端在 READY 前流式计算文件摘要，并在最后一块 ACK 后验证实际发送摘要及打开句柄/当前路径身份。
- `DOWNLOAD_FINISH` 不是成功：客户端整文件验证后发送 COMPLETE，服务端接受后才释放为完成状态。
- ACK/完成确认超时、非法/重复偏移、取消、会话失效、断线、读错误和源变化都会关闭句柄并清理任务。
- GUI 在每个文件旁提供下载按钮，显示进度、已接收量、平均速度、状态、错误和取消。

本阶段没有实现断点续传、多文件并发、VIP 限速、公钥认证、TLS/WSS 或 Docker Compose。

## 2. 浏览器有界内存策略

主路径面向 Windows 上最新版 Edge/Chrome：

1. 用户点击下载时调用 File System Access API 选择目标文件。
2. WebSocket 分块先写入 Origin Private File System（OPFS）临时文件，同时增量计算 SHA-256。
3. 仅当大小、整文件 SHA-256 和服务端 COMPLETE 确认全部通过，才从 OPFS 以流方式复制到目标文件。
4. 成功、取消或失败后删除 OPFS 临时文件。

此路径 JavaScript 堆内通常只保留当前 WebSocket 分块及浏览器流内部缓冲，不保存完整大文件。不支持 `showSaveFilePicker`/OPFS 的浏览器使用 Blob 兼容模式，但硬限制为 32 MiB；更大文件会在发起协议请求前拒绝并提示使用 Edge/Chrome。兼容模式会占用接近文件大小的内存。

普通网页没有统一的跨浏览器原子重命名能力。主路径在验证成功前不写目标内容，但最终 OPFS→目标复制若遇到磁盘错误，可能留下空文件或部分目标，界面会明确报错；它不会被协议报告为完整性成功交付。

## 3. 安全和一致性

- INIT、每个 ACK、COMPLETE 和 ABORT 都重新验证 SQLite 会话；客户端不能提供 `userId` 或宿主路径。
- 私人目录解析拒绝绝对路径、反斜杠、`.`/`..`、NUL、Windows 保留名、符号链接和目录联接越界。
- 服务端保存初始 `dev/ino/size/mtime/ctime`；散列前后及发送完成时比较句柄和路径身份，同时比较实际发送 SHA-256。
- 删除、替换、截断或修改源文件会得到 `3013_SOURCE_CHANGED`，不会进入等待成功确认。
- 单连接/用户默认最多一个下载，另有全局上限和单文件大小上限；默认 ACK/COMPLETE 超时 15 秒。
- 合法 DOWNLOAD_ACK 由服务端逐块节奏严格约束，豁免通用控制消息速率；伪造、超前和重复 ACK 仍由任务状态机拒绝，并受每连接消息队列上限保护。

## 4. 测试映射

| 验收项 | 覆盖位置 |
| --- | --- |
| 空文件、小文本、1 MiB 二进制、SHA-256、连接/心跳继续 | `apps/server/src/download.test.ts` |
| 先按上传协议提交再下载，内容逐字节一致 | `download.test.ts` |
| 未认证、Bob 跨用户、`../` 和 Windows 绝对路径 | `download.test.ts` |
| 错误 offset、重复 ACK、任务槽释放 | `download.test.ts` |
| 主动取消、断线、ACK 超时、单用户任务限制 | `download.test.ts` |
| 传输期间源文件修改或删除不返回成功 | `download.test.ts` |
| 100 MiB 有界内存下载、分块/整文件 SHA-256、连接复用 | `apps/server/src/download.slow.test.ts` |
| 共享 100 字节头的下载帧编解码 | `packages/protocol/src/index.test.ts` |
| Phase 1/2.1/2.2 回归 | 全仓 `npm test` |

测试使用真实 WebSocket、内存 SQLite、真实 Argon2id 和 E 盘 `.cache/test-runs` 文件系统目录。慢速测试生成 100 MiB 文件，但测试客户端只增量散列当前块，不保存完整下载内容，结束后清理目录。

## 5. Windows 11 运行

```powershell
cd E:\projects\SecureFileTransfer
npm run dev
```

访问 <http://localhost:5173>，使用数据库中已经初始化的 Alice/Bob 凭据登录。点击文件行的“下载”，Edge/Chrome 会先显示保存位置选择器；选择后观察下载进度、速度、校验和完成状态。修改 `.env.example` 不会修改现有数据库密码。

验证命令：

```powershell
npm run build
npm test
npm run test:slow-download --workspace @sft/server
```

## 6. 实现文件

- `packages/protocol/src/index.ts`、`index.test.ts`：下载消息、错误码、`0x0202` 帧测试。
- `apps/server/src/download.ts`：下载状态机、稳定摘要、顺序发送、ACK 超时和资源清理。
- `apps/server/src/storage.ts`：受控只读文件解析。
- `apps/server/src/server.ts`、`config.ts`：下载协议路由、配置、会话复核和错误映射。
- `apps/server/src/download.test.ts`、`download.slow.test.ts`：快速与 100 MiB 真实集成测试。
- `apps/client/src/App.vue`、`style.css`：分块接收、OPFS/兼容保存和 GUI。
- `.env.example`、README 及协议/架构/需求/阶段文档。

## 7. 尚未实现及下一阶段

- 浏览器 GUI 已通过 Vue/TypeScript 生产构建；真实鼠标选择保存位置、取消按钮和最终文件落盘仍需在 Edge/Chrome 中人工演示确认，未配置浏览器自动化。
- Phase 2.3 不恢复断线任务，也不允许多文件并发；这些属于 Phase 4。
- 当前服务端为了在 READY 中声明可信整文件摘要，会在下载前预读文件一次，实际发送再读一次；两次均内存有界，但增加磁盘 I/O。
- 下一阶段建议进入 Phase 3，优先完成 HTTPS/WSS、证书验证、Origin allowlist、认证/连接限流和 Windows 存储 ACL，然后扩展 TLS 与资源耗尽安全测试。

## 8. 2026-11-11 实际执行结果

| 命令/检查 | 实际结果 |
| --- | --- |
| `npm run build` | 通过：协议、服务端 TypeScript、Vue 类型检查和 Vite 生产构建成功 |
| `npm test` | 通过：协议 5 项、服务端 29 项、客户端严格类型检查；0 失败/跳过 |
| `npm run test:slow-upload --workspace @sft/server` | Phase 2.2 回归通过：100 MiB 上传约 2.0 s |
| `npm run test:slow-download --workspace @sft/server` | 通过：100 MiB 有界内存下载、分块和整文件 SHA-256、连接复用，最终一次约 1.2 s |
| `npm run dev` | 通过：实际启动后 `/health` 返回 `phase: "2.3"`，Vite 首页 HTTP 200；检查后停止，3000/5173 端口释放 |
| `npm audit --omit=dev` | 通过：0 个已知生产依赖漏洞 |

首次 100 MiB 下载测试曾发现通用控制限流会拒绝第 101 个合法 ACK；修复为只豁免由服务端单块严格节奏约束的 `DOWNLOAD_ACK` 和 `HEARTBEAT_PONG` 后重跑通过。Vite 仍提示 Element Plus 主 bundle 超过 500 KiB，Node 22 内置 SQLite 仍显示 experimental warning，均不影响本阶段功能验收。

未执行浏览器自动化或人工鼠标操作，因此没有声称保存位置选择器、GUI 取消按钮、OPFS→目标文件复制已经在真实 Edge 界面验证；这些代码已通过 Vue/TypeScript 生产构建，协议和文件内容行为由真实 WebSocket 集成测试验证。
