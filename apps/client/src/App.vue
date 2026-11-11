<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  PROTOCOL_NAME,
  createControlMessage,
  hasStringField,
  parseControlMessage,
  serializeControlMessage,
} from "@sft/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

const status = ref<ConnectionStatus>("disconnected");
const connectionId = ref("—");
const lastHeartbeat = ref("—");
const eventLog = ref<string[]>([]);
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let intentionallyClosed = false;

const wsUrl = computed(() => {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
});

const statusLabel = computed(() => ({
  connecting: "正在连接",
  connected: "长连接正常",
  disconnected: "已断开",
  error: "连接异常",
}[status.value]));

const statusType = computed(() => status.value === "connected" ? "success" : status.value === "error" ? "danger" : "warning");

function connect(): void {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  intentionallyClosed = false;
  status.value = "connecting";
  addLog(`连接 ${wsUrl.value}`);
  socket = new WebSocket(wsUrl.value);

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    const requestId = crypto.randomUUID();
    socket?.send(serializeControlMessage(createControlMessage("HELLO", requestId, {
      protocol: PROTOCOL_NAME,
      clientName: "sft-vue-client",
    })));
    addLog("WebSocket 已建立，发送 HELLO");
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      addLog("忽略 Phase 1 未支持的二进制消息");
      return;
    }
    try {
      const message = parseControlMessage(event.data);
      if (message.type === "HELLO_ACK" && hasStringField(message.payload, "connectionId")) {
        connectionId.value = message.payload.connectionId;
        status.value = "connected";
        addLog("应用层协议协商完成");
      } else if (message.type === "HEARTBEAT_PING" && hasStringField(message.payload, "nonce")) {
        socket?.send(serializeControlMessage(createControlMessage("HEARTBEAT_PONG", message.requestId, {
          nonce: message.payload.nonce,
        })));
        lastHeartbeat.value = new Date().toLocaleTimeString();
        addLog("收到 HEARTBEAT_PING，已回复 PONG");
      } else if (message.type === "ERROR") {
        status.value = "error";
        addLog(`服务器返回错误：${event.data}`);
      }
    } catch (error) {
      status.value = "error";
      addLog(`协议解析失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  });

  socket.addEventListener("close", () => {
    status.value = "disconnected";
    connectionId.value = "—";
    addLog("连接已关闭");
    socket = undefined;
    if (!intentionallyClosed) scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    status.value = "error";
    addLog("WebSocket 连接错误");
  });
}

function disconnect(): void {
  intentionallyClosed = true;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  socket?.close(1000, "user disconnected");
}

function scheduleReconnect(): void {
  const delay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
  reconnectAttempt += 1;
  addLog(`${delay / 1000} 秒后重连`);
  reconnectTimer = window.setTimeout(connect, delay);
}

function addLog(message: string): void {
  eventLog.value.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
  eventLog.value = eventLog.value.slice(0, 8);
}

onMounted(connect);
onBeforeUnmount(disconnect);
</script>

<template>
  <main class="page-shell">
    <section class="hero">
      <p class="eyebrow">UCAS · 软件与系统安全实验 1B</p>
      <h1>安全文件传输系统</h1>
      <p class="subtitle">Phase 1 验证台：自定义协议协商、长连接与应用层心跳</p>
    </section>

    <el-card class="status-card" shadow="never">
      <template #header>
        <div class="card-header">
          <span>连接状态</span>
          <el-tag :type="statusType" effect="dark">{{ statusLabel }}</el-tag>
        </div>
      </template>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="WebSocket 地址">{{ wsUrl }}</el-descriptions-item>
        <el-descriptions-item label="协议">SFTP-WS / v1</el-descriptions-item>
        <el-descriptions-item label="连接 ID">{{ connectionId }}</el-descriptions-item>
        <el-descriptions-item label="最近心跳">{{ lastHeartbeat }}</el-descriptions-item>
      </el-descriptions>
      <div class="actions">
        <el-button type="primary" :disabled="status === 'connected' || status === 'connecting'" @click="connect">连接</el-button>
        <el-button :disabled="status === 'disconnected'" @click="disconnect">断开</el-button>
      </div>
    </el-card>

    <el-card class="log-card" shadow="never">
      <template #header>协议事件</template>
      <el-empty v-if="eventLog.length === 0" description="暂无事件" />
      <ul v-else class="event-list">
        <li v-for="entry in eventLog" :key="entry">{{ entry }}</li>
      </ul>
    </el-card>

    <el-alert
      title="Phase 1 仅用于本机明文连接验证；TLS、认证和文件传输将在后续阶段实现。"
      type="warning"
      :closable="false"
      show-icon
    />
  </main>
</template>

