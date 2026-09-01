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
  client_id?: string | null;
};

const LS_MY_GLOBAL_IDS = "staredown_my_global_ids_v1";
const LS_ACCOUNT_ID = "staredown_account_id_v1";

function getClientId(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(LS_ACCOUNT_ID); } catch { return null; }
}
function trackMyGlobalId(id: string) {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(LS_MY_GLOBAL_IDS);
    const arr: string[] = raw ? JSON.parse(raw) : [];
    if (!arr.includes(id)) {
      arr.push(id);
      localStorage.setItem(LS_MY_GLOBAL_IDS, JSON.stringify(arr.slice(-100)));
    }
  } catch {}
}
function getMyTrackedIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_MY_GLOBAL_IDS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

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
  const clientId = getClientId();
  const payload: Record<string, unknown> = {
    player_name: trimmedName,
    duration_ms: Math.round(durationMs),
  };
  if (clientId) payload.client_id = clientId;
  const { data, error } = await client.from("high_scores").insert(payload).select("id").single();
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
  // Track inserted id for reliable delete regardless of name change
  if (data && (data as { id?: string }).id) {
    trackMyGlobalId((data as { id: string }).id);
  }
  return { error: null, id: (data as { id?: string })?.id ?? null };
}

// Delete my global scores: by client_id (robust to name change) + by locally tracked ids
export async function deleteMyGlobalScores(): Promise<{ error: string | null; deletedCount: number }> {
  const client = getSupabase();
  if (!client) return { error: "Supabase chưa cấu hình", deletedCount: 0 };
  const clientId = getClientId();
  const trackedIds = getMyTrackedIds();
  let deleted = 0;

  // 1) Delete by client_id (covers all scores from this device, even after name change)
  if (clientId) {
    const { error, count } = await client.from("high_scores").delete({ count: "exact" }).eq("client_id", clientId);
    if (error) {
      console.warn("[Supabase] delete by client_id error", error);
      // don't return yet, try ids
    } else {
      deleted += count ?? 0;
    }
  }
  // 2) Delete by tracked ids (covers old scores where client_id was null but we stored id)
  if (trackedIds.length > 0) {
    const { error, count } = await client.from("high_scores").delete({ count: "exact" }).in("id", trackedIds);
    if (error) {
      console.warn("[Supabase] delete by ids error", error);
      if (deleted === 0) return { error: error.message, deletedCount: 0 };
    } else {
      // avoid double counting if some ids already deleted via client_id
      const newDeleted = count ?? 0;
      // if both methods deleted overlapping rows, count may overcount but we track locally
      deleted += newDeleted;
      // clear tracked ids that were deleted
      if (typeof window !== "undefined") {
        try { localStorage.setItem(LS_MY_GLOBAL_IDS, JSON.stringify([])); } catch {}
      }
    }
  }
  // If no client_id and no tracked ids, try fallback: delete nothing but inform
  if (!clientId && trackedIds.length === 0) {
    return { error: "Không tìm thấy dữ liệu Global của máy này (chưa có client_id hoặc lịch sử). Hãy chắc chắn bạn đã đăng điểm sau bản cập nhật này.", deletedCount: 0 };
  }
  if (deleted === 0) return { error: null, deletedCount: 0 };
  // clear tracked after success
  if (typeof window !== "undefined") {
    try { localStorage.setItem(LS_MY_GLOBAL_IDS, JSON.stringify([])); } catch {}
  }
  return { error: null, deletedCount: deleted };
}

export async function fetchMyGlobalScores(): Promise<HighScore[]> {
  const client = getSupabase();
  const clientId = getClientId();
  if (!client || !clientId) return [];
  const { data, error } = await client.from("high_scores").select("*").eq("client_id", clientId).order("duration_ms", { ascending: false }).limit(50);
  if (error) { console.warn("[Supabase] fetchMyGlobalScores error", error); return []; }
  return (data as HighScore[]) ?? [];
}
