import axios, { AxiosError } from "axios";
import { SCOOPD_API_URL } from "../constants.js";
import type { ScoopdJob, UserProfile } from "../types.js";

let currentApiKey = "";

export function setApiKey(key: string): void {
  currentApiKey = key;
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  data?: Record<string, unknown>
): Promise<T> {
  if (!currentApiKey) {
    throw new Error("API key not configured. Get yours at scoopd.pro/api-keys");
  }

  const response = await axios({
    method,
    url: `${SCOOPD_API_URL}${path}`,
    data,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${currentApiKey}`,
    },
  });
  return response.data;
}

export async function getUserProfile(): Promise<UserProfile> {
  return request<UserProfile>("GET", "/api/user/plan");
}

export async function startAnalysis(handle: string, reels?: number): Promise<{ jobId: string }> {
  return request<{ jobId: string }>("POST", "/api/analyze", {
    handle: handle.replace("@", ""),
    max_reels: reels ?? 30,
  });
}

export async function getJobStatus(jobId: string): Promise<ScoopdJob> {
  return request<ScoopdJob>("GET", `/api/jobs/${jobId}`);
}

export async function listReports(limit = 10, offset = 0): Promise<{
  reports: ScoopdJob[];
  total: number;
}> {
  return request("GET", `/api/jobs?status=done&limit=${limit}&offset=${offset}`);
}

export function handleApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      switch (error.response.status) {
        case 401:
          return "Error: Invalid API key. Get a valid key at scoopd.pro/api-keys";
        case 403:
          return "Error: This feature requires a higher plan. Upgrade at scoopd.pro/pricing";
        case 429:
          return "Error: You've reached your analysis limit this month. Upgrade at scoopd.pro/pricing";
        case 404:
          return "Error: Resource not found. Check the account handle or report ID.";
        default:
          return `Error: API request failed (${error.response.status}). Try again or contact support@scoopd.pro`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. The analysis may still be running — try scoopd_get_report with the job ID.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}
