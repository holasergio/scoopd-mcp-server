export interface ScoopdJob {
  id: string;
  handle: string;
  status: "pending" | "processing" | "done" | "failed";
  result: ScoopdReport | null;
  error: string | null;
  created_at: string;
}

export interface ScoopdReport {
  snapshot?: AccountSnapshot;
  content_dna?: ContentDNA;
  hooks?: HookAnalysis;
  gaps?: GapAnalysis;
  sentiment?: SentimentAnalysis;
  hashtags?: HashtagAnalysis;
  top_performers?: TopPerformers;
  brand_voice?: BrandVoice;
  posting_patterns?: PostingPatterns;
}

export interface AccountSnapshot {
  handle: string;
  followers: number;
  following: number;
  total_posts: number;
  avg_likes: number;
  avg_comments: number;
  engagement_rate: number;
  bio: string;
  niche: string;
}

export interface ContentDNA {
  topics: string[];
  formats: string[];
  avg_length_seconds: number;
  posting_frequency: string;
  content_pillars: string[];
}

export interface HookAnalysis {
  hooks: Array<{
    text: string;
    type: string;
    effectiveness: string;
  }>;
}

export interface GapAnalysis {
  gaps: Array<{
    area: string;
    description: string;
    opportunity: string;
  }>;
}

export interface SentimentAnalysis {
  overall_tone: string;
  community_strength: string;
  themes: string[];
}

export interface HashtagAnalysis {
  top_hashtags: string[];
  avg_per_post: number;
  recommended: string[];
}

export interface TopPerformers {
  reels: Array<{
    caption: string;
    engagement_rate: number;
    why_it_worked: string;
  }>;
}

export interface BrandVoice {
  personality: string;
  tone_spectrum: string;
  signature_phrases: string[];
  cta_style: string;
}

export interface PostingPatterns {
  best_day: string;
  worst_day: string;
  consistency_score: number;
  patterns: Array<{
    day: string;
    engagement: number;
  }>;
}

export interface UserProfile {
  id: string;
  plan: "free" | "creator" | "pro" | "agency";
  analyses_count: number;
  analyses_limit: number;
}
