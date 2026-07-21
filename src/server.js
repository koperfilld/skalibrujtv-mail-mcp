import crypto from "node:crypto";
import express from "express";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 3000);
const IMAP_HOST = process.env.IMAP_HOST || "d8.thecamels.org";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;

if (!ACCESS_TOKEN || ACCESS_TOKEN.length < 24) {
  throw new Error("MCP_ACCESS_TOKEN must contain at least 24 characters");
}

const accounts = {
  maciej: {
    email: process.env.MAIL1_USER || "maciej.koper@skalibrujtv.pl",
    password: process.env.MAIL1_PASSWORD,
  },
  info: {
    email: process.env.MAIL2_USER || "info@skalibrujtv.pl",
    password: process.env.MAIL2_PASSWORD,
  },
};

for (const [name, account] of Object.entries(accounts)) {
  if (!account.password) throw new Error(`Missing password for account ${name}`);
}

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function safeAccount(name) {
  const account = accounts[name];
  if (!account) throw new Error(`Unknown account: ${name}`);
  return account;
}

async function withImap(accountName, fn) {
  const account = safeAccount(accountName);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client, account);
  } finally {
    await client.logout().catch(() => {});
  }
}

function addresses(value) {
  return value?.map((item) => ({ name: item.name || "", address: item.address || "" })) || [];
}

function createServer() {
  const server = new McpServer({ name: "SkalibrujTV Mail", version: "1.0.0" });

  server.tool(
    "list_accounts",
    "List the email accounts available through this private connector.",
    {},
    async () => text(Object.entries(accounts).map(([id, a]) => ({ id, email: a.email }))),
  );

  server.tool(
    "list_mailboxes",
    "List folders/mailboxes for one email account.",
    { account: z.enum(["maciej", "info"]) },
    async ({ account }) => withImap(account, async (client) => {
      const result = [];
      for await (const box of client.list()) {
        result.push({ path: box.path, name: box.name, specialUse: box.specialUse || null });
      }
      return text(result);
    }),
  );

  server.tool(
    "search_messages",
    "Search message headers in a mailbox. Returns newest matching messages first. Use blank query to list recent mail.",
    {
      account: z.enum(["maciej", "info"]),
      mailbox: z.string().default("INBOX"),
      query: z.string().default(""),
      from: z.string().optional(),
      since: z.string().optional().describe("ISO date, for example 2026-07-01"),
      unseenOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ account, mailbox, query, from, since, unseenOnly, limit }) => withImap(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const criteria = {};
        if (query) criteria.or = [{ subject: query }, { body: query }, { from: query }, { to: query }];
        if (from) criteria.from = from;
        if (since) criteria.since = new Date(`${since}T00:00:00Z`);
        if (unseenOnly) criteria.seen = false;
        const uids = await client.search(criteria, { uid: true });
        const selected = uids.slice(-limit).reverse();
        const rows = [];
        for (const uid of selected) {
          const msg = await client.fetchOne(uid, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true });
          if (!msg) continue;
          rows.push({
            uid: msg.uid,
            mailbox,
            subject: msg.envelope?.subject || "",
            from: addresses(msg.envelope?.from),
            to: addresses(msg.envelope?.to),
            date: (msg.envelope?.date || msg.internalDate)?.toISOString?.() || null,
            seen: msg.flags?.has("\\Seen") || false,
            flagged: msg.flags?.has("\\Flagged") || false,
            size: msg.size || null,
          });
        }
        return text(rows);
      } finally {
        lock.release();
      }
    }),
  );

  server.tool(
    "get_message",
    "Read one complete email message by IMAP UID, including a list of attachments. Attachment bytes are not returned.",
    {
      account: z.enum(["maciej", "info"]),
      mailbox: z.string().default("INBOX"),
      uid: z.number().int().positive(),
      markSeen: z.boolean().default(false),
    },
    async ({ account, mailbox, uid, markSeen }) => withImap(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msg = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
        if (!msg?.source) throw new Error("Message not found");
        const parsed = await simpleParser(msg.source);
        if (markSeen) await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        return text({
          uid,
          mailbox,
          messageId: parsed.messageId || null,
          subject: parsed.subject || "",
          from: parsed.from?.text || "",
          to: parsed.to?.text || "",
          cc: parsed.cc?.text || "",
          date: parsed.date?.toISOString?.() || null,
          text: parsed.text || "",
          attachments: parsed.attachments.map((a) => ({ filename: a.filename || null, contentType: a.contentType, size: a.size })),
        });
      } finally {
        lock.release();
      }
    }),
  );

  server.tool(
    "set_seen",
    "Mark messages as read or unread. This changes mailbox state and should only be used after user confirmation.",
    {
      account: z.enum(["maciej", "info"]),
      mailbox: z.string().default("INBOX"),
      uids: z.array(z.number().int().positive()).min(1).max(100),
      seen: z.boolean(),
    },
    async ({ account, mailbox, uids, seen }) => withImap(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const range = uids.join(",");
        if (seen) await client.messageFlagsAdd(range, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(range, ["\\Seen"], { uid: true });
        return text({ success: true, account, mailbox, uids, seen });
      } finally {
        lock.release();
      }
    }),
  );

  server.tool(
    "move_messages",
    "Move messages to another folder. This changes mailbox state and should only be used after user confirmation.",
    {
      account: z.enum(["maciej", "info"]),
      mailbox: z.string().default("INBOX"),
      destination: z.string(),
      uids: z.array(z.number().int().positive()).min(1).max(100),
    },
    async ({ account, mailbox, destination, uids }) => withImap(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageMove(uids.join(","), destination, { uid: true });
        return text({ success: true, account, from: mailbox, destination, uids });
      } finally {
        lock.release();
      }
    }),
  );

  server.tool(
    "delete_messages",
    "Permanently delete messages. This is destructive and must only be used after explicit user confirmation.",
    {
      account: z.enum(["maciej", "info"]),
      mailbox: z.string().default("INBOX"),
      uids: z.array(z.number().int().positive()).min(1).max(100),
    },
    async ({ account, mailbox, uids }) => withImap(account, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageDelete(uids.join(","), { uid: true });
        return text({ success: true, permanentlyDeleted: true, account, mailbox, uids });
      } finally {
        lock.release();
      }
    }),
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.all("/mcp/:token", async (req, res) => {
  const supplied = Buffer.from(req.params.token || "");
  const expected = Buffer.from(ACCESS_TOKEN);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(404).json({ error: "Not found" });
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SkalibrujTV Mail MCP listening on port ${PORT}`);
});
