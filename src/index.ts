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
import { z } from "zod";
import { setApiKey, startAnalysis, getJobStatus, getUserProfile, listReports, handleApiError } from "./services/api-client.js";
import { formatReportMarkdown } from "./services/formatter.js";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "./constants.js";
import type { ScoopdJob } from "./types.js";

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

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "scoopd-mcp-server", version: "1.0.0" });
  });

  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    // Extract API key from Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      setApiKey(authHeader.slice(7));
    }

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
