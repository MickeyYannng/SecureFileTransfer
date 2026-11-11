<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  ERROR_CODES,
  PROTOCOL_NAME,
  createControlMessage,
  hasStringField,
  parseControlMessage,
  serializeControlMessage,
  type FileListEntry,
  type PublicUser,
  type StorageUsage,
} from "@sft/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type AuthStatus = "unauthenticated" | "authenticating" | "authenticated";

const connectionStatus = ref<ConnectionStatus>("disconnected");
const authStatus = ref<AuthStatus>("unauthenticated");
const connectionId = ref("—");
const lastHeartbeat = ref("—");
const eventLog = ref<string[]>([]);
const authError = ref("");
const currentUser = ref<PublicUser>();
const sessionExpiresAt = ref<number>();
const loginForm = reactive({ username: "", password: "" });
const currentPath = ref("");
const fileEntries = ref<FileListEntry[]>([]);
const storageUsage = ref<StorageUsage>();

let socket: WebSocket | undefined;
let sessionToken: string | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let intentionallyClosed = false;

const wsUrl = computed(() => {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
});

const connectionLabel = computed(() => ({
  connecting: "正在连接",
  connected: "长连接正常",
  disconnected: "已断开",
  error: "连接异常",
}[connectionStatus.value]));

const connectionType = computed(() => connectionStatus.value === "connected" ? "success" : connectionStatus.value === "error" ? "danger" : "warning");
const authLabel = computed(() => ({
  unauthenticated: "未认证",
  authenticating: "正在认证",
  authenticated: "已认证",
}[authStatus.value]));
const authType = computed(() => authStatus.value === "authenticated" ? "success" : authStatus.value === "authenticating" ? "warning" : "info");
const quotaPercent = computed(() => {
  if (!storageUsage.value || storageUsage.value.quotaBytes === 0) return 0;
  return Math.min(100, Math.round(storageUsage.value.usedBytes / storageUsage.value.quotaBytes * 100));
});

