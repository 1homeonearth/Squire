cd /opt/squire/app
cat > mcp/internal-api.mjs <<'JS'
// mcp/internal-api.mjs
import express from "express";
import { z } from "zod";

/**
 * startInternalApi attaches a localhost-only API for MCP bridging.
 * Auth: Bearer token in Authorization header (shared secret).
 * Endpoints:
 *  - GET    /internal/discord/channels?guildId=...
 *  - GET    /internal/discord/messages?channelId=...&limit=...
 *  - POST   /internal/discord/send      { channelId, content }
 */
export function startInternalApi({ client, logger = console }) {
  const enable = process.env.SQUIRE_INTERNAL_API_ENABLE === "true";
  if (!enable) {
    logger.log("[internal-api] disabled");
    return { close: () => {} };
  }

  const bind = process.env.SQUIRE_INTERNAL_API_BIND || "127.0.0.1:4011";
  const [host, portStr] = bind.split(":");
  const port = Number(portStr || 4011);
  const token = process.env.SQUIRE_INTERNAL_API_TOKEN;
  if (!token) throw new Error("SQUIRE_INTERNAL_API_TOKEN is required when API is enabled");

  const allowlistEnv = (process.env.SQUIRE_INTERNAL_API_ALLOW || "").trim();
  const allowlist = allowlistEnv ? new Set(allowlistEnv.split(",").map(s => s.trim())) : null;

  const app = express();
  app.disable("x-powered-by"); // reduce passive fingerprinting
  app.use(express.json({ limit: "64kb" }));
  app.use((_, res, next) => {
    // control-plane hardening
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    next();
  });

  // Bearer auth
  app.use((req, res, next) => {
    const hdr = req.get("authorization") || "";
    const incoming = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    if (incoming !== token) return res.status(401).json({ error: "unauthorized" });
    next();
  });

  const isAllowed = (channelId) => {
    if (!allowlist) return true; // dev mode: no allowlist set
    return allowlist.has(channelId);
  };

  // List text channels (optionally filter by guild)
  app.get("/internal/discord/channels", async (req, res) => {
    try {
      const guildId = req.query.guildId?.toString();
      const out = [];
      for (const [id, ch] of client.channels.cache) {
        try {
          if (!ch?.isTextBased?.()) continue;
          if (!isAllowed(id)) continue;
          if (guildId && ch.guild?.id !== guildId) continue;
          out.push({
            id,
            name: ch.name,
            type: ch.type,
            guildId: ch.guild?.id,
            guildName: ch.guild?.name,
          });
        } catch {}
      }
      out.sort((a, b) => a.guildName?.localeCompare(b.guildName || "") || a.name.localeCompare(b.name));
      res.json({ channels: out });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // Fetch recent messages
  app.get("/internal/discord/messages", async (req, res) => {
    try {
      const schema = z.object({
        channelId: z.string().min(1),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      });
      const { channelId, limit } = schema.parse(req.query);
      if (!isAllowed(channelId)) return res.status(403).json({ error: "forbidden" });

      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch?.isTextBased?.()) return res.status(400).json({ error: "not_text_channel" });

      const msgs = await ch.messages.fetch({ limit }).catch(() => null);
      if (!msgs) return res.status(403).json({ error: "fetch_denied" });

      const list = Array.from(msgs.values())
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map(m => ({
          id: m.id,
          authorId: m.author?.id,
          author: m.author?.username,
          content: m.content,
          createdAt: m.createdAt?.toISOString(),
          url: m.url,
        }));
      res.json({ messages: list });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  // Send a message
  app.post("/internal/discord/send", async (req, res) => {
    try {
      const schema = z.object({
        channelId: z.string().min(1),
        content: z.string().min(1),
      });
      const { channelId, content } = schema.parse(req.body);
      if (!isAllowed(channelId)) return res.status(403).json({ error: "forbidden" });

      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch?.isTextBased?.()) return res.status(400).json({ error: "not_text_channel" });

      const m = await ch.send({ content });
      res.json({ id: m.id, url: m.url });
    } catch (err) {
      logger.error(err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  const server = app.listen(port, host, () => {
    logger.log(`[internal-api] listening on http://${host}:${port}`);
  });

  return { close: () => server.close() };
}
JS
git add mcp/internal-api.mjs
git status -sb
