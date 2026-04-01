#!/usr/bin/env bun
/**
 * Claude Team Chat — channel plugin.
 * Connects a Claude Code instance to a shared team chat server.
 */
process.stderr.write(`[team-chat] Starting channel plugin...\n`);

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// Load config from ~/.claude/channels/team-chat/.env
const CONFIG_DIR = join(homedir(), ".claude", "channels", "team-chat");
mkdirSync(CONFIG_DIR, { recursive: true });
try {
  const envFile = readFileSync(join(CONFIG_DIR, ".env"), "utf8");
  for (const line of envFile.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length > 0 && !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join("=").trim();
    }
  }
} catch {}

const TEAM_CHAT_URL = process.env.TEAM_CHAT_URL;
const TEAM_CHAT_TOKEN = process.env.TEAM_CHAT_TOKEN;
const MEMBER_NAME = process.env.MEMBER_NAME || "Claude";
const OWNER_NAME = process.env.OWNER_NAME || "";
const DISPLAY_NAME = OWNER_NAME ? `${MEMBER_NAME} [${OWNER_NAME}]` : MEMBER_NAME;

if (!TEAM_CHAT_URL || !TEAM_CHAT_TOKEN) {
  process.stderr.write(
    `[team-chat] ERROR: Missing TEAM_CHAT_URL or TEAM_CHAT_TOKEN.\n` +
    `Configure in ${CONFIG_DIR}/.env\n`
  );
}

let lastSeenId = 0;

// --- API helpers ---

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${TEAM_CHAT_URL}${path}`, {
    headers: { Authorization: `Bearer ${TEAM_CHAT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${TEAM_CHAT_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEAM_CHAT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

// --- MCP Server ---

const mcp = new Server(
  { name: "team-chat", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions:
      `Messages from the team chat arrive as <channel source="team-chat" sender="..." message_id="...">. ` +
      `These are messages from other Claude Code instances belonging to your teammates. ` +
      `Use the reply tool to send messages to the team chat. Be collaborative and constructive. ` +
      `Only reply when you have something valuable to add — don't respond to every message.`,
  }
);

// Tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message to the team chat",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The message to send" },
          replyTo: {
            type: "number",
            description: "Message ID to reply to (optional)",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "check_team_chat",
      description: "Fetch recent messages from the team chat",
      inputSchema: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Number of messages to fetch (default: 20, max: 50)",
          },
        },
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text, replyTo } = req.params.arguments as {
      text: string;
      replyTo?: number;
    };

    try {
      const msg = await apiPost("/messages", { content: text, replyTo });
      process.stderr.write(`[team-chat] Sent message #${msg.id}: ${text.slice(0, 60)}...\n`);
      return { content: [{ type: "text", text: `Message sent (id: ${msg.id})` }] };
    } catch (err) {
      process.stderr.write(`[team-chat] Send error: ${err}\n`);
      return { content: [{ type: "text", text: `Failed to send: ${err}` }] };
    }
  }

  if (req.params.name === "check_team_chat") {
    const { count } = (req.params.arguments || {}) as { count?: number };
    const limit = Math.min(count || 20, 50);

    try {
      const data = await apiGet(`/messages?since=0&limit=${limit}`);
      if (!data.messages?.length) {
        return { content: [{ type: "text", text: "No messages in the team chat yet." }] };
      }

      const formatted = data.messages
        .map(
          (m: any) => {
            const sender = m.ownerName ? `${m.memberName} [${m.ownerName}]` : m.memberName;
            return `[#${m.id}] ${sender} (${new Date(m.createdAt).toLocaleString()}):` +
              `${m.replyTo ? ` (replying to #${m.replyTo})` : ""}\n${m.content}`;
          }
        )
        .join("\n\n");

      return { content: [{ type: "text", text: formatted }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to fetch messages: ${err}` }] };
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// --- Connect MCP ---

process.stderr.write(`[team-chat] Connecting MCP via stdio...\n`);
try {
  await mcp.connect(new StdioServerTransport());
  process.stderr.write(`[team-chat] MCP connected successfully\n`);
} catch (err) {
  process.stderr.write(`[team-chat] MCP connect FAILED: ${err}\n`);
}

// --- Push a message to Claude's session ---

async function pushToChannel(msg: {
  id: number;
  memberName: string;
  ownerName?: string;
  memberId: string;
  content: string;
  replyTo?: number | null;
  createdAt: string;
}) {
  try {
    const sender = msg.ownerName ? `${msg.memberName} [${msg.ownerName}]` : msg.memberName;
    const replyInfo = msg.replyTo ? ` (replying to #${msg.replyTo})` : "";
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `${sender}${replyInfo}: ${msg.content}`,
        meta: {
          chat_id: "team_chat",
          message_id: String(msg.id),
          sender: msg.memberName,
          sender_id: msg.memberId,
          ts: msg.createdAt,
          ...(msg.replyTo ? { reply_to: String(msg.replyTo) } : {}),
        },
      },
    });
  } catch (err) {
    process.stderr.write(`[team-chat] Channel notification error: ${err}\n`);
  }
}

// --- Catch up on missed messages ---

async function catchUp() {
  if (!TEAM_CHAT_URL || !TEAM_CHAT_TOKEN) return;

  try {
    const data = await apiGet(`/messages?since=${lastSeenId}&limit=20`);
    if (data.messages?.length) {
      process.stderr.write(`[team-chat] Catching up: ${data.messages.length} new message(s)\n`);
      for (const msg of data.messages) {
        await pushToChannel(msg);
        if (msg.id > lastSeenId) lastSeenId = msg.id;
      }
    } else {
      process.stderr.write(`[team-chat] No new messages to catch up on\n`);
    }
  } catch (err) {
    process.stderr.write(`[team-chat] Catch-up error: ${err}\n`);
  }
}

// --- SSE listener ---

async function connectSSE() {
  if (!TEAM_CHAT_URL || !TEAM_CHAT_TOKEN) return;

  const url = `${TEAM_CHAT_URL}/stream?token=${TEAM_CHAT_TOKEN}`;
  process.stderr.write(`[team-chat] Connecting SSE to ${TEAM_CHAT_URL}/stream...\n`);

  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      process.stderr.write(`[team-chat] SSE connection failed: ${res.status}\n`);
      scheduleReconnect();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6).trim();
        } else if (line === "" && eventData) {
          // End of event
          if (eventType === "message" && eventData) {
            try {
              const msg = JSON.parse(eventData);
              process.stderr.write(
                `[team-chat] Received: ${msg.memberName}: ${(msg.content || "").slice(0, 60)}\n`
              );
              await pushToChannel(msg);
              if (msg.id > lastSeenId) lastSeenId = msg.id;
            } catch (err) {
              process.stderr.write(`[team-chat] SSE parse error: ${err}\n`);
            }
          }
          eventType = "";
          eventData = "";
        }
      }
    }

    // Stream ended — reconnect
    process.stderr.write(`[team-chat] SSE stream ended, reconnecting...\n`);
    scheduleReconnect();
  } catch (err) {
    process.stderr.write(`[team-chat] SSE error: ${err}\n`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  setTimeout(async () => {
    await catchUp();
    connectSSE();
  }, 5_000);
}

// --- Start ---

await catchUp();
connectSSE();

process.stderr.write(`[team-chat] Channel plugin running (${MEMBER_NAME})\n`);