function connect(): void {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  intentionallyClosed = false;
  connectionStatus.value = "connecting";
  addLog(`连接 ${wsUrl.value}`);
  socket = new WebSocket(wsUrl.value);

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    send("HELLO", { protocol: PROTOCOL_NAME, clientName: "sft-vue-client" });
    addLog("WebSocket 已建立，发送 HELLO");
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      addLog("忽略 Phase 2.1 未支持的二进制消息");
      return;
    }
    try {
      handleMessage(parseControlMessage(event.data));
    } catch (error) {
      connectionStatus.value = "error";
      addLog(`协议解析失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  });

  socket.addEventListener("close", () => {
    connectionStatus.value = "disconnected";
    authStatus.value = sessionToken ? "authenticating" : "unauthenticated";
    connectionId.value = "—";
    addLog("连接已关闭");
    socket = undefined;
    if (!intentionallyClosed) scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    connectionStatus.value = "error";
    addLog("WebSocket 连接错误");
  });
}

function handleMessage(message: ReturnType<typeof parseControlMessage>): void {
  if (message.type === "HELLO_ACK" && hasStringField(message.payload, "connectionId")) {
    connectionId.value = message.payload.connectionId;
    connectionStatus.value = "connected";
    addLog("应用层协议协商完成");
    if (sessionToken) {
      authStatus.value = "authenticating";
      send("AUTH_TOKEN", { token: sessionToken });
      addLog("重连后重新验证会话令牌");
    } else {
      authStatus.value = "unauthenticated";
    }
    return;
  }
  if (message.type === "HEARTBEAT_PING" && hasStringField(message.payload, "nonce")) {
    send("HEARTBEAT_PONG", { nonce: message.payload.nonce }, message.requestId);
    lastHeartbeat.value = new Date().toLocaleTimeString();
    return;
  }
  if (message.type === "AUTH_SUCCESS") {
    const payload = asRecord(message.payload);
    const user = parsePublicUser(payload.user);
    const expiresAt = readNumber(payload, "expiresAt");
    if (typeof payload.token === "string") sessionToken = payload.token;
    currentUser.value = user;
    sessionExpiresAt.value = expiresAt;
    authStatus.value = "authenticated";
    authError.value = "";
    loginForm.password = "";
    addLog(`用户 ${user.username} 认证成功`);
    send("AUTH_ME", {});
    refreshFiles();
    return;
  }
  if (message.type === "AUTH_ME_RESULT") {
    const payload = asRecord(message.payload);
    currentUser.value = parsePublicUser(payload.user);
    sessionExpiresAt.value = readNumber(payload, "expiresAt");
    return;
  }
  if (message.type === "AUTH_LOGOUT_ACK") {
    clearAuthentication();
    addLog("会话已退出并撤销");
    return;
  }
  if (message.type === "FILE_LIST_RESULT") {
    const payload = asRecord(message.payload);
    currentPath.value = readString(payload, "path");
    fileEntries.value = parseFileEntries(payload.entries);
    storageUsage.value = parseStorageUsage(payload.usage);
    return;
  }
  if (message.type === "ERROR") handleServerError(message.payload);
}

function login(): void {
  if (connectionStatus.value !== "connected") {
    authError.value = "请先等待服务器连接完成";
    return;
  }
  authError.value = "";
  authStatus.value = "authenticating";
  send("AUTH_LOGIN", { username: loginForm.username, password: loginForm.password });
}

function logout(): void {
  if (authStatus.value === "authenticated") send("AUTH_LOGOUT", {});
}

function refreshFiles(): void {
  if (authStatus.value === "authenticated") send("FILE_LIST_REQUEST", { path: currentPath.value });
}

function openDirectory(entry: FileListEntry): void {
  if (entry.type !== "directory") return;
  currentPath.value = currentPath.value ? `${currentPath.value}/${entry.name}` : entry.name;
  refreshFiles();
}

function goUp(): void {
  const parts = currentPath.value.split("/").filter(Boolean);
  parts.pop();
  currentPath.value = parts.join("/");
  refreshFiles();
}

function disconnect(): void {
  intentionallyClosed = true;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  socket?.close(1000, "user disconnected");
}

function scheduleReconnect(): void {
  const baseDelay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  reconnectAttempt += 1;
  addLog(`${(delay / 1000).toFixed(1)} 秒后重连`);
  reconnectTimer = window.setTimeout(connect, delay);
}

function send(
  type: Parameters<typeof createControlMessage>[0],
  payload: Record<string, unknown>,
  requestId: string = crypto.randomUUID(),
): void {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
  socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
}

function handleServerError(value: unknown): void {
  const payload = asRecord(value);
  const code = readString(payload, "code");
  const message = readString(payload, "message");
  authError.value = message;
  addLog(`服务器拒绝请求：${code}`);
  if ([
    ERROR_CODES.authRequired,
    ERROR_CODES.invalidCredentials,
    ERROR_CODES.sessionExpired,
    ERROR_CODES.sessionRevoked,
  ].includes(code as never)) {
    clearAuthentication();
  }
}

function clearAuthentication(): void {
  sessionToken = undefined;
  currentUser.value = undefined;
  sessionExpiresAt.value = undefined;
  authStatus.value = "unauthenticated";
  currentPath.value = "";
  fileEntries.value = [];
  storageUsage.value = undefined;
  loginForm.password = "";
}

function addLog(message: string): void {
  eventLog.value.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
  eventLog.value = eventLog.value.slice(0, 8);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid payload object");
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`invalid ${key}`);
  return field;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new Error(`invalid ${key}`);
  return field;
}

function parsePublicUser(value: unknown): PublicUser {
  const user = asRecord(value);
  return {
    id: readString(user, "id"),
    username: readString(user, "username"),
    displayName: readString(user, "displayName"),
    role: readString(user, "role"),
    quotaBytes: readNumber(user, "quotaBytes"),
    maxFiles: readNumber(user, "maxFiles"),
  };
}

function parseFileEntries(value: unknown): FileListEntry[] {
  if (!Array.isArray(value)) throw new Error("invalid file entries");
  return value.map((item) => {
    const entry = asRecord(item);
    const type = readString(entry, "type");
    if (type !== "file" && type !== "directory") throw new Error("invalid entry type");
    return {
      name: readString(entry, "name"),
      type,
      size: readNumber(entry, "size"),
      modifiedAt: readNumber(entry, "modifiedAt"),
    };
  });
}

function parseStorageUsage(value: unknown): StorageUsage {
  const usage = asRecord(value);
  return {
    usedBytes: readNumber(usage, "usedBytes"),
    fileCount: readNumber(usage, "fileCount"),
    quotaBytes: readNumber(usage, "quotaBytes"),
    maxFiles: readNumber(usage, "maxFiles"),
    maxFileSizeBytes: readNumber(usage, "maxFileSizeBytes"),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

onMounted(connect);
onBeforeUnmount(disconnect);
</script>

<template>
  <main class="page-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">UCAS · 软件与系统安全实验 1B</p>
        <h1>安全文件传输</h1>
      </div>
      <div class="status-stack">
        <el-tag :type="connectionType" effect="dark">{{ connectionLabel }}</el-tag>
        <el-tag :type="authType">{{ authLabel }}</el-tag>
      </div>
    </header>

    <section v-if="authStatus !== 'authenticated'" class="login-layout">
      <div class="login-copy">
        <span class="phase-pill">Phase 2.1</span>
        <h2>先验证身份，再访问私人空间</h2>
        <p>密码通过 WebSocket 自定义协议提交，服务端使用 Argon2id 验证；重连时必须重新验证短期会话令牌。</p>
      </div>
      <el-card class="login-card" shadow="never">
        <template #header><strong>用户登录</strong></template>
        <el-form label-position="top" @submit.prevent="login">
          <el-form-item label="用户名">
            <el-input v-model="loginForm.username" maxlength="128" autocomplete="username" placeholder="Alice 或 Bob" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="loginForm.password" type="password" maxlength="256" show-password autocomplete="current-password" @keyup.enter="login" />
          </el-form-item>
          <el-alert v-if="authError" :title="authError" type="error" :closable="false" show-icon />
          <el-button class="full-button" type="primary" :loading="authStatus === 'authenticating'" :disabled="connectionStatus !== 'connected'" @click="login">登录</el-button>
        </el-form>
      </el-card>
    </section>

    <template v-else>
      <section class="dashboard-grid">
        <el-card class="profile-card" shadow="never">
          <template #header>
            <div class="card-header"><span>当前用户</span><el-button text type="danger" @click="logout">退出</el-button></div>
          </template>
          <div class="identity-row">
            <div class="avatar">{{ currentUser?.displayName.slice(0, 1).toUpperCase() }}</div>
            <div><strong>{{ currentUser?.displayName }}</strong><p>@{{ currentUser?.username }} · {{ currentUser?.role }}</p></div>
          </div>
          <p class="session-expiry">会话有效至：{{ sessionExpiresAt ? new Date(sessionExpiresAt).toLocaleString() : '—' }}</p>
        </el-card>

        <el-card class="storage-card" shadow="never">
          <template #header><strong>私人存储配额</strong></template>
          <el-progress :percentage="quotaPercent" :stroke-width="10" />
          <p v-if="storageUsage" class="quota-copy">
            {{ formatBytes(storageUsage.usedBytes) }} / {{ formatBytes(storageUsage.quotaBytes) }} ·
            {{ storageUsage.fileCount }} / {{ storageUsage.maxFiles }} 个文件
          </p>
        </el-card>
      </section>

      <el-card class="files-card" shadow="never">
        <template #header>
          <div class="card-header">
            <div><strong>我的文件</strong><span class="path-label">/{{ currentPath }}</span></div>
            <div><el-button :disabled="!currentPath" @click="goUp">返回上级</el-button><el-button type="primary" plain @click="refreshFiles">刷新</el-button></div>
          </div>
        </template>
        <el-table :data="fileEntries" empty-text="私人目录为空；上传下载将在 Phase 2.2 实现" @row-dblclick="openDirectory">
          <el-table-column label="名称" min-width="240">
            <template #default="scope"><span :class="{ 'directory-link': scope.row.type === 'directory' }">{{ scope.row.type === 'directory' ? '📁' : '📄' }} {{ scope.row.name }}</span></template>
          </el-table-column>
          <el-table-column prop="type" label="类型" width="110" />
          <el-table-column label="大小" width="140"><template #default="scope">{{ scope.row.type === 'file' ? formatBytes(scope.row.size) : '—' }}</template></el-table-column>
          <el-table-column label="修改时间" width="200"><template #default="scope">{{ new Date(scope.row.modifiedAt).toLocaleString() }}</template></el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-card class="connection-card" shadow="never">
      <template #header><div class="card-header"><strong>连接与协议</strong><span>SFTP-WS / v1</span></div></template>
      <div class="connection-facts">
        <span>连接 ID：{{ connectionId }}</span><span>最近心跳：{{ lastHeartbeat }}</span><span>{{ wsUrl }}</span>
      </div>
      <details><summary>最近协议事件</summary><ul class="event-list"><li v-for="entry in eventLog" :key="entry">{{ entry }}</li></ul></details>
    </el-card>

    <el-alert title="当前仍是本机 ws:// 开发链路；正式 TLS/WSS 将在 Phase 3 完成。" type="warning" :closable="false" show-icon />
  </main>
</template>
