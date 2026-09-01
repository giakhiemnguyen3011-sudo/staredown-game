"use client";

export type ThemePreset = {
  id: string;
  name: string;
  bg: string; // background
  card: string; // card bg
  border: string;
  accent: string; // gradient from
  accent2: string; // gradient to
  glow1: string;
  glow2: string;
  textAccent: string;
};

export const THEMES: ThemePreset[] = [
  {
    id: "midnight",
    name: "Midnight (Mặc định)",
    bg: "#070a14",
    card: "rgba(255,255,255,0.04)",
    border: "rgba(255,255,255,0.10)",
    accent: "#6366f1",
    accent2: "#8b5cf6",
    glow1: "rgba(99,102,241,0.20)",
    glow2: "rgba(6,182,212,0.15)",
    textAccent: "#a5b4fc",
  },
  {
    id: "ocean",
    name: "Ocean",
    bg: "#031a1e",
    card: "rgba(6,182,212,0.06)",
    border: "rgba(6,182,212,0.18)",
    accent: "#06b6d4",
    accent2: "#0e7490",
    glow1: "rgba(6,182,212,0.25)",
    glow2: "rgba(14,165,233,0.15)",
    textAccent: "#67e8f9",
  },
  {
    id: "sunset",
    name: "Sunset",
    bg: "#1a0a12",
    card: "rgba(236,72,153,0.06)",
    border: "rgba(236,72,153,0.18)",
    accent: "#f97316",
    accent2: "#ec4899",
    glow1: "rgba(249,115,22,0.20)",
    glow2: "rgba(236,72,153,0.15)",
    textAccent: "#fda4af",
  },
  {
    id: "forest",
    name: "Forest",
    bg: "#0a1410",
    card: "rgba(16,185,129,0.06)",
    border: "rgba(16,185,129,0.18)",
    accent: "#10b981",
    accent2: "#059669",
    glow1: "rgba(16,185,129,0.20)",
    glow2: "rgba(6,182,212,0.12)",
    textAccent: "#6ee7b7",
  },
  {
    id: "neon",
    name: "Neon",
    bg: "#0d0a1a",
    card: "rgba(139,92,246,0.06)",
    border: "rgba(139,92,246,0.18)",
    accent: "#8b5cf6",
    accent2: "#d946ef",
    glow1: "rgba(139,92,246,0.25)",
    glow2: "rgba(217,70,239,0.15)",
    textAccent: "#c4b5fd",
  },
  {
    id: "crimson",
    name: "Crimson",
    bg: "#150a0a",
    card: "rgba(239,68,68,0.06)",
    border: "rgba(239,68,68,0.18)",
    accent: "#ef4444",
    accent2: "#dc2626",
    glow1: "rgba(239,68,68,0.20)",
    glow2: "rgba(249,115,22,0.12)",
    textAccent: "#fca5a5",
  },
];

export const LS_THEME_ID = "staredown_theme_id_v1";
export const LS_CUSTOM_THEME = "staredown_custom_theme_v1";

export function getStoredThemeId(): string {
  if (typeof window === "undefined") return "midnight";
  return localStorage.getItem(LS_THEME_ID) || "midnight";
}

export function getThemeById(id: string): ThemePreset {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

export function getCurrentTheme(): ThemePreset {
  const id = getStoredThemeId();
  if (id === "custom") {
    try {
      const raw = localStorage.getItem(LS_CUSTOM_THEME);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return getThemeById(id);
}

export function setThemeId(id: string) {
  if (typeof window !== "undefined") localStorage.setItem(LS_THEME_ID, id);
}

export function setCustomTheme(theme: ThemePreset) {
  if (typeof window !== "undefined") {
    localStorage.setItem(LS_CUSTOM_THEME, JSON.stringify(theme));
    localStorage.setItem(LS_THEME_ID, "custom");
  }
}
