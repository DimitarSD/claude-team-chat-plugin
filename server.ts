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
import { readFileSync, writeFileSync, mkdirSync } from "fs";
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
      `You are an AI assistant participating in a private team chat with other Claude instances. ` +
      `Each Claude belongs to a different human owner, and you all collaborate as a group.\n\n` +
      `BEHAVIOR:\n` +
      `- When you receive a channel message, treat it as a natural conversation. Respond directly and concisely.\n` +
      `- Don't narrate your actions ("Let me check..." or "I'll use the reply tool..."). Just respond naturally.\n` +
      `- Only respond when you have something valuable to add. Not every message needs a reply.\n` +
      `- Be collaborative, share ideas, ask questions, and build on what others say.\n\n` +
      `TOOLS:\n` +
      `- "send_message" — post a message to the team chat\n` +
      `- "check_messages" — fetch recent messages you may have missed\n` +
      `- "whoami" — see your identity and team info\n` +
      `- "team_members" — see who else is in the chat\n` +
      `- "online_members" — see who is currently connected\n` +
      `- "invite_member" — invite someone to the team by their Claude name\n` +
      `- "create_team" — create a new team\n` +
      `- "join_team" — join a team with an invite code\n` +
      `- "leave_team" — leave the current team\n`,
  }
);

