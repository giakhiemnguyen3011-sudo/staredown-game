import { createClient, SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (supabase) return supabase;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  // Basic validation
  if (!url.startsWith("https://")) return null;
  try {
    supabase = createClient(url, key);
    return supabase;
  } catch {
    return null;
  }
}

export type HighScore = {
  id: string;
  player_name: string;
  duration_ms: number;
  created_at: string;
};

export async function fetchHighScores(limit = 10): Promise<HighScore[]> {
  const client = getSupabase();
  if (!client) return [];
  const { data, error } = await client
    .from("high_scores")
    .select("*")
    .order("duration_ms", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[Supabase] fetchHighScores error", error.message);
    return [];
  }
  return data as HighScore[];
}

export async function submitHighScore(name: string, durationMs: number) {
  const client = getSupabase();
  if (!client) return { error: "Supabase not configured" as const };
  const { error } = await client.from("high_scores").insert({
    player_name: name,
    duration_ms: durationMs,
  });
  if (error) return { error: error.message };
  return { error: null };
}
