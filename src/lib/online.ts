"use client";

// Online account + friend code + ping helpers

export const LS_ACCOUNT_ID = "staredown_account_id_v1";
export const LS_FRIEND_CODE = "staredown_friend_code_v1";
export const LS_ONLINE_NAME = "staredown_player_name"; // reuse

export function generateFriendCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/1/0 confusion
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function getOrCreateAccount(): { id: string; friendCode: string } {
  if (typeof window === "undefined") return { id: "ssr", friendCode: "XXXXXX" };
  let id = localStorage.getItem(LS_ACCOUNT_ID);
  let code = localStorage.getItem(LS_FRIEND_CODE);
  if (!id) {
    id = (globalThis.crypto?.randomUUID?.() ?? `acc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    localStorage.setItem(LS_ACCOUNT_ID, id);
  }
  if (!code) {
    code = generateFriendCode();
    localStorage.setItem(LS_FRIEND_CODE, code);
  }
  return { id, friendCode: code };
}

export function regenerateFriendCode(): string {
  const code = generateFriendCode();
  if (typeof window !== "undefined") localStorage.setItem(LS_FRIEND_CODE, code);
  return code;
}

export function getPlayerName(): string {
  if (typeof window === "undefined") return "Player";
  return localStorage.getItem(LS_ONLINE_NAME) || "Player";
}

export function setPlayerNameLS(name: string) {
  if (typeof window !== "undefined") localStorage.setItem(LS_ONLINE_NAME, name);
}

// Ping smoothing
export class PingTracker {
  private samples: number[] = [];
  private lastPingTs = 0;
  constructor(private windowSize = 5) {}
  push(rtt: number) {
    if (!isFinite(rtt) || rtt < 0 || rtt > 5000) return this.getAvg();
    this.samples.push(rtt);
    if (this.samples.length > this.windowSize) this.samples.shift();
    return this.getAvg();
  }
  getAvg(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    // median to ignore spikes
    return sorted[Math.floor(sorted.length / 2)];
  }
  getSamples() { return [...this.samples]; }
}

// Clock offset estimation via ping/pong
// host sends ping {t0}, guest replies pong {t0, t1}, host calculates offset
export function estimateOffset(t0: number, t1: number, t2: number): { rtt: number; offset: number } {
  const rtt = t2 - t0;
  const offset = t1 - (t0 + rtt / 2);
  return { rtt, offset };
}

// Room code validation (6 alnum)
export function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{4,8}$/.test(code.trim().toUpperCase());
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase();
}