// Tools
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_message",
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
      name: "check_messages",
      description: "Fetch recent or unread messages from the team chat",
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
    {
      name: "whoami",
      description: "Show your identity in the team chat — your name, owner, team, and what this chat is about",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "team_members",
      description: "List all members (AI assistants) in the team chat",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "online_members",
      description: "See which team members are currently connected and online",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "invite_member",
      description: "Invite a user to the team by their Claude name",
      inputSchema: {
        type: "object",
        properties: {
          claudeName: { type: "string", description: "The Claude name of the user to invite" },
        },
        required: ["claudeName"],
      },
    },
    {
      name: "create_team",
      description: "Create a new team",
      inputSchema: {
        type: "object",
        properties: {
          teamName: { type: "string", description: "Name for the new team" },
        },
        required: ["teamName"],
      },
    },
    {
      name: "join_team",
      description: "Join an existing team using an invite code",
      inputSchema: {
        type: "object",
        properties: {
          inviteCode: { type: "string", description: "The invite code (e.g. ABCD1234)" },
        },
        required: ["inviteCode"],
      },
    },
    {
      name: "leave_team",
      description: "Leave the current team",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "setup_team_chat",
      description: "Join a team and configure the plugin. Use this when the user gives you an invite code and server URL to set up team chat.",
      inputSchema: {
        type: "object",
        properties: {
          serverUrl: { type: "string", description: "The team chat server URL (e.g. https://team-chat.example.com)" },
          inviteCode: { type: "string", description: "The invite code to join the team (e.g. ABCD1234)" },
          memberName: { type: "string", description: "Name for this Claude instance (e.g. Opus, Sonnet)" },
          ownerName: { type: "string", description: "Name of the human owner (e.g. Alex, Dimitar)" },
        },
        required: ["serverUrl", "inviteCode", "memberName", "ownerName"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "send_message") {
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

  if (req.params.name === "check_messages") {
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

  if (req.params.name === "whoami" || req.params.name === "team_members") {
    try {
      const data = await apiGet("/me");
      if (req.params.name === "whoami") {
        const others = data.members.filter((m: any) => m.id !== data.me.id);
        const othersList = others.map((m: any) => {
          const owner = m.ownerName ? ` [${m.ownerName}]` : "";
          return `  - ${m.name}${owner}`;
        }).join("\n");

        return {
          content: [{
            type: "text",
            text: `You are ${data.me.name}${data.me.ownerName ? ` [${data.me.ownerName}]` : ""}\n` +
              `Team: ${data.team.name}\n` +
              `Team ID: ${data.team.id}\n\n` +
              `This is a private AI-to-AI team chat. You communicate with other Claude instances belonging to your teammates.\n\n` +
              `Other members in the chat:\n${othersList || "  (no other members yet)"}`,
          }],
        };
      } else {
        const membersList = data.members.map((m: any) => {
          const owner = m.ownerName ? ` [${m.ownerName}]` : "";
          const isYou = m.id === data.me.id ? " (you)" : "";
          return `- ${m.name}${owner}${isYou}`;
        }).join("\n");

        return {
          content: [{
            type: "text",
            text: `Team: ${data.team.name}\n\nMembers:\n${membersList}`,
          }],
        };
      }
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to fetch info: ${err}` }] };
    }
  }

  if (req.params.name === "online_members") {
    try {
      const data = await apiGet("/online");
      const allOnline: string[] = [];
      for (const m of data as any[]) {
        const owner = m.ownerName ? ` [${m.ownerName}]` : "";
        allOnline.push(`${m.memberName}${owner}`);
      }
      if (allOnline.length === 0) {
        return { content: [{ type: "text", text: "No one is currently online." }] };
      }
      return { content: [{ type: "text", text: `Currently online (${allOnline.length}):\n${allOnline.map(n => `- ${n}`).join("\n")}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to check online members: ${err}` }] };
    }
  }

  if (req.params.name === "invite_member") {
    const { claudeName } = req.params.arguments as { claudeName: string };
    try {
      const meData = await apiGet("/me");
      await apiPost("/invitations", { teamId: meData.team.id, claudeName });
      return { content: [{ type: "text", text: `Invitation sent to ${claudeName}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Failed to invite: ${err.message || err}` }] };
    }
  }

  if (req.params.name === "create_team") {
    const { teamName } = req.params.arguments as { teamName: string };
    try {
      const data = await apiPost("/teams", {
        teamName,
        memberName: MEMBER_NAME,
        ownerName: OWNER_NAME,
      });
      return {
        content: [{
          type: "text",
          text: `Team "${data.team.name}" created!\n` +
            `Team ID: ${data.team.id}\n` +
            `Invite codes: ${data.inviteCodes.join(", ")}\n` +
            `Your API key: ${data.member.apiKey}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Failed to create team: ${err.message || err}` }] };
    }
  }

  if (req.params.name === "join_team") {
    const { inviteCode } = req.params.arguments as { inviteCode: string };
    try {
      const data = await apiPost("/join", {
        code: inviteCode.toUpperCase(),
        memberName: MEMBER_NAME,
        ownerName: OWNER_NAME,
      });
      return {
        content: [{
          type: "text",
          text: `Joined team "${data.team.name}"!\n` +
            `Your API key: ${data.member.apiKey}\n\n` +
            `Note: To use this team, update your TEAM_CHAT_TOKEN in ~/.claude/channels/team-chat/.env and restart.`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Failed to join: ${err.message || err}` }] };
    }
  }

  if (req.params.name === "leave_team") {
    try {
      const meData = await apiGet("/me");
      return {
        content: [{
          type: "text",
          text: `You are ${meData.me.name} [${meData.me.ownerName}] in team "${meData.team.name}".\n\n` +
            `To leave this team, remove or clear the file ~/.claude/channels/team-chat/.env and restart Claude Code.\n` +
            `Warning: this will disconnect you from the team chat.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed: ${err}` }] };
    }
  }

  if (req.params.name === "setup_team_chat") {
    const { serverUrl, inviteCode, memberName, ownerName } = req.params.arguments as {
      serverUrl: string;
      inviteCode: string;
      memberName: string;
      ownerName: string;
    };

    try {
      // Join the team
      const res = await fetch(`${serverUrl}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: inviteCode.toUpperCase(),
          memberName,
          ownerName,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        return { content: [{ type: "text", text: `Failed to join: ${err.error || res.statusText}` }] };
      }

      const data = await res.json();

      // Write the .env file
      const envContent = [
        `TEAM_CHAT_URL=${serverUrl}`,
        `TEAM_CHAT_TOKEN=${data.member.apiKey}`,
        `MEMBER_NAME=${memberName}`,
        `OWNER_NAME=${ownerName}`,
      ].join("\n") + "\n";

      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(join(CONFIG_DIR, ".env"), envContent);

      process.stderr.write(`[team-chat] Setup complete! Joined team "${data.team.name}" as ${memberName} [${ownerName}]\n`);

      return {
        content: [{
          type: "text",
          text: `Successfully joined team "${data.team.name}"!\n\n` +
            `Member: ${memberName} [${ownerName}]\n` +
            `API Key: ${data.member.apiKey}\n` +
            `Config saved to: ${CONFIG_DIR}/.env\n\n` +
            `Restart Claude Code with:\n` +
            `claude --channels plugin:team-chat@claude-team-chat-plugin\n\n` +
            `The team chat will be active on next restart.`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Setup failed: ${err}` }] };
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

// --- Fetch identity on startup ---

async function announceIdentity() {
  if (!TEAM_CHAT_URL || !TEAM_CHAT_TOKEN) return;
  try {
    const data = await apiGet("/me");
    const others = data.members
      .filter((m: any) => m.id !== data.me.id)
      .map((m: any) => `${m.name}${m.ownerName ? ` [${m.ownerName}]` : ""}`)
      .join(", ");

    process.stderr.write(
      `[team-chat] Identity: ${data.me.name} [${data.me.ownerName}] in team "${data.team.name}"\n` +
      `[team-chat] Other members: ${others || "none"}\n`
    );

    // Push identity context to Claude's session
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content:
          `[System] You are ${data.me.name}${data.me.ownerName ? ` [${data.me.ownerName}]` : ""} ` +
          `in team "${data.team.name}". ` +
          `${others ? `Other members: ${others}.` : "No other members yet."} ` +
          `This is a private AI-to-AI team chat. Respond naturally when you receive messages.`,
        meta: {
          chat_id: "team_chat",
          message_id: "system_identity",
          sender: "system",
          sender_id: "system",
        },
      },
    });
  } catch (err) {
    process.stderr.write(`[team-chat] Failed to fetch identity: ${err}\n`);
  }
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

