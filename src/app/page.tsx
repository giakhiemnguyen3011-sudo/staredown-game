"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useFaceLandmarker } from "@/hooks/useFaceLandmarker";
import { calcAvgEAR, EARSmoother, formatDuration } from "@/lib/ear";
import { getSupabase, fetchHighScores, submitHighScore, HighScore } from "@/lib/supabase";
import EyeOverlay from "@/components/EyeOverlay";

// ---------- Types ----------
type GameMode = "menu" | "single" | "multi";
type GamePhase = "idle" | "requesting" | "ready" | "countdown" | "playing" | "finished";

type LocalScore = { name: string; durationMs: number; date: string };

// ---------- Helpers ----------
const LS_KEY = "staredown_highscores_v1";
const LS_NAME_KEY = "staredown_player_name";

function loadLocalScores(): LocalScore[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as LocalScore[]) : [];
  } catch { return []; }
}
function saveLocalScore(entry: LocalScore) {
  const arr = loadLocalScores();
  arr.push(entry);
  arr.sort((a, b) => b.durationMs - a.durationMs);
  localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, 50)));
}

export default function Page() {
  // Navigation
  const [mode, setMode] = useState<GameMode>("menu");
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [countdown, setCountdown] = useState<number>(3);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [winner, setWinner] = useState<null | 1 | 2 | "draw">(null);
  const [bestSingleMs, setBestSingleMs] = useState(0);

  // Settings
  const [earThreshold, setEarThreshold] = useState(0.22);
  const [showDebug, setShowDebug] = useState(true);
  const [playerName, setPlayerName] = useState("Player");
  const [supabaseReady, setSupabaseReady] = useState(false);
  const [highScores, setHighScores] = useState<HighScore[]>([]);
  const [localScores, setLocalScores] = useState<LocalScore[]>([]);

  // Video / MediaPipe
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const { state: lmState } = useFaceLandmarker(mode === "multi" ? 2 : 2);
  const landmarkerReady = lmState.status === "ready";

  const [fps, setFps] = useState(0);
  const [faceCount, setFaceCount] = useState(0);
  const [earValues, setEarValues] = useState<number[]>([]);
  const [blinkStates, setBlinkStates] = useState<("open" | "closing" | "closed")[]>([]);
  const [landmarksForOverlay, setLandmarksForOverlay] = useState<{ x: number; y: number }[][]>([]);
  const [videoSize, setVideoSize] = useState({ w: 640, h: 480 });
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Blink detection refs (avoid re-render thrashing)
  const smootherRefs = useRef<EARSmoother[]>([new EARSmoother(5), new EARSmoother(5)]);
  const closedFramesRef = useRef<number[]>([0, 0]);
  const openFramesRef = useRef<number[]>([0, 0]);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());
  const lastFpsFramesRef = useRef(0);

  // Load local data
  useEffect(() => {
    setLocalScores(loadLocalScores());
    const savedName = typeof window !== "undefined" ? localStorage.getItem(LS_NAME_KEY) : null;
    if (savedName) setPlayerName(savedName);
    setSupabaseReady(!!getSupabase());
    fetchHighScores(10).then(setHighScores).catch(() => {});
    const best = loadLocalScores()[0]?.durationMs ?? 0;
    setBestSingleMs(best);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(LS_NAME_KEY, playerName);
  }, [playerName]);

  // Camera lifecycle
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user", frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      // wait for metadata
      if (video.videoWidth) setVideoSize({ w: video.videoWidth, h: video.videoHeight });
      else {
        await new Promise<void>(res => {
          const onLoaded = () => { setVideoSize({ w: video.videoWidth, h: video.videoHeight }); res(); };
          video.addEventListener("loadedmetadata", onLoaded, { once: true });
          setTimeout(() => res(), 1500);
        });
      }
      setPhase("ready");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setCameraError(msg.includes("Permission") ? "Bạn đã từ chối quyền camera. Hãy cho phép trong trình duyệt." : msg);
      setPhase("idle");
    }
  }, []);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    if (mode === "menu") {
      stopCamera();
      setPhase("idle");
      setElapsedMs(0);
      setWinner(null);
      smootherRefs.current.forEach(s => s.reset());
      closedFramesRef.current = [0, 0];
      openFramesRef.current = [0, 0];
      setBlinkStates([]);
      setLandmarksForOverlay([]);
      setEarValues([]);
      setFaceCount(0);
    } else {
      startCamera();
    }
    return () => { /* keep camera when switching between single/multi? we handle */ };
  }, [mode, startCamera, stopCamera]);

  // Countdown effect
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      // GO!
      startTimeRef.current = performance.now();
      elapsedRef.current = 0;
      setElapsedMs(0);
      setPhase("playing");
      smootherRefs.current.forEach(s => s.reset());
      closedFramesRef.current = [0, 0];
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 900);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const triggerCountdown = useCallback(() => {
    if (!landmarkerReady) return;
    if (phase !== "ready" && phase !== "finished") return;
    setCountdown(3);
    setPhase("countdown");
    setElapsedMs(0);
    setWinner(null);
    closedFramesRef.current = [0, 0];
    openFramesRef.current = [0, 0];
    smootherRefs.current.forEach(s => s.reset());
  }, [landmarkerReady, phase]);

  // Timer tick while playing
  useEffect(() => {
    if (phase !== "playing") return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const e = now - startTimeRef.current;
      elapsedRef.current = e;
      setElapsedMs(e);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // MediaPipe loop - stable realtime tracking
  useEffect(() => {
    if (!landmarkerReady || lmState.status !== "ready") return;
    const video = videoRef.current;
    if (!video) return;
    const landmarker = lmState.landmarker;

    let running = true;

    const REQUIRED_CLOSED_FRAMES = 3; // ~100ms @30fps, faster blink detection
    const REQUIRED_OPEN_FRAMES = 2;

    const loop = () => {
      if (!running) return;
      rafRef.current = requestAnimationFrame(loop);

      if (!video || video.readyState < 2 || video.paused || video.ended) return;
      const nowMs = performance.now();

      try {
        const result = landmarker.detectForVideo(video, nowMs);
        const faces = result.faceLandmarks ?? [];
        const blendshapes = result.faceBlendshapes ?? [];

        // Sort faces left-to-right for stable P1/P2 assignment
        const indexed = faces.map((lm, i) => ({ lm, i, blend: blendshapes[i], x: lm[1]?.x ?? 0 }))
          .sort((a, b) => a.x - b.x);

        const sortedLandmarks = indexed.map(o => o.lm);
        setLandmarksForOverlay(sortedLandmarks);
        setFaceCount(faces.length);

        // FPS calc
        frameCountRef.current++;
        if (nowMs - lastFpsTimeRef.current > 800) {
          const frames = frameCountRef.current - lastFpsFramesRef.current;
          const dt = (nowMs - lastFpsTimeRef.current) / 1000;
          setFps(Math.round(frames / dt));
          lastFpsTimeRef.current = nowMs;
          lastFpsFramesRef.current = frameCountRef.current;
        }

        if (phase !== "playing") {
          // Preview EAR even when not playing
          const previewEars = sortedLandmarks.map(lm => calcAvgEAR(lm as never));
          setEarValues(previewEars);
          const previewStates = sortedLandmarks.map(() => "open" as const);
          setBlinkStates(previewStates);
          return;
        }

        const newEars: number[] = [];
        const newStates: ("open" | "closing" | "closed")[] = [];
        const blinkedIndices: number[] = [];

        sortedLandmarks.forEach((lm, sortedIdx) => {
          const rawEar = calcAvgEAR(lm as never);
          // blendshape check
          const blend = indexed[sortedIdx]?.blend;
          let blendClosed = false;
          if (blend?.categories) {
            const left = blend.categories.find(c => c.categoryName === "eyeBlinkLeft");
            const right = blend.categories.find(c => c.categoryName === "eyeBlinkRight");
            const avgBlend = ((left?.score ?? 0) + (right?.score ?? 0)) / 2;
            blendClosed = avgBlend > 0.5;
            // Debug: if blend very high, treat as closed regardless of EAR
            if (avgBlend > 0.65) blendClosed = true;
          }
          const smoother = smootherRefs.current[sortedIdx] ?? (smootherRefs.current[sortedIdx] = new EARSmoother(5));
          const ear = smoother.push(rawEar);
          newEars.push(ear);

          const isClosedByEar = ear < earThreshold;
          const isClosed = isClosedByEar || blendClosed;

          if (isClosed) {
            closedFramesRef.current[sortedIdx] = (closedFramesRef.current[sortedIdx] ?? 0) + 1;
            openFramesRef.current[sortedIdx] = 0;
          } else {
            openFramesRef.current[sortedIdx] = (openFramesRef.current[sortedIdx] ?? 0) + 1;
            if (openFramesRef.current[sortedIdx] >= REQUIRED_OPEN_FRAMES) {
              closedFramesRef.current[sortedIdx] = 0;
            }
          }

          const closedFrames = closedFramesRef.current[sortedIdx] ?? 0;
          let st: "open" | "closing" | "closed" = "open";
          if (closedFrames >= REQUIRED_CLOSED_FRAMES) st = "closed";
          else if (closedFrames >= 1) st = "closing";
          newStates.push(st);

          if (st === "closed") blinkedIndices.push(sortedIdx);
        });

        setEarValues(newEars);
        setBlinkStates(newStates);

        if (blinkedIndices.length > 0 && phase === "playing") {
          // Debounce: finish game
          handleBlinkDetected(blinkedIndices, newEars);
        }

      } catch (err) {
        console.warn("[detect] error", err);
      }
    };

    const handleBlinkDetected = (indices: number[], _ears: number[]) => {
      // Avoid double trigger
      if (phase !== "playing") return;
      // Single player: any blink ends
      if (mode === "single") {
        const duration = elapsedRef.current;
        setPhase("finished");
        setBestSingleMs(prev => Math.max(prev, duration));
        // Save highscore deferred to effect after render? Do now but not block
        // Will be handled by UI save prompt
        // Vibration feedback
        try { navigator.vibrate?.(120); } catch {}
      } else {
        // Multiplayer: 1 face => that player lost
        // 2 faces => first to blink loses; if both same frame => draw
        if (indices.length === 2) setWinner("draw");
        else if (indices.length === 1) setWinner(indices[0] === 0 ? 2 : 1); // sorted left is P1, so if P1 blinked, P2 wins
        else setWinner(null);
        setPhase("finished");
        try { navigator.vibrate?.([80, 40, 80]); } catch {}
      }
    };

    // Start loop
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [landmarkerReady, lmState, phase, mode, earThreshold]);

  // Save handlers
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  useEffect(() => {
    if (phase === "finished" && mode === "single" && elapsedRef.current > 500) {
      setShowSaveDialog(true);
    } else if (phase !== "finished") {
      setShowSaveDialog(false);
    }
  }, [phase, mode]);

  const handleSaveScore = useCallback(async () => {
    const dur = Math.round(elapsedRef.current);
    if (dur < 500) return;
    const entry: LocalScore = { name: playerName.trim() || "Anonymous", durationMs: dur, date: new Date().toISOString() };
    saveLocalScore(entry);
    setLocalScores(loadLocalScores());
    setBestSingleMs(loadLocalScores()[0]?.durationMs ?? dur);
    // Supabase
    if (getSupabase()) {
      const res = await submitHighScore(entry.name, dur);
      if (!res.error) {
        const updated = await fetchHighScores(10);
        setHighScores(updated);
      }
    }
    setShowSaveDialog(false);
  }, [playerName]);

  const handleDiscard = useCallback(() => setShowSaveDialog(false), []);

  // Cleanup on unmount
  useEffect(() => () => stopCamera(), [stopCamera]);

  // ---------- Render ----------
  return (
    <div className="min-h-screen flex flex-col bg-[#070a14] text-white selection:bg-indigo-500/30">
      {/* Background glows */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-[30%] -left-[20%] w-[80%] h-[80%] rounded-full blur-[120px] opacity-20 bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600" />
        <div className="absolute -bottom-[30%] -right-[20%] w-[80%] h-[80%] rounded-full blur-[120px] opacity-15 bg-gradient-to-br from-cyan-600 via-blue-600 to-indigo-600" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff06_1px,transparent_1px),linear-gradient(to_bottom,#ffffff06_1px,transparent_1px)] bg-[size:56px_56px]" />
      </div>

      {/* Header */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-[#070a14]/70 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-[64px] flex items-center justify-between gap-4">
          <button onClick={() => setMode("menu")} className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 group-hover:scale-105 transition">
              <span className="text-[18px]">👁️</span>
            </div>
            <div className="text-left">
              <div className="font-black tracking-tight leading-none text-[17px]">STAREDOWN</div>
              <div className="text-[11px] tracking-[0.18em] text-white/60 -mt-0.5">EYE TRACKING GAME</div>
            </div>
          </button>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:flex items-center gap-2 text-xs">
              <span className={`w-2 h-2 rounded-full ${landmarkerReady ? "bg-emerald-400 shadow shadow-emerald-400/50" : lmState.status === "loading" ? "bg-amber-400 animate-pulse" : "bg-red-400"}`} />
              <span className="text-white/70">
                {lmState.status === "ready" ? "MediaPipe Ready" : lmState.status === "loading" ? "Loading model..." : lmState.status === "error" ? "Model error" : "Idle"}
              </span>
              <span className="text-white/20">•</span>
              <span className="text-white/70">{fps} FPS</span>
              <span className="text-white/20">•</span>
              <span className={`${supabaseReady ? "text-emerald-300" : "text-white/50"}`}>{supabaseReady ? "Supabase ●" : "Local only"}</span>
            </div>
            <a href="https://github.com" target="_blank" className="hidden sm:inline-flex text-xs px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 transition">Vercel Ready ▲</a>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {mode === "menu" && (
          <div className="space-y-8 animate-[fadeIn_0.4s]">
            {/* Hero */}
            <div className="relative overflow-hidden rounded-[28px] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] backdrop-blur p-6 sm:p-10">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/20 via-transparent to-fuchsia-600/10 pointer-events-none" />
              <div className="relative grid lg:grid-cols-[1.2fr_0.8fr] gap-8 items-center">
                <div>
                  <div className="inline-flex items-center gap-2 text-xs tracking-widest font-semibold px-3 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" /> REALTIME EYE TRACKING • MEDIAPIPE
                  </div>
                  <h1 className="mt-4 text-4xl sm:text-5xl font-black tracking-tight leading-[0.95]">
                    AI CHỚP MẮT<br />
                    <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">TRƯỚC SẼ THUA</span>
                  </h1>
                  <p className="mt-4 text-white/70 leading-relaxed max-w-xl">
                    Sử dụng camera &amp; MediaPipe FaceLandmarker để track mắt theo thời gian thực 30 FPS. Thử thách khả năng kiềm chế chớp mắt — chơi đơn phá kỷ lục hoặc so tài trực tiếp 2 người trên 1 máy.
                  </p>
                  <div className="mt-6 grid grid-cols-3 gap-3 max-w-md">
                    <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                      <div className="text-[11px] tracking-widest text-white/50">BEST</div>
                      <div className="font-mono font-bold text-lg">{bestSingleMs ? formatDuration(bestSingleMs) : "--"}</div>
                    </div>
                    <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                      <div className="text-[11px] tracking-widest text-white/50">GAMES</div>
                      <div className="font-mono font-bold text-lg">{localScores.length}</div>
                    </div>
                    <div className="rounded-2xl bg-white/5 border border-white/10 p-3 text-center">
                      <div className="text-[11px] tracking-widest text-white/50">MODELS</div>
                      <div className="font-mono font-bold text-lg text-emerald-300">478 pts</div>
                    </div>
                  </div>
                </div>

                <div className="relative">
                  <div className="rounded-[22px] overflow-hidden border border-white/10 bg-black/40 backdrop-blur aspect-[4/3] flex items-center justify-center p-6">
                    <div className="w-full space-y-4">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-20 h-20 rounded-full border-2 border-indigo-500/50 bg-gradient-to-br from-indigo-500/20 to-violet-500/20 flex items-center justify-center text-3xl animate-[pulse-eye_2s_infinite]">👁️</div>
                        <div className="w-20 h-20 rounded-full border-2 border-fuchsia-500/50 bg-gradient-to-br from-fuchsia-500/20 to-pink-500/20 flex items-center justify-center text-3xl animate-[pulse-eye_2s_0.3s_infinite]">👁️</div>
                      </div>
                      <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full w-[68%] bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full animate-pulse" />
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-xl bg-emerald-500/15 border border-emerald-500/20 p-2.5 text-center">
                          <div className="text-emerald-300 font-semibold">EAR 0.31</div>
                          <div className="text-white/60">Mắt mở</div>
                        </div>
                        <div className="rounded-xl bg-red-500/15 border border-red-500/20 p-2.5 text-center">
                          <div className="text-red-300 font-semibold">EAR 0.14</div>
                          <div className="text-white/60">Đã chớp ⚡</div>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="absolute -bottom-3 left-3 right-3 h-6 bg-gradient-to-t from-black/40 to-transparent blur-xl pointer-events-none" />
                </div>
              </div>
            </div>

            {/* Mode cards */}
            <div className="grid md:grid-cols-2 gap-5">
              {/* Single */}
              <button onClick={() => setMode("single")} className="group text-left relative overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-indigo-600/25 via-violet-600/15 to-transparent backdrop-blur p-6 sm:p-7 hover:border-indigo-400/30 hover:from-indigo-600/30 transition">
                <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/20 blur-[40px] rounded-full group-hover:bg-indigo-500/30 transition" />
                <div className="relative">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500 flex items-center justify-center text-xl shadow-lg shadow-indigo-500/20">🎯</div>
                  <h3 className="mt-4 text-xl font-extrabold">Local Highscore</h3>
                  <p className="text-sm text-white/65 mt-1">1 người • 1 máy • Phá kỷ lục thời gian không chớp mắt. Lưu local + Supabase.</p>
                  <ul className="mt-4 space-y-1.5 text-xs text-white/70">
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Countdown 3-2-1 rồi tính giờ</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Tự động lưu top 10 + Supabase</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Hiển thị EAR & debug overlay</li>
                  </ul>
                  <div className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#070a14] font-bold text-sm group-hover:translate-x-0.5 transition">
                    Chơi đơn <span>→</span>
                  </div>
                </div>
              </button>

              {/* Multi */}
              <button onClick={() => setMode("multi")} className="group text-left relative overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-fuchsia-600/25 via-pink-600/15 to-transparent backdrop-blur p-6 sm:p-7 hover:border-fuchsia-400/30 hover:from-fuchsia-600/30 transition">
                <div className="absolute top-0 right-0 w-32 h-32 bg-fuchsia-500/20 blur-[40px] rounded-full group-hover:bg-fuchsia-500/30 transition" />
                <div className="relative">
                  <div className="w-12 h-12 rounded-2xl bg-fuchsia-500 flex items-center justify-center text-xl shadow-lg shadow-fuchsia-500/20">⚔️</div>
                  <h3 className="mt-4 text-xl font-extrabold">Local Multiplayer</h3>
                  <p className="text-sm text-white/65 mt-1">2 người • 1 máy • 1 camera • Ai chớp trước sẽ thua. Track 2 khuôn mặt.</p>
                  <ul className="mt-4 space-y-1.5 text-xs text-white/70">
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Phân biệt P1 (trái) &amp; P2 (phải)</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Xử lý hòa khi chớp cùng lúc</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Khung viền báo trạng thái từng người</li>
                  </ul>
                  <div className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#070a14] font-bold text-sm group-hover:translate-x-0.5 transition">
                    Đấu 2 người <span>→</span>
                  </div>
                </div>
              </button>
            </div>

            {/* Bottom grid */}
            <div className="grid lg:grid-cols-3 gap-5">
              {/* How to play */}
              <div className="lg:col-span-2 rounded-[24px] border border-white/10 bg-white/[0.04] backdrop-blur p-6">
                <h4 className="font-bold flex items-center gap-2"> <span className="w-7 h-7 rounded-lg bg-white/10 flex items-center justify-center text-sm">📋</span> Cách chơi &amp; Tips ổn định</h4>
                <div className="mt-4 grid sm:grid-cols-3 gap-4 text-sm">
                  <div className="space-y-1.5">
                    <div className="text-white font-semibold">1. Chuẩn bị</div>
                    <p className="text-white/60 leading-relaxed">Ngồi thẳng, mặt đủ sáng, cách camera 50-70cm. Một camera có thể track 2 người đứng cạnh nhau.</p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-white font-semibold">2. Bắt đầu</div>
                    <p className="text-white/60 leading-relaxed">Bấm “Bắt đầu”, chờ đếm 3-2-1, giữ mắt mở. Hệ thống dùng EAR + blendshape để phát hiện chớp.</p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-white font-semibold">3. Ổn định</div>
                    <p className="text-white/60 leading-relaxed">Giữ ngưỡng EAR mặc định 0.22. Nếu mắt nhỏ / đeo kính, hạ xuống 0.18. Bật debug để xem overlay.</p>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2 text-xs">
                  <span className="px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/20 text-amber-200">⚠️ Không đeo kính râm</span>
                  <span className="px-3 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/20 text-indigo-200">💡 Ánh sáng đều, tránh ngược sáng</span>
                  <span className="px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200">🎥 30 FPS • 1280x720</span>
                </div>
              </div>

              {/* Leaderboard preview */}
              <div className="rounded-[24px] border border-white/10 bg-white/[0.04] backdrop-blur p-6">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold flex items-center gap-2"><span className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center">🏆</span> Highscore</h4>
                  <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10">{localScores.length} lượt</span>
                </div>
                <div className="mt-4 space-y-2 max-h-[220px] overflow-auto pr-1">
                  {localScores.length === 0 ? (
                    <div className="text-sm text-white/50 py-8 text-center border border-dashed border-white/10 rounded-xl">Chưa có kỷ lục — hãy chơi và phá đảo!</div>
                  ) : localScores.slice(0, 5).map((s, i) => (
                    <div key={i} className="flex items-center gap-3 p-2.5 rounded-xl bg-white/5 border border-white/5">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-black ${i === 0 ? "bg-amber-400 text-black" : i === 1 ? "bg-zinc-300 text-black" : i === 2 ? "bg-amber-700 text-white" : "bg-white/10"}`}>{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{s.name}</div>
                        <div className="text-xs text-white/50">{new Date(s.date).toLocaleDateString("vi-VN")}</div>
                      </div>
                      <div className="font-mono font-bold text-indigo-300">{formatDuration(s.durationMs)}</div>
                    </div>
                  ))}
                </div>
                {localScores.length > 5 && <div className="mt-3 text-xs text-white/50 text-center">+ {localScores.length - 5} kỷ lục khác trong máy</div>}

                {/* Supabase list */}
                {highScores.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-white/10">
                    <div className="text-xs tracking-widest text-white/50">SUPABASE GLOBAL</div>
                    <div className="mt-2 space-y-1.5">
                      {highScores.slice(0, 3).map(h => (
                        <div key={h.id} className="flex justify-between text-xs bg-indigo-500/10 border border-indigo-500/15 rounded-lg px-2.5 py-1.5">
                          <span className="truncate">{h.player_name}</span><span className="font-mono">{formatDuration(h.duration_ms)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Settings bar */}
            <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-4 sm:p-5 flex flex-wrap gap-4 items-center justify-between">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-3 text-sm">
                  <span className="text-white/70">Tên hiển thị:</span>
                  <input value={playerName} onChange={e => setPlayerName(e.target.value)} maxLength={18} placeholder="Player" className="px-3 py-1.5 rounded-full bg-white/10 border border-white/15 focus:border-indigo-400 outline-none w-[140px]" />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} className="accent-indigo-500" />
                  <span className="text-white/70">Hiện overlay mắt</span>
                </label>
              </div>
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <span className="text-xs text-white/60 whitespace-nowrap">Ngưỡng EAR: {earThreshold.toFixed(2)}</span>
                <input type="range" min={0.15} max={0.30} step={0.01} value={earThreshold} onChange={e => setEarThreshold(parseFloat(e.target.value))} className="flex-1 sm:w-40 accent-indigo-500" />
                <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10 hidden sm:inline">Mắt nhỏ → giảm</span>
              </div>
            </div>

            <div className="text-center text-xs text-white/35 pb-4">
              Deploy sẵn sàng cho Vercel • Thêm biến môi trường <code className="px-1.5 py-0.5 rounded bg-white/10 border border-white/10">NEXT_PUBLIC_SUPABASE_URL</code> &amp; <code className="px-1.5 py-0.5 rounded bg-white/10 border border-white/10">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> • SQL ở <code className="px-1 py-0.5 rounded bg-white/10">supabase.sql</code>
            </div>
          </div>
        )}

        {(mode === "single" || mode === "multi") && (
          <div className="space-y-5">
            {/* Top bar actions */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button onClick={() => setMode("menu")} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-sm transition">← Về menu</button>
              <div className="flex items-center gap-2 text-xs">
                <span className={`px-3 py-1.5 rounded-full border text-xs font-semibold ${phase === "playing" ? "bg-emerald-500 text-white border-emerald-400 animate-pulse" : phase === "countdown" ? "bg-amber-500 text-black border-amber-400" : phase === "finished" ? "bg-red-500 text-white border-red-400" : "bg-white/10 border-white/10"}`}>
                  {phase === "idle" && "Chờ camera"}
                  {phase === "requesting" && "Đang xin quyền camera..."}
                  {phase === "ready" && "Sẵn sàng"}
                  {phase === "countdown" && `Chuẩn bị... ${countdown}`}
                  {phase === "playing" && "● ĐANG CHƠI"}
                  {phase === "finished" && "Kết thúc"}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
                  <span className={`w-2 h-2 rounded-full ${faceCount > 0 ? "bg-emerald-400" : "bg-white/30"}`} /> {faceCount} khuôn mặt • {fps} FPS
                </span>
                {mode === "multi" && <span className="px-3 py-1.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/20 text-fuchsia-200">P1 trái • P2 phải</span>}
              </div>
            </div>

            {/* Main game card */}
            <div className="grid lg:grid-cols-[1.45fr_0.85fr] gap-5">
              {/* Video area */}
              <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-black/60 backdrop-blur">
                {/* Video + overlay container */}
                <div className="relative aspect-[16/10] sm:aspect-[16/10] bg-[#0a0f1e] overflow-hidden">
                  <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className="w-full h-full object-cover"
                    style={{ transform: "scaleX(-1)" }}
                  />
                  {showDebug && faceCount > 0 && (
                    <EyeOverlay landmarks={landmarksForOverlay} videoWidth={videoSize.w} videoHeight={videoSize.h} blinkState={blinkStates} />
                  )}

                  {/* Scanline when playing */}
                  {phase === "playing" && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-20">
                      <div className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-[scanline_2s_linear_infinite]" style={{ animationName: "scanline" } as never} />
                    </div>
                  )}

                  {/* Center countdown */}
                  {phase === "countdown" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px]">
                      <div className="text-[92px] sm:text-[120px] font-black leading-none tracking-tighter text-white drop-shadow-[0_8px_30px_rgba(99,102,241,0.6)] animate-[pulse-eye_0.9s_ease_infinite]">{countdown === 0 ? "GO!" : countdown}</div>
                      <div className="text-sm tracking-[0.3em] text-white/70 mt-2">ĐỪNG CHỚP MẮT</div>
                    </div>
                  )}

                  {/* Finished overlay */}
                  {phase === "finished" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
                      <div className="w-full max-w-md rounded-[20px] border border-white/15 bg-[#0f1220]/90 backdrop-blur p-5 sm:p-6 text-center shadow-2xl">
                        {mode === "single" ? (
                          <>
                            <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-xl">⏱️</div>
                            <div className="mt-3 text-xs tracking-[0.2em] text-white/60">THỜI GIAN CỦA BẠN</div>
                            <div className="mt-1 font-mono font-black text-4xl tracking-tight">{formatDuration(Math.round(elapsedMs))}</div>
                            <div className="text-xs text-white/50 mt-1">Kỷ lục hiện tại: {bestSingleMs ? formatDuration(bestSingleMs) : "--"}</div>
                            {elapsedMs >= bestSingleMs && elapsedMs > 800 && <div className="mt-2 inline-flex px-3 py-1 rounded-full bg-amber-400 text-black text-xs font-bold">🎉 KỶ LỤC MỚI!</div>}
                          </>
                        ) : (
                          <>
                            <div className="text-4xl">{winner === "draw" ? "🤝" : winner ? "🏆" : "👁️"}</div>
                            <div className="mt-2 font-black text-2xl">
                              {winner === 1 && "P1 THẮNG!"}
                              {winner === 2 && "P2 THẮNG!"}
                              {winner === "draw" && "HÒA NHAU!"}
                              {!winner && "KẾT THÚC"}
                            </div>
                            <div className="text-sm text-white/60 mt-1">
                              {winner === 1 && "P2 đã chớp mắt trước"}
                              {winner === 2 && "P1 đã chớp mắt trước"}
                              {winner === "draw" && "Cả hai chớp cùng lúc!"}
                              {!winner && `Thời gian: ${formatDuration(Math.round(elapsedMs))}`}
                            </div>
                            <div className="mt-1 font-mono text-white/80">{formatDuration(Math.round(elapsedMs))}</div>
                          </>
                        )}
                        <div className="mt-5 grid grid-cols-2 gap-2.5">
                          <button onClick={triggerCountdown} className="py-2.5 rounded-full bg-white text-black font-bold text-sm hover:bg-zinc-100 transition">Chơi lại</button>
                          <button onClick={() => setMode("menu")} className="py-2.5 rounded-full bg-white/10 border border-white/15 font-bold text-sm hover:bg-white/15 transition">Menu</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Top info bar inside video */}
                  <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full bg-black/55 backdrop-blur border border-white/15 text-xs font-mono">{faceCount === 0 ? "Không thấy mặt" : faceCount === 1 ? "1 mặt" : `${faceCount} mặt`} </span>
                      {phase === "playing" && <span className="hidden sm:inline-flex px-2.5 py-1 rounded-full bg-emerald-500/90 text-white text-xs font-bold">● LIVE</span>}
                    </div>
                    <div className="hidden sm:flex items-center gap-1.5 text-xs">
                      {earValues.map((ear, i) => (
                        <span key={i} className={`px-2.5 py-1 rounded-full border font-mono backdrop-blur ${blinkStates[i] === "closed" ? "bg-red-500 text-white border-red-400" : blinkStates[i] === "closing" ? "bg-amber-500 text-black border-amber-400" : "bg-black/55 border-white/15"}`}>
                          P{i + 1}: {ear.toFixed(2)} {blinkStates[i] === "closed" ? "• CLOSED" : blinkStates[i] === "closing" ? "• ..." : "• OPEN"}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Bottom eye status dots */}
                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                    <div className="flex gap-1.5">
                      {Array.from({ length: mode === "multi" ? 2 : 1 }).map((_, i) => (
                        <div key={i} className={`w-2.5 h-2.5 rounded-full border border-white/20 shadow ${blinkStates[i] === "closed" ? "bg-red-500 shadow-red-500/30" : blinkStates[i] === "closing" ? "bg-amber-400 shadow-amber-400/30" : faceCount > i ? "bg-emerald-400 shadow-emerald-400/30" : "bg-white/20"}`} />
                      ))}
                    </div>
                    <span className="text-[11px] px-2 py-1 rounded-full bg-black/50 border border-white/10 text-white/70">Gương đã lật • ngưỡng {earThreshold.toFixed(2)}</span>
                  </div>
                </div>

                {/* Controls under video */}
                <div className="p-4 sm:p-5 bg-gradient-to-b from-transparent to-white/[0.03] border-t border-white/10 flex flex-wrap gap-2.5 items-center justify-between">
                  <div className="flex flex-wrap gap-2.5">
                    {phase === "ready" && (
                      <button onClick={triggerCountdown} disabled={!landmarkerReady || faceCount === 0} className="px-6 py-2.5 rounded-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-sm shadow-lg shadow-indigo-600/20 transition flex items-center gap-2">
                        ▶ Bắt đầu {mode === "multi" ? "đấu" : ""} {faceCount === 0 ? "(cần thấy mặt)" : ""}
                      </button>
                    )}
                    {phase === "playing" && (
                      <button onClick={() => { setPhase("finished"); setWinner(null); }} className="px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/15 border border-white/15 text-sm font-semibold">Dừng</button>
                    )}
                    {phase === "finished" && (
                      <button onClick={triggerCountdown} className="px-6 py-2.5 rounded-full bg-white text-black font-bold text-sm hover:bg-zinc-100 transition">↻ Chơi lại</button>
                    )}
                    {phase === "idle" && (
                      <button onClick={startCamera} className="px-6 py-2.5 rounded-full bg-white text-black font-bold text-sm">Bật camera</button>
                    )}
                    <button onClick={() => { stopCamera(); setTimeout(startCamera, 250); }} className="px-4 py-2.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-sm">↻ Reload cam</button>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <label className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
                      <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} className="accent-indigo-500" /> Debug
                    </label>
                  </div>
                </div>

                {cameraError && (
                  <div className="mx-4 mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-200 flex gap-2">
                    <span>⚠️</span> <span>{cameraError}</span>
                  </div>
                )}
                {lmState.status === "error" && (
                  <div className="mx-4 mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-200">Không tải được model MediaPipe: {lmState.message}. Thử refresh hoặc kiểm tra mạng/CDN.</div>
                )}
              </div>

              {/* Right panel */}
              <div className="space-y-4">
                {/* Timer card */}
                <div className="rounded-[24px] border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] backdrop-blur p-5 sm:p-6">
                  <div className="flex items-center justify-between">
                    <div className="text-xs tracking-[0.18em] text-white/50 font-semibold">{mode === "single" ? "THỜI GIAN" : "VS TIMER"}</div>
                    <div className={`w-2 h-2 rounded-full ${phase === "playing" ? "bg-emerald-400 animate-pulse shadow shadow-emerald-400/50" : "bg-white/20"}`} />
                  </div>
                  <div className="mt-3 font-mono font-black tracking-tighter leading-none text-[42px] sm:text-[48px] flex items-baseline gap-1">
                    <span className={phase === "playing" ? "text-white" : "text-white/90"}>{formatDuration(Math.round(elapsedMs))}</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-200" style={{ width: `${phase === "playing" ? Math.min(100, (elapsedMs / 60000) * 100) : phase === "finished" ? 100 : 0}%` }} />
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-xl bg-black/30 border border-white/5 p-2.5">
                      <div className="text-[11px] text-white/50">EAR NGƯỠNG</div>
                      <div className="font-mono font-bold text-sm">{earThreshold.toFixed(2)}</div>
                    </div>
                    <div className="rounded-xl bg-black/30 border border-white/5 p-2.5">
                      <div className="text-[11px] text-white/50">FPS</div>
                      <div className="font-mono font-bold text-sm text-emerald-300">{fps}</div>
                    </div>
                    <div className="rounded-xl bg-black/30 border border-white/5 p-2.5">
                      <div className="text-[11px] text-white/50">MẮT</div>
                      <div className={`font-bold text-sm ${blinkStates[0] === "closed" ? "text-red-400" : "text-emerald-300"}`}>{blinkStates[0] ?? "--"}</div>
                    </div>
                  </div>

                  {mode === "single" && (
                    <div className="mt-4 flex items-center gap-2 text-xs">
                      <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="Tên bạn" maxLength={18} className="flex-1 px-3 py-2 rounded-full bg-white/5 border border-white/10 focus:border-indigo-400 outline-none" />
                      <span className="hidden sm:inline text-white/50">để lưu kỷ lục</span>
                    </div>
                  )}
                </div>

                {/* Player statuses for multi */}
                {mode === "multi" ? (
                  <div className="grid grid-cols-2 gap-3">
                    {[0, 1].map(i => {
                      const isClosed = blinkStates[i] === "closed";
                      const isClosing = blinkStates[i] === "closing";
                      const hasFace = faceCount > i;
                      return (
                        <div key={i} className={`rounded-[20px] border p-4 text-center transition ${isClosed ? "bg-red-500/15 border-red-500/40" : isClosing ? "bg-amber-500/15 border-amber-500/30" : hasFace ? "bg-emerald-500/10 border-emerald-500/20" : "bg-white/5 border-white/10"}`}>
                          <div className={`w-10 h-10 mx-auto rounded-xl flex items-center justify-center font-black ${isClosed ? "bg-red-500 text-white" : hasFace ? "bg-white text-black" : "bg-white/10"}`}>P{i + 1}</div>
                          <div className="mt-2 font-bold text-sm">Player {i + 1}</div>
                          <div className={`text-xs mt-1 px-2 py-1 rounded-full inline-flex border ${isClosed ? "bg-red-500 text-white border-red-400" : isClosing ? "bg-amber-400 text-black border-amber-400" : hasFace ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/20" : "bg-white/10 text-white/50 border-white/10"}`}>
                            {hasFace ? (isClosed ? "CHỚP RỒI!" : isClosing ? "Sắp chớp..." : "Đang nhìn") : "Chưa thấy"}
                          </div>
                          <div className="mt-2 font-mono text-xs text-white/60">EAR {earValues[i]?.toFixed(3) ?? "--"}</div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-[20px] border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex items-center justify-between">
                      <h4 className="font-bold text-sm flex items-center gap-2"><span className="w-6 h-6 rounded-lg bg-amber-500/20 flex items-center justify-center text-xs">🏆</span> Top 5 local</h4>
                      <button onClick={() => { if (confirm("Xóa hết kỷ lục local?")) { localStorage.removeItem(LS_KEY); setLocalScores([]); setBestSingleMs(0); } }} className="text-xs px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">Xóa</button>
                    </div>
                    <div className="mt-3 space-y-1.5 max-h-[180px] overflow-auto">
                      {localScores.length === 0 ? <div className="text-xs text-white/50 text-center py-6">Chưa có</div> : localScores.slice(0, 5).map((s, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-sm p-2 rounded-xl bg-white/[0.04] border border-white/5">
                          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${idx === 0 ? "bg-amber-400 text-black" : "bg-white/10"}`}>{idx + 1}</span>
                          <span className="flex-1 truncate">{s.name}</span>
                          <span className="font-mono text-indigo-300">{formatDuration(s.durationMs)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tips */}
                <div className="rounded-[20px] border border-white/10 bg-indigo-500/10 p-4">
                  <div className="text-xs font-bold tracking-widest text-indigo-200">MẸO TRACK ỔN ĐỊNH</div>
                  <ul className="mt-2 space-y-1.5 text-xs text-white/70 leading-relaxed">
                    <li>• Giữ mặt chính diện, không nghiêng quá 30°</li>
                    <li>• Nếu bị false-blink, tăng ngưỡng EAR lên 0.24</li>
                    <li>• Multiplayer: đứng sát nhau 40-60cm, cùng độ cao</li>
                    <li>• Model chạy trên GPU (WASM), lần đầu load ~3-5s</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Save dialog */}
            {showSaveDialog && mode === "single" && phase === "finished" && (
              <div className="rounded-[20px] border border-emerald-500/20 bg-emerald-500/10 p-4 flex flex-wrap gap-3 items-center justify-between">
                <div>
                  <div className="font-bold text-sm text-emerald-200">Lưu kỷ lục {formatDuration(Math.round(elapsedMs))}?</div>
                  <div className="text-xs text-white/60">Sẽ lưu vào máy này và Supabase (nếu đã cấu hình).</div>
                </div>
                <div className="flex gap-2">
                  <button onClick={handleSaveScore} className="px-5 py-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-sm transition">Lưu</button>
                  <button onClick={handleDiscard} className="px-5 py-2 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-sm">Bỏ qua</button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <footer className="mt-auto border-t border-white/5 py-6 text-center text-xs text-white/35">
        <div className="max-w-6xl mx-auto px-4">
          © 2026 Staredown Game • MediaPipe FaceLandmarker 478 pts • Supabase • Deploy on Vercel • <span className="text-white/60">Ổ đĩa D:\staredown-game</span>
        </div>
      </footer>
    </div>
  );
}
