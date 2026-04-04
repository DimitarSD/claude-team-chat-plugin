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

// Load config — check local .team-chat.env first, then global
const CONFIG_DIR = join(homedir(), ".claude", "channels", "team-chat");
mkdirSync(CONFIG_DIR, { recursive: true });

function loadEnvFile(path: string): boolean {
  try {
    const envFile = readFileSync(path, "utf8");
    for (const line of envFile.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...rest] = trimmed.split("=");
      if (key && rest.length > 0) {
        process.env[key.trim()] = rest.join("=").trim();
      }
    }
    process.stderr.write(`[team-chat] Config loaded from ${path}\n`);
    return true;
  } catch {
    return false;
  }
}

// Priority: local .team-chat.env > local team-chat.env (no dot) > global config
const localEnvDot = join(process.cwd(), ".team-chat.env");
const localEnvNoDot = join(process.cwd(), "team-chat.env");
if (!loadEnvFile(localEnvDot)) {
  if (!loadEnvFile(localEnvNoDot)) {
    loadEnvFile(join(CONFIG_DIR, ".env"));
  }
}

const TEAM_CHAT_URL = process.env.TEAM_CHAT_URL;
const TEAM_CHAT_TOKEN = process.env.TEAM_CHAT_TOKEN; // User token (ut_...)
const MEMBER_NAME = process.env.MEMBER_NAME || "Claude";
const OWNER_NAME = process.env.OWNER_NAME || "";

if (!TEAM_CHAT_URL || !TEAM_CHAT_TOKEN) {
  process.stderr.write(
    `[team-chat] ERROR: Missing TEAM_CHAT_URL or TEAM_CHAT_TOKEN.\n` +
    `Configure in ${CONFIG_DIR}/.env or .team-chat.env\n`
  );
}

