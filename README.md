# SecureFileTransfer：安全文件传输系统

本项目是中国科学院大学《软件与系统安全》实验 1B。系统以 HTTPS/WSS 为安全传输通道，在 WebSocket 之上实现自主设计的 `SFTP-WS v1` 应用层协议，支持认证、心跳、用户目录隔离、分块上传下载、SHA-256 完整性校验、多用户和多文件并发。

## 技术架构

- 客户端：Vue 3、TypeScript、Vite、Element Plus。
- 服务端：Node.js、TypeScript、Express、`ws`、SQLite。
- 安全：TLS、Argon2id、Ed25519 挑战签名、参数化 SQL、Origin 白名单、请求与资源限额。
- 文件协议：100 字节固定二进制头，默认 256 KiB 分块，逐块 ACK，不通过断开连接表示传输完成。

## 已实现功能

必做功能全部覆盖：HTTPS/WSS 长连接和心跳、多用户并发、密码认证与会话撤销、访问控制、私人目录隔离、流式上传下载、SHA-256、GUI、限流、输入与路径检查、SQL 注入/目录穿越/资源耗尽基础防护。

四项加分功能全部覆盖：

1. 上传和下载断点续传，GUI 支持暂停、继续和取消。
2. Ed25519 公钥挑战认证，私钥只保存在用户本机。
3. 最多 3 个文件并发上传或下载，每个任务独立显示进度、速度和状态。
4. 服务端身份限速：普通用户默认 1 MiB/s，VIP 默认 5 MiB/s。

## Windows 11 安装与启动

需要 Node.js 22 或更高版本。项目依赖和运行数据均位于 E 盘项目目录。

```powershell
Copy-Item .env.example .env
npm install
npm run cert:generate
powershell -ExecutionPolicy Bypass -File scripts\trust-dev-ca.ps1
powershell -ExecutionPolicy Bypass -File scripts\configure-storage-acl.ps1
```

在 `.env` 中填写本地测试密码：

```dotenv
SFT_SEED_ALICE_PASSWORD=请设置Alice密码
SFT_SEED_BOB_PASSWORD=请设置Bob密码
```

初始化数据库并启动：

```powershell
npm run db:seed --workspace @sft/server
npm run dev
```

浏览器打开 <https://127.0.0.1:5173>。`Alice` 是普通用户，`Bob` 是 VIP 用户。每次显式执行 `db:seed` 都会按 `.env` 刷新这两个本地演示账号的密码和等级；只修改 `.env.example` 不会生效。

## 三项高级功能的使用

### 断点续传

选择较大文件开始上传或下载，在任务列表点击“暂停”，再点击“继续”。上传恢复时客户端携带原 `transferId`，服务端返回已经持久化的 `nextOffset`；下载恢复时客户端携带已经确认并写入临时文件的 offset。完成后仍执行整文件 SHA-256 校验。

上传暂停记录默认保留 10 分钟，可通过 `SFT_UPLOAD_RESUME_TTL_MS` 调整。当前续传适合演示“暂停、重连、继续”：上传暂停状态保存在服务器进程内，服务端重启后不可恢复；未主动暂停的异常断线会清理临时文件。下载暂停状态保存在当前浏览器页面内，刷新页面后不可恢复。Edge/Chrome 使用 OPFS 和 File System Access API 流式保存下载；其他浏览器使用最多 32 MiB 的内存兼容模式。

### Ed25519 公钥登录

1. 先使用密码登录。
2. 点击“生成并注册 Ed25519 密钥”。浏览器下载私钥 JSON，并只向服务器发送公钥。
3. 退出后输入用户名，选择该私钥 JSON，点击“公钥登录”。
4. 服务端生成 60 秒有效的一次性挑战，验证签名后签发普通会话 Token。

私钥文件和 `certs/`、`.env`、数据库均已加入 Git 忽略规则，不要手工提交。

### VIP 限速

默认配置：

```dotenv
SFT_NORMAL_BANDWIDTH_BPS=1048576
SFT_VIP_BANDWIDTH_BPS=5242880
```

限速在服务端上传写入和下载发送前执行，同一用户的并发任务共享额度。GUI 当前用户卡片显示普通/VIP 身份，任务列表显示实时速度。

## Docker 演示部署

先按上文生成证书并填写 `.env` 的测试密码。Docker Desktop 启动后执行：

```powershell
docker compose build
docker compose run --rm sft npm run db:seed --workspace @sft/server
docker compose up -d
```

访问 <https://127.0.0.1:3443>。容器内由同一个 Node 服务提供前端静态页面、HTTPS 和 WSS；`data/`、`storage/` 挂载到 E 盘项目目录，`certs/` 只读挂载。Docker 版本和 Windows 原生 `npm run dev` 可以分别运行；不要同时占用同一套数据库执行初始化。停止：`docker compose down`（不会删除挂载的数据）。

## 构建与测试

```powershell
npm run build
npm test

# 可选的 100 MiB 慢速完整性测试
npm run test:slow-upload --workspace @sft/server
npm run test:slow-download --workspace @sft/server
```

自动化测试覆盖协议头、认证、会话、目录隔离、上传下载、续传、公钥正确/错误签名、普通/VIP 速度差异、WSS 证书与 Origin、多用户及三文件并发。

## 建议课程演示顺序

1. 展示 HTTPS 证书和 WSS 连接、心跳状态。
2. Alice、Bob 分别登录，展示私人目录互不可见。
3. 批量上传 3 个文件，再并发下载并核对 SHA-256。
4. 传输大文件时暂停并继续，展示 offset 与最终完整性。
5. Alice 生成密钥、退出后使用 Ed25519 私钥登录，并用错误私钥演示拒绝。
6. Alice 与 Bob 传输相同大文件，对比普通用户和 VIP 速度。
7. 演示路径穿越、错误密码限流或非法 Origin 被拒绝。

协议头、状态机和时序图见 [协议说明](docs/protocol-draft.md)，系统边界见 [架构说明](docs/architecture.md)，PPT 要求覆盖见 [需求清单](docs/requirements.md)。
