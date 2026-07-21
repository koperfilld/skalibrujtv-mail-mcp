# SkalibrujTV Mail MCP

Prywatny, read-only/organizing MCP gateway for two IMAP mailboxes hosted at The Camels.

The service does not implement SMTP and cannot send email. Credentials must be stored only as Render environment variables.

## Render

Deploy from `render.yaml` or use:

- Runtime: Node
- Build command: `npm ci`
- Start command: `npm start`
- Health check: `/health`
- Region: Frankfurt

Required secrets: `MAIL1_PASSWORD`, `MAIL2_PASSWORD`, `MCP_ACCESS_TOKEN`.

The MCP endpoint is:

`https://YOUR-SERVICE.onrender.com/mcp/YOUR_MCP_ACCESS_TOKEN`

Keep this complete URL private. Anyone who knows it can access the configured mailboxes.