let lastSeenId = 0;
let activeTeamId: string | null = null;
let activeChannelId: string | null = null;
let activeTeamName: string | null = null;

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
      `AVAILABLE TOOLS: send_message, check_messages, search_messages, whoami, team_members, online_members, ` +
      `get_topic, set_topic, set_status, get_team_status, pin_message, unpin_message, get_pinned, react_to_message, ` +
      `share_code, request_review, create_task, list_tasks, update_task, message_stats, chat_history, ` +
      `invite_member, create_team, join_team, leave_team, rename_team, generate_invite_code, ` +
      `pending_invitations, accept_invitation, decline_invitation, my_teams, update_profile, ` +
      `register_user, login, setup_team_chat\n`,
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
    // --- Chat features ---
    {
      name: "search_messages",
      description: "Search chat history by keyword",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Search keyword" } }, required: ["query"] },
    },
    {
      name: "pin_message",
      description: "Pin an important message for the team",
      inputSchema: { type: "object", properties: { messageId: { type: "number", description: "ID of message to pin" } }, required: ["messageId"] },
    },
    {
      name: "unpin_message",
      description: "Unpin a message",
      inputSchema: { type: "object", properties: { messageId: { type: "number", description: "ID of message to unpin" } }, required: ["messageId"] },
    },
    {
      name: "get_pinned",
      description: "Get all pinned messages",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "react_to_message",
      description: "React to a message with an emoji",
      inputSchema: { type: "object", properties: { messageId: { type: "number" }, emoji: { type: "string", description: "Emoji reaction" } }, required: ["messageId", "emoji"] },
    },
    // --- Collaboration ---
    {
      name: "share_code",
      description: "Share a code snippet with the team",
      inputSchema: { type: "object", properties: { code: { type: "string" }, language: { type: "string" }, description: { type: "string" } }, required: ["code"] },
    },
    {
      name: "request_review",
      description: "Ask the team to review something",
      inputSchema: { type: "object", properties: { description: { type: "string", description: "What needs review" } }, required: ["description"] },
    },
    {
      name: "create_task",
      description: "Create a shared task for the team",
      inputSchema: { type: "object", properties: { title: { type: "string" }, assignTo: { type: "string", description: "Claude name to assign to (optional)" } }, required: ["title"] },
    },
    {
      name: "list_tasks",
      description: "List all team tasks",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "update_task",
      description: "Update a task status",
      inputSchema: { type: "object", properties: { taskId: { type: "string" }, status: { type: "string", description: "todo, in_progress, or done" } }, required: ["taskId", "status"] },
    },
    // --- Context ---
    {
      name: "set_status",
      description: "Set your current status (what you're working on)",
      inputSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
    },
    {
      name: "get_team_status",
      description: "See what everyone on the team is working on",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "set_topic",
      description: "Set the current discussion topic",
      inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    },
    {
      name: "get_topic",
      description: "Get the current discussion topic",
      inputSchema: { type: "object", properties: {} },
    },
    // --- Meta ---
    {
      name: "message_stats",
      description: "See message counts per team member",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "chat_history",
      description: "Export the full chat history",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "rename_team",
      description: "Rename the team (owner only)",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "generate_invite_code",
      description: "Generate a new invite code for the team",
      inputSchema: { type: "object", properties: {} },
    },
    // --- Account & Onboarding ---
    {
      name: "update_profile",
      description: "Update your Claude name or owner name",
      inputSchema: { type: "object", properties: { claudeName: { type: "string" }, ownerName: { type: "string" } } },
    },
    {
      name: "my_teams",
      description: "List all teams you belong to",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "pending_invitations",
      description: "Check for pending team invitations",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "accept_invitation",
      description: "Accept a pending team invitation",
      inputSchema: { type: "object", properties: { invitationId: { type: "string" } }, required: ["invitationId"] },
    },
    {
      name: "decline_invitation",
      description: "Decline a pending team invitation",
      inputSchema: { type: "object", properties: { invitationId: { type: "string" } }, required: ["invitationId"] },
    },
    {
      name: "register_user",
      description: "Register a new account on the team chat server",
      inputSchema: { type: "object", properties: { serverUrl: { type: "string" }, email: { type: "string" }, claudeName: { type: "string" }, ownerName: { type: "string" }, password: { type: "string" }, siteInviteCode: { type: "string" } }, required: ["serverUrl", "email", "claudeName", "ownerName", "password", "siteInviteCode"] },
    },
    {
      name: "login",
      description: "Login to an existing account",
      inputSchema: { type: "object", properties: { serverUrl: { type: "string" }, email: { type: "string" }, password: { type: "string" } }, required: ["serverUrl", "email", "password"] },
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
      if (!activeChannelId || !activeTeamId) {
        return { content: [{ type: "text", text: "Not connected to any team. Use whoami or check your config." }] };
      }
      const msg = await apiPost("/messages", { channelId: activeChannelId, teamId: activeTeamId, content: text, replyTo });
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
      if (!activeChannelId) return { content: [{ type: "text", text: "Not connected to any channel." }] };
      const data = await apiGet(`/messages?channelId=${activeChannelId}&since=0&limit=${limit}`);
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

  // --- Chat features ---
  if (req.params.name === "search_messages") {
    const { query } = req.params.arguments as { query: string };
    try {
      const data = await apiGet(`/search?q=${encodeURIComponent(query)}`);
      if (!data.length) return { content: [{ type: "text", text: "No messages found." }] };
      const formatted = data.map((m: any) => `[#${m.id}] ${m.memberName}: ${m.content}`).join("\n\n");
      return { content: [{ type: "text", text: `Found ${data.length} messages:\n\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Search failed: ${err}` }] }; }
  }

  if (req.params.name === "pin_message") {
    const { messageId } = req.params.arguments as { messageId: number };
    try { await apiPost("/pins", { messageId }); return { content: [{ type: "text", text: `Message #${messageId} pinned` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "unpin_message") {
    const { messageId } = req.params.arguments as { messageId: number };
    try {
      await fetch(`${TEAM_CHAT_URL}/pins`, { method: "DELETE", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEAM_CHAT_TOKEN}` }, body: JSON.stringify({ messageId }) });
      return { content: [{ type: "text", text: `Message #${messageId} unpinned` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "get_pinned") {
    try {
      const data = await apiGet("/pins");
      if (!data.length) return { content: [{ type: "text", text: "No pinned messages." }] };
      const formatted = data.map((p: any) => `[#${p.message.id}] ${p.message.memberName}: ${p.message.content}`).join("\n\n");
      return { content: [{ type: "text", text: `Pinned messages:\n\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "react_to_message") {
    const { messageId, emoji } = req.params.arguments as { messageId: number; emoji: string };
    try { await apiPost("/reactions", { messageId, emoji }); return { content: [{ type: "text", text: `Reacted ${emoji} to #${messageId}` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  // --- Collaboration ---
  if (req.params.name === "share_code") {
    const { code, language, description } = req.params.arguments as { code: string; language?: string; description?: string };
    const msg = `${description ? description + "\n\n" : ""}\`\`\`${language || ""}\n${code}\n\`\`\``;
    try { const data = await apiPost("/messages", { content: msg }); return { content: [{ type: "text", text: `Code shared (message #${data.id})` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "request_review") {
    const { description } = req.params.arguments as { description: string };
    const msg = `[Review Request] ${description}`;
    try { const data = await apiPost("/messages", { content: msg }); return { content: [{ type: "text", text: `Review request posted (message #${data.id})` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "create_task") {
    const { title, assignTo } = req.params.arguments as { title: string; assignTo?: string };
    try { const data = await apiPost("/tasks", { title, assignedTo: assignTo }); return { content: [{ type: "text", text: `Task created: "${title}" (${data.taskId})` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "list_tasks") {
    try {
      const data = await apiGet("/tasks");
      if (!data.length) return { content: [{ type: "text", text: "No tasks." }] };
      const formatted = data.map((t: any) => `[${t.status}] ${t.title} (${t.id})`).join("\n");
      return { content: [{ type: "text", text: `Team tasks:\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "update_task") {
    const { taskId, status } = req.params.arguments as { taskId: string; status: string };
    try {
      await fetch(`${TEAM_CHAT_URL}/tasks`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEAM_CHAT_TOKEN}` }, body: JSON.stringify({ taskId, status }) });
      return { content: [{ type: "text", text: `Task ${taskId} updated to ${status}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  // --- Context ---
  if (req.params.name === "set_status") {
    const { status } = req.params.arguments as { status: string };
    try { await apiPost("/status", { status }); return { content: [{ type: "text", text: `Status set: "${status}"` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "get_team_status") {
    try {
      const data = await apiGet("/status");
      const formatted = data.map((m: any) => `${m.name}${m.ownerName ? ` [${m.ownerName}]` : ""}: ${m.status || "(no status)"}`).join("\n");
      return { content: [{ type: "text", text: `Team status:\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "set_topic") {
    const { topic } = req.params.arguments as { topic: string };
    try { await apiPost("/topic", { topic }); return { content: [{ type: "text", text: `Topic set: "${topic}"` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "get_topic") {
    try {
      const data = await apiGet("/topic");
      return { content: [{ type: "text", text: data.topic ? `Current topic: "${data.topic}"` : "No topic set." }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  // --- Meta ---
  if (req.params.name === "message_stats") {
    try {
      const data = await apiGet("/stats");
      const formatted = data.map((s: any) => `${s.name}: ${s.count} messages`).join("\n");
      return { content: [{ type: "text", text: `Message stats:\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "chat_history") {
    try {
      const data = await apiGet("/history");
      if (!data.length) return { content: [{ type: "text", text: "No messages yet." }] };
      const formatted = data.map((m: any) => `[${new Date(m.createdAt).toLocaleString()}] ${m.memberName}: ${m.content}`).join("\n\n");
      return { content: [{ type: "text", text: `Chat history (${data.length} messages):\n\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "rename_team") {
    const { name } = req.params.arguments as { name: string };
    try { await apiPost("/team/rename", { name }); return { content: [{ type: "text", text: `Team renamed to "${name}"` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "generate_invite_code") {
    try { const data = await apiPost("/team/invite-code", {}); return { content: [{ type: "text", text: `New invite code: ${data.code}` }] }; }
    catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  // --- Account & Onboarding ---
  if (req.params.name === "update_profile") {
    const args = req.params.arguments as { claudeName?: string; ownerName?: string };
    try {
      await fetch(`${TEAM_CHAT_URL}/profile`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEAM_CHAT_TOKEN}` }, body: JSON.stringify(args) });
      return { content: [{ type: "text", text: "Profile updated" }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "my_teams") {
    try {
      const data = await apiGet("/plugin/my-teams");
      if (!data.length) return { content: [{ type: "text", text: "You're not in any teams." }] };
      const formatted = data.map((t: any) => `- ${t.teamName} (member: ${t.memberName})`).join("\n");
      return { content: [{ type: "text", text: `Your teams:\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "pending_invitations") {
    try {
      const data = await apiGet("/plugin/invitations");
      if (!data.length) return { content: [{ type: "text", text: "No pending invitations." }] };
      const formatted = data.map((i: any) => `- ${i.fromClaudeName} [${i.fromOwnerName}] invited you to "${i.teamName}" (ID: ${i.id})`).join("\n");
      return { content: [{ type: "text", text: `Pending invitations:\n${formatted}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "accept_invitation") {
    const { invitationId } = req.params.arguments as { invitationId: string };
    try {
      const data = await apiPost("/plugin/invitations/respond", { invitationId, action: "accept" });
      return { content: [{ type: "text", text: `Accepted! Joined team "${data.team.name}". API key: ${data.member.apiKey}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "decline_invitation") {
    const { invitationId } = req.params.arguments as { invitationId: string };
    try {
      await apiPost("/plugin/invitations/respond", { invitationId, action: "decline" });
      return { content: [{ type: "text", text: "Invitation declined." }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "register_user") {
    const { serverUrl, email, claudeName, ownerName, password, siteInviteCode } = req.params.arguments as any;
    try {
      const res = await fetch(`${serverUrl}/plugin/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, claudeName, ownerName, password, siteInviteCode }) });
      if (!res.ok) { const err = await res.json(); return { content: [{ type: "text", text: `Registration failed: ${err.error}` }] }; }
      const data = await res.json();
      return { content: [{ type: "text", text: `Registered! Claude name: ${data.user.claudeName}, Owner: ${data.user.ownerName}\nToken: ${data.token}\n\nSave this token to join teams.` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
  }

  if (req.params.name === "login") {
    const { serverUrl, email, password } = req.params.arguments as any;
    try {
      const res = await fetch(`${serverUrl}/plugin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!res.ok) { const err = await res.json(); return { content: [{ type: "text", text: `Login failed: ${err.error}` }] }; }
      const data = await res.json();
      return { content: [{ type: "text", text: `Logged in as ${data.user.claudeName} [${data.user.ownerName}]\nToken: ${data.token}` }] };
    } catch (err) { return { content: [{ type: "text", text: `Failed: ${err}` }] }; }
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
    // Get user's teams
    const teams = await apiGet("/teams/me");
    if (!teams.length) {
      process.stderr.write(`[team-chat] Not a member of any team yet\n`);
      return;
    }

    // Use first team and its #general channel
    const team = teams[0];
    activeTeamId = team.id;
    activeTeamName = team.name;
    activeChannelId = team.channels?.[0]?.id || null;

    process.stderr.write(
      `[team-chat] Team: "${team.name}" (${team.id})\n` +
      `[team-chat] Channel: #${team.channels?.[0]?.name || "general"} (${activeChannelId})\n` +
      `[team-chat] Members: ${team.memberCount}\n`
    );

    // Get detailed member info
    if (activeTeamId) {
      const data = await apiGet(`/me?teamId=${activeTeamId}`);
      const others = data.members
        .filter((m: any) => !m.isYou)
        .map((m: any) => `${m.claudeName}${m.ownerName ? ` [${m.ownerName}]` : ""}`)
        .join(", ");

      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content:
            `[System] You are ${data.me.claudeName}${data.me.ownerName ? ` [${data.me.ownerName}]` : ""} ` +
            `in team "${data.team.name}" on channel #${team.channels?.[0]?.name || "general"}. ` +
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
    }
  } catch (err) {
    process.stderr.write(`[team-chat] Failed to fetch identity: ${err}\n`);
  }
}

// --- Push a message to Claude's session ---

async function pushToChannel(msg: {
  id: number;
  claudeName?: string;
  memberName?: string;
  ownerName?: string;
  userId?: string;
  memberId?: string;
  content: string;
  replyTo?: number | null;
  createdAt: string;
}) {
  try {
    const name = msg.claudeName || msg.memberName || "Unknown";
    const sender = msg.ownerName ? `${name} [${msg.ownerName}]` : name;
    const senderId = msg.userId || msg.memberId || "unknown";
    const replyInfo = msg.replyTo ? ` (replying to #${msg.replyTo})` : "";
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `${sender}${replyInfo}: ${msg.content}`,
        meta: {
          chat_id: "team_chat",
          message_id: String(msg.id),
          sender: name,
          sender_id: senderId,
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
    if (!activeChannelId) return;
    const data = await apiGet(`/messages?channelId=${activeChannelId}&since=${lastSeenId}&limit=20`);
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
  if (!activeTeamId) {
    process.stderr.write(`[team-chat] No active team — skipping WebSocket\n`);
    return;
  }
  const wsUrl = TEAM_CHAT_URL.replace(/^http/, "ws") + `/ws?token=${TEAM_CHAT_TOKEN}&teamId=${activeTeamId}`;
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
