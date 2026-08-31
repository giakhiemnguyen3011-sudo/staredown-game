import { createClient, SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | null = null;

function normalizeSupabaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, ""); // remove trailing slashes
  // Fix common mistake: user copies https://xxx.supabase.co/rest/v1  -> should be https://xxx.supabase.co
  if (u.endsWith("/rest/v1")) u = u.slice(0, -"/rest/v1".length);
  if (u.endsWith("/rest/v1/")) u = u.slice(0, -"/rest/v1/".length);
  return u;
}

export function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  url = normalizeSupabaseUrl(url);
  key = key.trim();
  if (!url || !key) return null;
  // Basic validation
  if (!url.startsWith("https://")) {
    console.warn("[Supabase] URL must start with https://, got:", url);
    return null;
  }
  try {
    supabase = createClient(url, key);
    return supabase;
  } catch (e) {
    console.warn("[Supabase] createClient failed", e);
    return null;
  }
}

// Helper to debug env issues in browser console
export function getSupabaseConfigError(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return "Thiếu NEXT_PUBLIC_SUPABASE_URL hoặc ANON_KEY (chưa cấu hình Vercel Env)";
  const norm = normalizeSupabaseUrl(url);
  if (!norm.startsWith("https://")) return `URL sai định dạng: ${norm} (phải bắt đầu https://)`;
  if (url.includes("/rest/v1")) return `URL chứa /rest/v1 – đã tự sửa thành ${norm} nhưng bạn nên sửa lại Env trên Vercel`;
  return null;
}

export type HighScore = {
  id: string;
  player_name: string;
  duration_ms: number;
  created_at: string;
};

export async function fetchHighScores(limit = 10): Promise<HighScore[]> {
  const client = getSupabase();
  if (!client) {
    const cfgErr = getSupabaseConfigError();
    if (cfgErr) console.warn("[Supabase] fetchHighScores skipped:", cfgErr);
    return [];
  }
  const { data, error } = await client
    .from("high_scores")
    .select("*")
    .order("duration_ms", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Supabase] fetchHighScores error", error.message, error);
    return [];
  }
  return data as HighScore[];
}

export async function fetchRecentScores(limit = 10): Promise<HighScore[]> {
  const client = getSupabase();
  if (!client) return [];
  const { data, error } = await client
    .from("high_scores")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Supabase] fetchRecentScores error", error.message);
    return [];
  }
  return data as HighScore[];
}

export async function fetchGlobalLeaderboard(limit = 20, order: "top" | "recent" = "top"): Promise<HighScore[]> {
  return order === "recent" ? fetchRecentScores(limit) : fetchHighScores(limit);
}

export async function submitHighScore(name: string, durationMs: number) {
  const client = getSupabase();
  if (!client) {
    const cfgErr = getSupabaseConfigError();
    return { error: cfgErr ?? "Supabase not configured" };
  }
  // Validate before insert to give clearer message
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > 30) {
    return { error: "Tên phải 1-30 ký tự" };
  }
  if (durationMs <= 0 || durationMs >= 6000000) {
    return { error: "duration_ms không hợp lệ" };
  }
  const { error } = await client.from("high_scores").insert({
    player_name: trimmedName,
    duration_ms: Math.round(durationMs),
  });
  if (error) {
    console.warn("[Supabase] submitHighScore error", error.message, error);
    // Map common RLS error to friendly message
    if (error.message.includes("row-level security")) {
      return { error: "Lỗi RLS: Bảng high_scores chưa được cấp quyền ghi. Hãy chạy lại supabase.sql (disable RLS hoặc tạo policy) trong Supabase SQL Editor." };
    }
    if (error.message.includes("Invalid path")) {
      return { error: "Lỗi URL Supabase chứa /rest/v1. Hãy sửa Env thành https://xxx.supabase.co (không có /rest/v1)" };
    }
    return { error: error.message };
  }
  return { error: null };
}
