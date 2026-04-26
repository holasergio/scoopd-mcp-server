#!/usr/bin/env node
/**
 * Scoopd MCP Server
 *
 * AI-powered Instagram competitor intelligence.
 * Analyze any public Instagram account: content strategy, hooks, gaps,
 * brand voice, posting patterns — all from Claude.
 *
 * Endpoint: https://mcp.scoopd.pro/mcp
 * Auth: Bearer API key from scoopd.pro/api-keys
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { setApiKey, startAnalysis, getJobStatus, getUserProfile, listReports, handleApiError } from "./services/api-client.js";
import { formatReportMarkdown } from "./services/formatter.js";
import { createOAuthStore } from "./services/oauth-store.js";
import { oauthRateLimits } from "./middleware/rate-limit.js";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "./constants.js";
import type { ScoopdJob } from "./types.js";

const PKCE_STRICT = (process.env.MCP_PKCE_STRICT ?? "false").toLowerCase() === "true";

const server = new McpServer({
  name: "scoopd-mcp-server",
  version: "1.0.0",
});

// ─── Tool: scoopd_analyze_account ──────────────────────────────

server.registerTool(
  "scoopd_analyze_account",
  {
    title: "Analyze Instagram Account",
    description: `Perform deep AI competitor intelligence analysis on any public Instagram account.

Analyzes up to 30 recent Reels: downloads, transcribes audio, and runs GPT-4o analysis to produce a 9-section strategic report.

Sections: Account Snapshot, Content DNA, Hook Analysis, Gap Analysis, Sentiment, Hashtags, Top Performers, Brand Voice, Posting Patterns.

Args:
  - handle (string): Instagram username (with or without @). Example: "cristiano", "@garyvee"
  - reels (number, optional): Number of Reels to analyze (10-50, default 30)

Returns: Full 9-section competitor intelligence report in markdown format.

Analysis takes 45-90 seconds. The tool polls automatically until complete.

Examples:
  - "Analyze @cristiano's Instagram strategy" -> handle="cristiano"
  - "What hooks does garyvee use?" -> handle="garyvee"
  - "Compare content strategy of nike" -> handle="nike"

Errors:
  - 429: Monthly analysis limit reached. Upgrade at scoopd.pro/pricing
  - 404: Account not found or is private
  - Timeout: Analysis still running, use scoopd_get_report with job ID`,
    inputSchema: {
      handle: z.string()
        .min(1, "Instagram handle is required")
        .max(30, "Handle too long")
        .describe("Instagram username (e.g. 'cristiano' or '@garyvee')"),
      reels: z.number()
        .int()
        .min(10)
        .max(50)
        .default(30)
        .optional()
        .describe("Number of Reels to analyze (default: 30)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ handle, reels }) => {
    try {
      const cleanHandle = handle.replace("@", "").trim();

      // Start analysis
      const { jobId } = await startAnalysis(cleanHandle, reels);

      // Poll for completion
      let job: ScoopdJob | null = null;
      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        job = await getJobStatus(jobId);

        if (job.status === "done" && job.result) {
          const markdown = formatReportMarkdown(job.result, cleanHandle);
          return {
            content: [{ type: "text" as const, text: markdown }],
            structuredContent: {
              job_id: job.id,
              handle: cleanHandle,
              sections: Object.keys(job.result),
              report: job.result,
            },
          };
        }

        if (job.status === "failed") {
          return {
            content: [{
              type: "text" as const,
              text: `Analysis failed for @${cleanHandle}: ${job.error ?? "Unknown error"}. The account may be private or not exist. Try a different handle.`,
            }],
            isError: true,
          };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Analysis for @${cleanHandle} is still processing (job: ${jobId}). Use scoopd_get_report with this job ID to check later.`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: scoopd_get_report ───────────────────────────────────

server.registerTool(
  "scoopd_get_report",
  {
    title: "Get Saved Report",
    description: `Retrieve a previously generated competitor intelligence report by job ID.

Use this to check on a running analysis or re-read a completed report.

Args:
  - job_id (string): The job ID returned by scoopd_analyze_account

Returns: Full 9-section report if completed, or current status if still processing.`,
    inputSchema: {
      job_id: z.string()
        .uuid("Invalid job ID format")
        .describe("Job ID from a previous analysis"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ job_id }) => {
    try {
      const job = await getJobStatus(job_id);

      if (job.status === "done" && job.result) {
        const markdown = formatReportMarkdown(job.result, job.handle);
        return {
          content: [{ type: "text" as const, text: markdown }],
          structuredContent: {
            job_id: job.id,
            handle: job.handle,
            status: job.status,
            report: job.result,
          },
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `Report status: ${job.status}${job.error ? ` — ${job.error}` : ""}. ${
            job.status === "pending" || job.status === "processing"
              ? "Still processing, try again in 30 seconds."
              : ""
          }`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: scoopd_list_reports ─────────────────────────────────

server.registerTool(
  "scoopd_list_reports",
  {
    title: "List My Reports",
    description: `List all completed competitor intelligence reports in your Scoopd account.

Returns report IDs, handles, and creation dates. Use scoopd_get_report to view any report.

Args:
  - limit (number, optional): Number of reports to return (default: 10, max: 50)

Returns: List of reports with IDs, handles, dates.`,
    inputSchema: {
      limit: z.number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .optional()
        .describe("Number of reports to return (default: 10)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ limit }) => {
    try {
      const { reports, total } = await listReports(limit ?? 10);

      if (!reports?.length) {
        return {
          content: [{
            type: "text" as const,
            text: "No reports yet. Use scoopd_analyze_account to analyze your first competitor!",
          }],
        };
      }

      const lines = [`# Your Reports (${reports.length} of ${total})`, ""];
      for (const r of reports) {
        lines.push(`- **@${r.handle}** — ${new Date(r.created_at).toLocaleDateString()} (ID: \`${r.id}\`)`);
      }
      lines.push("", "Use scoopd_get_report with any ID above to view the full report.");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          total,
          count: reports.length,
          reports: reports.map((r) => ({
            id: r.id,
            handle: r.handle,
            created_at: r.created_at,
          })),
        },
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
        isError: true,
      };
    }
  }
);

// ─── Tool: scoopd_my_usage ─────────────────────────────────────

server.registerTool(
  "scoopd_my_usage",
  {
    title: "Check My Usage & Plan",
    description: `Check your current Scoopd plan, usage limits, and remaining analyses this month.

No arguments required.

Returns: Plan name, analyses used/remaining, and upgrade options if applicable.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    try {
      const profile = await getUserProfile();

      const remaining = profile.analyses_limit - profile.analyses_count;
      const lines = [
        `# Scoopd Account`,
        "",
        `- **Plan**: ${profile.plan.charAt(0).toUpperCase() + profile.plan.slice(1)}`,
        `- **Analyses used**: ${profile.analyses_count} / ${profile.analyses_limit}`,
        `- **Remaining**: ${remaining}`,
        "",
      ];

      if (remaining <= 0) {
        lines.push("You've used all analyses this month. Upgrade at scoopd.pro/pricing");
      } else if (remaining <= 3) {
        lines.push(`Only ${remaining} analyses left. Consider upgrading at scoopd.pro/pricing`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        structuredContent: {
          plan: profile.plan,
          analyses_count: profile.analyses_count,
          analyses_limit: profile.analyses_limit,
          remaining,
        },
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
        isError: true,
      };
    }
  }
);

// ─── Transport ─────────────────────────────────────────────────

async function runHTTP() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ─── OAuth 2.1 Store (in-memory default; Redis via OAUTH_STORE=redis) ──
  const authStore = await createOAuthStore();

  // ─── OAuth: Protected Resource Metadata ─────────────────────────
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: "https://mcp.scoopd.pro",
      authorization_servers: ["https://mcp.scoopd.pro"],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    });
  });

  // ─── OAuth: Authorization Server Metadata ───────────────────────
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: "https://mcp.scoopd.pro",
      authorization_endpoint: "https://mcp.scoopd.pro/oauth/authorize",
      token_endpoint: "https://mcp.scoopd.pro/oauth/token",
      registration_endpoint: "https://mcp.scoopd.pro/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["mcp:tools"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  // ─── OAuth: Dynamic Client Registration (RFC 7591) ──────────────
  app.post("/oauth/register", oauthRateLimits.register, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const clientId = crypto.randomBytes(16).toString("hex");

    res.status(201).json({
      client_id: clientId,
      client_name: body.client_name ?? "Claude Connector",
      redirect_uris: body.redirect_uris ?? [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // ─── OAuth: Authorization Page ──────────────────────────────────
  app.get("/oauth/authorize", oauthRateLimits.authorizeGet, (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type, scope } = req.query as Record<string, string>;

    if (response_type !== "code") {
      res.status(400).send("Unsupported response_type. Only 'code' is supported.");
      return;
    }

    if (code_challenge_method && code_challenge_method !== "S256") {
      res.status(400).send("Unsupported code_challenge_method. Only 'S256' is supported.");
      return;
    }

    if (PKCE_STRICT && !code_challenge) {
      res.status(400).send("Missing code_challenge. PKCE is required (S256).");
      return;
    }
    if (!code_challenge) {
      console.error(`[oauth] WARN: no code_challenge from client_id=${client_id ?? "unknown"} ip=${req.ip} — would be rejected with MCP_PKCE_STRICT=true`);
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Scoopd to Claude</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #0a0a0a;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      width: 100%;
      margin: 20px;
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #4fffb0;
      margin-bottom: 8px;
    }
    .logo span { color: #e0e0e0; }
    h1 {
      font-size: 20px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #888;
      font-size: 14px;
      margin-bottom: 28px;
    }
    .subtitle a { color: #4fffb0; text-decoration: none; }
    .subtitle a:hover { text-decoration: underline; }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #aaa;
      margin-bottom: 6px;
    }
    input[type="text"] {
      width: 100%;
      padding: 12px 14px;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 15px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus { border-color: #4fffb0; }
    input[type="text"]::placeholder { color: #555; }
    .btn {
      width: 100%;
      padding: 12px;
      background: #4fffb0;
      color: #0a0a0a;
      border: none;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 20px;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error {
      color: #ff6b6b;
      font-size: 13px;
      margin-top: 8px;
      display: none;
    }
    .footer {
      text-align: center;
      margin-top: 20px;
      font-size: 12px;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">scoopd<span>.</span></div>
    <h1>Connect Scoopd to Claude</h1>
    <p class="subtitle">Enter your API key from <a href="https://scoopd.pro/settings" target="_blank">scoopd.pro/settings</a></p>
    <form id="authForm">
      <label for="apiKey">API Key</label>
      <input type="text" id="apiKey" name="apiKey" placeholder="sk_live_..." autocomplete="off" spellcheck="false" required>
      <div class="error" id="error"></div>
      <button type="submit" class="btn" id="connectBtn">Connect</button>
    </form>
    <div class="footer">Your API key is sent directly to Scoopd and never stored by Claude.</div>
  </div>
  <script>
    const form = document.getElementById('authForm');
    const btn = document.getElementById('connectBtn');
    const errorEl = document.getElementById('error');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.style.display = 'none';

      const apiKey = document.getElementById('apiKey').value.trim();
      if (!apiKey) {
        errorEl.textContent = 'Please enter your API key.';
        errorEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Connecting...';

      try {
        const resp = await fetch('/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            client_id: ${JSON.stringify(client_id || "")},
            redirect_uri: ${JSON.stringify(redirect_uri || "")},
            state: ${JSON.stringify(state || "")},
            code_challenge: ${JSON.stringify(code_challenge || "")},
            code_challenge_method: ${JSON.stringify(code_challenge_method || "S256")},
            scope: ${JSON.stringify(scope || "mcp:tools")}
          })
        });

        const data = await resp.json();
        if (data.redirect) {
          window.location.href = data.redirect;
        } else {
          errorEl.textContent = data.error || 'Authorization failed.';
          errorEl.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Connect';
        }
      } catch (err) {
        errorEl.textContent = 'Network error. Please try again.';
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Connect';
      }
    });
  </script>
</body>
</html>`;

    res.type("html").send(html);
  });

  // ─── OAuth: Authorization Submit (form POST) ───────────────────
  app.post("/oauth/authorize", oauthRateLimits.authorizePost, async (req, res) => {
    const { api_key, client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.body as Record<string, string>;

    if (!api_key || !redirect_uri) {
      res.status(400).json({ error: "Missing api_key or redirect_uri" });
      return;
    }

    if (PKCE_STRICT && !code_challenge) {
      res.status(400).json({ error: "invalid_request", error_description: "PKCE code_challenge is required" });
      return;
    }

    const code = crypto.randomBytes(32).toString("hex");
    const ttlSec = 5 * 60;
    await authStore.set(code, {
      apiKey: api_key,
      codeChallenge: code_challenge || "",
      redirectUri: redirect_uri,
      clientId: client_id,
      expiresAt: Date.now() + ttlSec * 1000,
    }, ttlSec);

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    res.json({ redirect: redirectUrl.toString() });
  });

  // ─── OAuth: Token Endpoint ──────────────────────────────────────
  app.post("/oauth/token", oauthRateLimits.token, async (req, res) => {
    const { grant_type, code, redirect_uri, code_verifier } = req.body as Record<string, string>;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    if (!code) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code" });
      return;
    }

    const entry = await authStore.get(code);
    if (!entry) {
      res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
      return;
    }

    // Check expiry
    if (entry.expiresAt < Date.now()) {
      await authStore.delete(code);
      res.status(400).json({ error: "invalid_grant", error_description: "Authorization code expired" });
      return;
    }

    // Verify redirect_uri matches
    if (redirect_uri && redirect_uri !== entry.redirectUri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    // PKCE verification
    if (PKCE_STRICT && !entry.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE code_challenge required at authorize step" });
      return;
    }
    if (PKCE_STRICT && !code_verifier) {
      res.status(400).json({ error: "invalid_request", error_description: "code_verifier required" });
      return;
    }
    if (entry.codeChallenge) {
      if (!code_verifier) {
        // Client provided challenge but no verifier — skip in non-strict for backward compat (warn)
        if (PKCE_STRICT) {
          res.status(400).json({ error: "invalid_request", error_description: "code_verifier required" });
          return;
        }
        console.error(`[oauth] WARN: code_verifier missing despite codeChallenge present (client_id=${entry.clientId ?? "unknown"})`);
      } else {
        const computed = crypto.createHash("sha256").update(code_verifier).digest("base64url");
        if (computed !== entry.codeChallenge) {
          res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
      }
    }

    // Success: return the API key as the access token
    const accessToken = entry.apiKey;
    await authStore.delete(code); // One-time use

    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 86400,
    });
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "scoopd-mcp-server", version: "1.0.0" });
  });

  // MCP endpoint — supports key via: Authorization header, query param, or URL path
  app.post("/mcp", async (req, res) => {
    const authHeader = req.headers.authorization;
    const queryKey = req.query.key as string | undefined;

    // Return 401 with WWW-Authenticate if no auth provided at all
    if (!authHeader?.startsWith("Bearer ") && !queryKey) {
      res.status(401).set(
        "WWW-Authenticate",
        'Bearer resource_metadata="https://mcp.scoopd.pro/.well-known/oauth-protected-resource"'
      ).json({ error: "unauthorized", error_description: "Bearer token required" });
      return;
    }

    // Set API key from Bearer header or query param
    if (authHeader?.startsWith("Bearer ")) {
      setApiKey(authHeader.slice(7));
    } else if (queryKey) {
      setApiKey(queryKey);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Path-based auth: /sk_live_xxx/mcp — for Claude.ai Connectors that strip query params
  app.post("/:apiKey/mcp", async (req, res) => {
    setApiKey(req.params.apiKey);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env.PORT ?? "3100");
  app.listen(port, "0.0.0.0", () => {
    console.error(`Scoopd MCP server running on http://0.0.0.0:${port}/mcp`);
  });
}

async function runStdio() {
  const apiKey = process.env.SCOOPD_API_KEY;
  if (!apiKey) {
    console.error("ERROR: SCOOPD_API_KEY environment variable is required");
    console.error("Get your API key at scoopd.pro/api-keys");
    process.exit(1);
  }
  setApiKey(apiKey);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Scoopd MCP server running via stdio");
}

const transportType = process.env.TRANSPORT ?? "stdio";
if (transportType === "http") {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
