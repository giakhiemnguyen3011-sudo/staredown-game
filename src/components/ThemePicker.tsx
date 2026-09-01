"use client";
import { useEffect, useState } from "react";
import { THEMES, getCurrentTheme, getStoredThemeId, setThemeId, setCustomTheme, ThemePreset } from "@/lib/theme";

export default function ThemePicker({ onChange }: { onChange?: (t: ThemePreset) => void }) {
  const [activeId, setActiveId] = useState<string>("midnight");
  const [customBg, setCustomBg] = useState("#070a14");
  const [customAccent, setCustomAccent] = useState("#6366f1");
  const [customBorder, setCustomBorder] = useState("#ffffff1a");

  useEffect(() => {
    setActiveId(getStoredThemeId());
    const cur = getCurrentTheme();
    if (cur.id === "custom") {
      // already custom
    }
  }, []);

  const handleSelect = (id: string) => {
    setActiveId(id);
    setThemeId(id);
    const t = THEMES.find(x => x.id === id) || THEMES[0];
    onChange?.(t);
    // force reload styles
    if (typeof window !== "undefined") window.dispatchEvent(new Event("theme-change"));
  };

  const handleCustom = () => {
    const custom: ThemePreset = {
      id: "custom",
      name: "Tùy chỉnh",
      bg: customBg,
      card: `${customAccent}14`,
      border: customBorder,
      accent: customAccent,
      accent2: customAccent,
      glow1: `${customAccent}33`,
      glow2: `${customBg}66`,
      textAccent: customAccent,
    };
    setCustomTheme(custom);
    setActiveId("custom");
    onChange?.(custom);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("theme-change"));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {THEMES.map(t => (
          <button
            key={t.id}
            onClick={() => handleSelect(t.id)}
            className={`p-3 rounded-xl border text-left transition ${activeId === t.id ? "border-white/30 bg-white/10 ring-1 ring-white/20" : "border-white/10 bg-white/5 hover:bg-white/10"}`}
          >
            <div className="w-full h-8 rounded-lg mb-2" style={{ background: `linear-gradient(135deg, ${t.accent}, ${t.accent2})` }} />
            <div className="text-xs font-bold truncate">{t.name}</div>
            <div className="text-[11px] text-white/50 truncate">{t.bg}</div>
          </button>
        ))}
        <button
          onClick={handleCustom}
          className={`p-3 rounded-xl border text-left transition ${activeId === "custom" ? "border-white/30 bg-white/10 ring-1 ring-white/20" : "border-white/10 bg-white/5 hover:bg-white/10"}`}
        >
          <div className="w-full h-8 rounded-lg mb-2 flex items-center justify-center text-xs font-bold" style={{ background: `linear-gradient(135deg, ${customAccent}, ${customBg})`, border: `1px solid ${customBorder}` }}>TÙY CHỈNH</div>
          <div className="text-xs font-bold">Tùy chỉnh</div>
          <div className="text-[11px] text-white/50">Chọn màu</div>
        </button>
      </div>
      {activeId === "custom" && (
        <div className="p-3 rounded-xl bg-white/5 border border-white/10 space-y-2">
          <div className="text-xs font-bold">Tùy chỉnh màu</div>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-20">Nền</span>
            <input type="color" value={customBg} onChange={e => setCustomBg(e.target.value)} className="w-8 h-8 rounded" />
            <span className="font-mono">{customBg}</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-20">Accent</span>
            <input type="color" value={customAccent} onChange={e => setCustomAccent(e.target.value)} className="w-8 h-8 rounded" />
            <span className="font-mono">{customAccent}</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-20">Viền</span>
            <input type="color" value={customBorder} onChange={e => setCustomBorder(e.target.value.slice(0,7))} className="w-8 h-8 rounded" />
            <button onClick={handleCustom} className="ml-auto px-3 py-1 rounded-full bg-white text-black text-xs font-bold">Áp dụng</button>
          </label>
        </div>
      )}
    </div>
  );
}