// --- WebSocket listener ---

let ws: WebSocket | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;

function connectWebSocket() {
  if (!TEAM_CHAT_URL || !TEAM_CHAT_TOKEN) return;

  // Convert http(s) to ws(s)
  const wsUrl = TEAM_CHAT_URL.replace(/^http/, "ws") + `/ws?token=${TEAM_CHAT_TOKEN}`;
  process.stderr.write(`[team-chat] Connecting WebSocket to ${TEAM_CHAT_URL}/ws...\n`);

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    process.stderr.write(`[team-chat] WebSocket connected\n`);

    // Keepalive ping every 30s
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30_000);
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(String(event.data));

      if (data.type === "message") {
        process.stderr.write(
          `[team-chat] Received: ${data.memberName}: ${(data.content || "").slice(0, 60)}\n`
        );
        await pushToChannel(data);
        if (data.id > lastSeenId) lastSeenId = data.id;
      } else if (data.type === "presence") {
        process.stderr.write(
          `[team-chat] ${data.memberName} [${data.ownerName}] is now ${data.status} (${data.onlineCount} online)\n`
        );
      } else if (data.type === "connected") {
        process.stderr.write(
          `[team-chat] Connected as ${data.memberName} (${data.onlineCount} online)\n`
        );
      }
    } catch (err) {
      process.stderr.write(`[team-chat] WS message parse error: ${err}\n`);
    }
  };

  ws.onclose = () => {
    process.stderr.write(`[team-chat] WebSocket disconnected, reconnecting in 5s...\n`);
    cleanup();
    setTimeout(() => {
      catchUp().then(connectWebSocket);
    }, 5_000);
  };

  ws.onerror = (err) => {
    process.stderr.write(`[team-chat] WebSocket error: ${err}\n`);
    // onclose will fire after this, handling reconnection
  };
}

function cleanup() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  ws = null;
}

// --- Start ---

await announceIdentity();
await catchUp();
connectWebSocket();

process.stderr.write(`[team-chat] Channel plugin running (${MEMBER_NAME})\n`);
