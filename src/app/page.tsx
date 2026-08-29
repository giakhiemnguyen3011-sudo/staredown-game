"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useFaceLandmarker } from "@/hooks/useFaceLandmarker";
import { calcAvgEAR, EARSmoother, formatDuration } from "@/lib/ear";
import { getSupabase, getSupabaseConfigError, fetchHighScores, submitHighScore, HighScore } from "@/lib/supabase";
import EyeOverlay from "@/components/EyeOverlay";

// ---------- Constants ----------
const EAR_THRESHOLD = 0.2; // cố định theo yêu cầu
const SMOOTHER_WINDOW = 3; // nhỏ để phản ứng nhanh
const REQUIRED_CLOSED_FRAMES = 1; // ngay lập tức khi xuống dưới ngưỡng
const REQUIRED_OPEN_FRAMES = 1;
const LOST_FRAMES_THRESHOLD = 8; // ~130ms @60fps, đủ lọc nhiễu nhưng vẫn nhanh
const AUTO_SAVE_MIN_MS = 500;

// ---------- Types ----------
type GameMode = "menu" | "single" | "multi";
type GamePhase = "idle" | "requesting" | "ready" | "countdown" | "playing" | "finished";
type EndReason = "blink" | "tracking_lost" | null;

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
  const [endReason, setEndReason] = useState<EndReason>(null);

  // Settings - EAR cố định 0.2, không cho chỉnh
  const [showDebug, setShowDebug] = useState(true);
  const [playerName, setPlayerName] = useState("Player");
  const [supabaseReady, setSupabaseReady] = useState(false);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [highScores, setHighScores] = useState<HighScore[]>([]);
  const [localScores, setLocalScores] = useState<LocalScore[]>([]);
  const [saveStatus, setSaveStatus] = useState<null | "saving" | "success" | "error">(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [trackingWarning, setTrackingWarning] = useState(false);

  // Video / MediaPipe
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const { state: lmState, init: initLandmarker } = useFaceLandmarker(mode === "multi" ? 2 : 2);
  const landmarkerReady = lmState.status === "ready";

  const [fps, setFps] = useState(0);
  const [faceCount, setFaceCount] = useState(0);
  const [earValues, setEarValues] = useState<number[]>([]);
  const [blinkStates, setBlinkStates] = useState<("open" | "closing" | "closed")[]>([]);
  const [landmarksForOverlay, setLandmarksForOverlay] = useState<{ x: number; y: number }[][]>([]);
  const [videoSize, setVideoSize] = useState({ w: 640, h: 480 });
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Refs để tránh stale closure trong loop
  const phaseRef = useRef<GamePhase>(phase);
  const modeRef = useRef<GameMode>(mode);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // Blink detection refs
  const smootherRefs = useRef<EARSmoother[]>([new EARSmoother(SMOOTHER_WINDOW), new EARSmoother(SMOOTHER_WINDOW)]);
  const closedFramesRef = useRef<number[]>([0, 0]);
  const openFramesRef = useRef<number[]>([0, 0]);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());
  const lastFpsFramesRef = useRef(0);
  const trackingLostFramesRef = useRef(0);
  const hasAutoSavedRef = useRef(false);

  // Load local data
  useEffect(() => {
    setLocalScores(loadLocalScores());
    const savedName = typeof window !== "undefined" ? localStorage.getItem(LS_NAME_KEY) : null;
    if (savedName) setPlayerName(savedName);
    const cfgErr = getSupabaseConfigError();
    setSupabaseError(cfgErr);
    setSupabaseReady(!!getSupabase() && !cfgErr);
    fetchHighScores(10).then(setHighScores).catch((e) => {
      console.warn("fetchHighScores failed", e);
      setSupabaseError(String(e));
    });
    const best = loadLocalScores()[0]?.durationMs ?? 0;
    setBestSingleMs(best);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(LS_NAME_KEY, playerName);
  }, [playerName]);

  // Camera lifecycle - robust cho cả kính/không kính, fallback nếu 60fps không hỗ trợ
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setPhase("requesting");
    setTrackingWarning(false);
    trackingLostFramesRef.current = 0;
    // Thử lần lượt: 1280x720@30 (ổn định nhất) -> 640x480 -> fallback không constraints
    const tries: MediaStreamConstraints[] = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user", frameRate: { ideal: 30 } }, audio: false },
      { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false },
      { video: { facingMode: "user" }, audio: false },
    ];
    let stream: MediaStream | null = null;
    let lastErr: unknown = null;
    for (const constraints of tries) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (e) { lastErr = e; }
    }
    if (!stream) {
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      setCameraError(msg.includes("Permission") ? "Bạn đã từ chối quyền camera. Hãy cho phép trong trình duyệt." : `Không mở được camera: ${msg}`);
      setPhase("idle");
      return;
    }
    try {
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        // Video mount chưa xong, đợi 100ms rồi gán lại
        await new Promise(res => setTimeout(res, 100));
        if (!videoRef.current) {
          setPhase("ready");
          return;
        }
      }
      const v = videoRef.current!;
      v.srcObject = stream;
      // Đảm bảo metadata có trước khi play
      if (v.readyState < 1) {
        await new Promise<void>(res => {
          const onLoaded = () => { res(); };
          v.addEventListener("loadedmetadata", onLoaded, { once: true });
          setTimeout(() => res(), 2000);
        });
      }
      await v.play().catch(() => {
        // Safari cần user gesture, thử lại sau countdown
        console.warn("[camera] play() bị chặn, đợi user click Bắt đầu");
      });
      if (v.videoWidth) setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      setPhase("ready");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setCameraError(`Lỗi camera: ${msg}`);
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
      setEndReason(null);
      setTrackingWarning(false);
      trackingLostFramesRef.current = 0;
      hasAutoSavedRef.current = false;
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
    return () => { /* keep camera when switching */ };
  }, [mode, startCamera, stopCamera]);

  // Countdown effect
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      startTimeRef.current = performance.now();
      elapsedRef.current = 0;
      setElapsedMs(0);
      setPhase("playing");
      setEndReason(null);
      hasAutoSavedRef.current = false;
      trackingLostFramesRef.current = 0;
      setTrackingWarning(false);
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
    setEndReason(null);
    setTrackingWarning(false);
    trackingLostFramesRef.current = 0;
    hasAutoSavedRef.current = false;
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

  // Auto-save local highscore khi single kết thúc (kể cả do blink hay tracking_lost)
  useEffect(() => {
    if (phase !== "finished" || modeRef.current !== "single") return;
    if (hasAutoSavedRef.current) return;
    const dur = Math.round(elapsedRef.current);
    if (dur < AUTO_SAVE_MIN_MS) return;
    hasAutoSavedRef.current = true;
    const entry: LocalScore = { name: playerName.trim() || "Anonymous", durationMs: dur, date: new Date().toISOString() };
    saveLocalScore(entry);
    setLocalScores(loadLocalScores());
    setBestSingleMs(loadLocalScores()[0]?.durationMs ?? dur);
    // Thử lưu Supabase nền, không chặn
    setSaveStatus("saving");
    setSaveErrorMsg(null);
    const cfgErr = getSupabaseConfigError();
    if (cfgErr) {
      setSupabaseError(cfgErr);
      // local đã lưu nên coi như success, nhưng báo supabase lỗi
      setSaveStatus("success");
      return;
    }
    if (getSupabase()) {
      submitHighScore(entry.name, dur).then(async (res) => {
        if (!res.error) {
          const updated = await fetchHighScores(10);
          setHighScores(updated);
          setSaveStatus("success");
          setSupabaseError(null);
        } else {
          setSaveStatus("error");
          setSaveErrorMsg(res.error);
          setSupabaseError(res.error);
        }
      });
    } else {
      setSaveStatus("success");
    }
  }, [phase, playerName]);

  // Reset saveStatus khi rời finished
  useEffect(() => {
    if (phase !== "finished") {
      setSaveStatus(null);
      setSaveErrorMsg(null);
    }
  }, [phase]);

  // MediaPipe loop - tăng tần suất + ngưỡng cố định 0.2 + kết thúc ngay
  useEffect(() => {
    if (!landmarkerReady || lmState.status !== "ready") return;
    const video = videoRef.current;
    if (!video) return;
    const landmarker = lmState.landmarker;

    let running = true;

    const handleBlinkDetected = (indices: number[]) => {
      if (phaseRef.current !== "playing") return;
      if (modeRef.current === "single") {
        setEndReason("blink");
        setPhase("finished");
        setBestSingleMs(prev => Math.max(prev, elapsedRef.current));
        try { navigator.vibrate?.(120); } catch {}
      } else {
        if (indices.length === 2) setWinner("draw");
        else if (indices.length === 1) setWinner(indices[0] === 0 ? 2 : 1);
        else setWinner(null);
        setEndReason("blink");
        setPhase("finished");
        try { navigator.vibrate?.([80, 40, 80]); } catch {}
      }
    };

    const handleTrackingLost = () => {
      if (phaseRef.current !== "playing") return;
      setEndReason("tracking_lost");
      setPhase("finished");
      setTrackingWarning(false);
      // lưu sẽ do effect auto-save xử lý (single). Với multi cũng set finished để hiện lỗi
      try { navigator.vibrate?.([100, 50, 100, 50]); } catch {}
    };

    const loop = () => {
      if (!running) return;
      rafRef.current = requestAnimationFrame(loop);

      if (!video || video.readyState < 2 || video.paused || video.ended) return;
      const nowMs = performance.now();

      try {
        const result = landmarker.detectForVideo(video, nowMs);
        const faces = result.faceLandmarks ?? [];
        const blendshapes = result.faceBlendshapes ?? [];

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

        // Không chơi: preview EAR nhưng vẫn báo mất track
        if (phaseRef.current !== "playing") {
          const previewEars = sortedLandmarks.map(lm => calcAvgEAR(lm as never));
          setEarValues(previewEars);
          setBlinkStates(sortedLandmarks.map(() => "open" as const));
          // warning khi không thấy mặt ở ready/countdown
          if (phaseRef.current === "ready" || phaseRef.current === "countdown") {
            setTrackingWarning(faces.length === 0);
          } else {
            setTrackingWarning(false);
          }
          // reset lost counter when not playing
          trackingLostFramesRef.current = 0;
          return;
        }

        // ĐANG CHƠI: kiểm tra mất track trước
        if (sortedLandmarks.length === 0) {
          trackingLostFramesRef.current += 1;
          setEarValues([]);
          setBlinkStates([]);
          if (trackingLostFramesRef.current >= LOST_FRAMES_THRESHOLD) {
            handleTrackingLost();
          } else {
            setTrackingWarning(true);
          }
          return;
        }
        // có mặt -> reset lost
        trackingLostFramesRef.current = 0;
        setTrackingWarning(false);

        const newEars: number[] = [];
        const newStates: ("open" | "closing" | "closed")[] = [];
        const blinkedIndices: number[] = [];

        sortedLandmarks.forEach((lm, sortedIdx) => {
          const rawEar = calcAvgEAR(lm as never);
          const blend = indexed[sortedIdx]?.blend;
          let blendClosed = false;
          if (blend?.categories) {
            const left = blend.categories.find(c => c.categoryName === "eyeBlinkLeft");
            const right = blend.categories.find(c => c.categoryName === "eyeBlinkRight");
            const avgBlend = ((left?.score ?? 0) + (right?.score ?? 0)) / 2;
            blendClosed = avgBlend > 0.55;
            if (avgBlend > 0.65) blendClosed = true;
          }
          const smoother = smootherRefs.current[sortedIdx] ?? (smootherRefs.current[sortedIdx] = new EARSmoother(SMOOTHER_WINDOW));
          const ear = smoother.push(rawEar);
          newEars.push(ear);

          const isClosedByEar = ear < EAR_THRESHOLD;
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

        if (blinkedIndices.length > 0 && phaseRef.current === "playing") {
          handleBlinkDetected(blinkedIndices);
        }

      } catch (err) {
        console.warn("[detect] error", err);
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [landmarkerReady, lmState]);

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

      {/* Header - gọn */}
      <header className="sticky top-0 z-40 backdrop-blur-xl bg-[#070a14]/70 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-[56px] flex items-center justify-between gap-4">
          <button onClick={() => setMode("menu")} className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 group-hover:scale-105 transition">
              <span className="text-[18px]">👁️</span>
            </div>
            <div className="text-left">
              <div className="font-black tracking-tight leading-none text-[17px]">STAREDOWN</div>
              <div className="text-[11px] tracking-[0.18em] text-white/60 -mt-0.5">EAR 0.20 • 60FPS • MEDIAPIPE</div>
            </div>
          </button>

          <div className="flex items-center gap-2 sm:gap-3 text-xs">
            <span className={`w-2 h-2 rounded-full ${landmarkerReady ? "bg-emerald-400 shadow shadow-emerald-400/50" : lmState.status === "loading" ? "bg-amber-400 animate-pulse" : "bg-red-400"}`} />
            <span className="hidden sm:inline text-white/70">
              {lmState.status === "ready" ? "Sẵn sàng" : lmState.status === "loading" ? "Đang tải model..." : lmState.status === "error" ? "Lỗi model" : "Idle"}
            </span>
            {mode !== "menu" && (
              <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10">
                <span className={`w-1.5 h-1.5 rounded-full ${faceCount > 0 ? "bg-emerald-400" : "bg-red-400 animate-pulse"}`} /> {faceCount} mặt • {fps} FPS
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-7">

        {mode === "menu" && (
          <div className="space-y-5 animate-[fadeIn_0.4s]">
            {/* Hero - gọn */}
            <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] backdrop-blur p-6 sm:p-7">
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/20 via-transparent to-fuchsia-600/10 pointer-events-none" />
              <div className="relative">
                <div className="inline-flex items-center gap-2 text-[11px] tracking-widest font-semibold px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" /> NGƯỠNG EAR CỐ ĐỊNH 0.20 • KẾT THÚC NGAY KHI NHẮM
                </div>
                <h1 className="mt-3 text-3xl sm:text-[40px] font-black tracking-tight leading-[0.95]">
                  AI CHỚP MẮT <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">TRƯỚC SẼ THUA</span>
                </h1>
                <p className="mt-2.5 text-sm text-white/65 leading-relaxed max-w-2xl">
                  Camera 60 FPS • Track liên tục • Tự động lưu kỷ lục. Giữ mắt mở, đừng rời khỏi khung hình — rời khung = thua &amp; tự lưu.
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10">Best: <b className="font-mono text-white">{bestSingleMs ? formatDuration(bestSingleMs) : "--"}</b></span>
                  <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10">{localScores.length} lượt • Top {Math.min(localScores.length,5)} local</span>
                  <span className="px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200">● Live EAR 0.20</span>
                </div>
              </div>
            </div>

            {/* Hướng dẫn & Tips - đưa lên đầu */}
            <div className="rounded-[24px] border border-indigo-500/20 bg-gradient-to-br from-indigo-600/10 via-white/[0.03] to-transparent backdrop-blur p-6">
              <h4 className="font-extrabold flex items-center gap-2 text-[13px] tracking-widest text-indigo-200"> <span className="w-7 h-7 rounded-lg bg-indigo-500/20 flex items-center justify-center text-sm">📋</span> HƯỚNG DẪN & TIPS QUAN TRỌNG</h4>
              <div className="mt-4 grid sm:grid-cols-3 gap-5 text-sm">
                <div className="space-y-1.5">
                  <div className="text-white font-bold flex gap-2"><span className="w-6 h-6 rounded-full bg-white text-black flex items-center justify-center text-xs font-black">1</span> Chuẩn bị</div>
                  <p className="text-white/60 leading-relaxed text-[13px]">Ngồi thẳng, mặt đủ sáng, cách camera 50-70cm. 1 camera track 2 người đứng cạnh nhau.</p>
                </div>
                <div className="space-y-1.5">
                  <div className="text-white font-bold flex gap-2"><span className="w-6 h-6 rounded-full bg-white text-black flex items-center justify-center text-xs font-black">2</span> Bắt đầu</div>
                  <p className="text-white/60 leading-relaxed text-[13px]">Bấm “Bắt đầu” → đếm 3-2-1 → giữ mắt mở. Hệ thống dừng ngay khi EAR &lt; 0.20.</p>
                </div>
                <div className="space-y-1.5">
                  <div className="text-white font-bold flex gap-2"><span className="w-6 h-6 rounded-full bg-white text-black flex items-center justify-center text-xs font-black">3</span> Giữ khung hình</div>
                  <p className="text-white/60 leading-relaxed text-[13px]">Không rời khỏi camera, không nghiêng &gt;30°. Nếu mất track, ván đấu tự kết thúc &amp; lưu.</p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <span className="px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/20 text-amber-200">⚠️ Không đeo kính râm</span>
                <span className="px-3 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/20 text-indigo-200">💡 Ánh sáng đều, tránh ngược sáng</span>
                <span className="px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200">🎥 60 FPS • ngưỡng 0.20</span>
                <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/70">Rời khung = tự thua</span>
              </div>
            </div>

            {/* Mode cards */}
            <div className="grid md:grid-cols-2 gap-5">
              <button onClick={() => setMode("single")} className="group text-left relative overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-indigo-600/25 via-violet-600/15 to-transparent backdrop-blur p-6 sm:p-7 hover:border-indigo-400/30 hover:from-indigo-600/30 transition">
                <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/20 blur-[40px] rounded-full group-hover:bg-indigo-500/30 transition" />
                <div className="relative">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500 flex items-center justify-center text-xl shadow-lg shadow-indigo-500/20">🎯</div>
                  <h3 className="mt-4 text-xl font-extrabold">Local Highscore</h3>
                  <p className="text-sm text-white/65 mt-1">1 người • Tự động lưu kỷ lục sau mỗi ván. EAR 0.20.</p>
                  <ul className="mt-3 space-y-1.5 text-xs text-white/70">
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Countdown 3-2-1 rồi tính giờ</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Chớp = thua ngay • Rời khung = thua</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Tự động lưu local top 50</li>
                  </ul>
                  <div className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#070a14] font-bold text-sm group-hover:translate-x-0.5 transition">
                    Chơi đơn <span>→</span>
                  </div>
                </div>
              </button>

              <button onClick={() => setMode("multi")} className="group text-left relative overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-fuchsia-600/25 via-pink-600/15 to-transparent backdrop-blur p-6 sm:p-7 hover:border-fuchsia-400/30 hover:from-fuchsia-600/30 transition">
                <div className="absolute top-0 right-0 w-32 h-32 bg-fuchsia-500/20 blur-[40px] rounded-full group-hover:bg-fuchsia-500/30 transition" />
                <div className="relative">
                  <div className="w-12 h-12 rounded-2xl bg-fuchsia-500 flex items-center justify-center text-xl shadow-lg shadow-fuchsia-500/20">⚔️</div>
                  <h3 className="mt-4 text-xl font-extrabold">Local Multiplayer</h3>
                  <p className="text-sm text-white/65 mt-1">2 người • 1 camera • Ai chớp hoặc rời khung trước sẽ thua.</p>
                  <ul className="mt-3 space-y-1.5 text-xs text-white/70">
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> P1 trái &amp; P2 phải</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Hòa khi chớp cùng lúc</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Mất track = thua ngay</li>
                  </ul>
                  <div className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#070a14] font-bold text-sm group-hover:translate-x-0.5 transition">
                    Đấu 2 người <span>→</span>
                  </div>
                </div>
              </button>
            </div>

            {/* Highscore rút gọn + settings */}
            <div className="grid lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 rounded-[24px] border border-white/10 bg-white/[0.04] backdrop-blur p-6">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold flex items-center gap-2 text-sm"><span className="w-7 h-7 rounded-lg bg-amber-500/20 flex items-center justify-center">🏆</span> Highscore Local (auto-save)</h4>
                  <span className="text-xs px-2 py-1 rounded-full bg-white/10 border border-white/10">{localScores.length} lượt</span>
                </div>
                <div className="mt-4 space-y-2 max-h-[200px] overflow-auto pr-1">
                  {localScores.length === 0 ? (
                    <div className="text-sm text-white/50 py-8 text-center border border-dashed border-white/10 rounded-xl">Chưa có kỷ lục — hãy chơi!</div>
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
                {localScores.length > 5 && <div className="mt-3 text-xs text-white/50 text-center">+ {localScores.length - 5} kỷ lục khác</div>}
                {highScores.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-white/10 flex gap-2 overflow-auto pb-1">
                    {highScores.slice(0, 3).map(h => (
                      <div key={h.id} className="shrink-0 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/15 text-xs">
                        <span className="text-white/70">{h.player_name}</span> <span className="font-mono ml-2 text-indigo-200">{formatDuration(h.duration_ms)}</span>
                      </div>
                    ))}
                    <span className="text-[11px] text-white/30 self-center">Supabase Top 3</span>
                  </div>
                )}
                <button onClick={() => { if (confirm("Xóa hết kỷ lục local?")) { localStorage.removeItem(LS_KEY); setLocalScores([]); setBestSingleMs(0); } }} className="mt-3 text-xs px-3 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">Xóa local</button>
              </div>

              <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-5 space-y-4">
                <h4 className="font-bold text-sm">Cài đặt nhanh</h4>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-white/70 text-xs">Tên hiển thị (auto-lưu):</span>
                  <input value={playerName} onChange={e => setPlayerName(e.target.value)} maxLength={18} placeholder="Player" className="px-3 py-2 rounded-xl bg-white/10 border border-white/15 focus:border-indigo-400 outline-none" />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} className="accent-indigo-500" />
                  <span className="text-white/70">Hiện overlay mắt</span>
                </label>
                <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/20 p-3 text-xs leading-relaxed">
                  <div className="font-bold text-indigo-200">Ngưỡng cố định</div>
                  <div className="text-white/70 mt-1">EAR = <b className="text-white">0.20</b> • Smoother 3 • Đóng 1 frame = thua ngay. Không cần chỉnh thủ công.</div>
                </div>
                {supabaseError && (
                  <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 break-words">⚠ Supabase: {supabaseError}</div>
                )}
              </div>
            </div>
          </div>
        )}

        {(mode === "single" || mode === "multi") && (
          <div className="space-y-5">
            {/* Top bar actions */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button onClick={() => setMode("menu")} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-sm transition">← Về menu</button>
              <div className="flex items-center gap-2 text-xs">
                <span className={`px-3 py-1.5 rounded-full border text-xs font-semibold ${phase === "playing" ? "bg-emerald-500 text-white border-emerald-400 animate-pulse" : phase === "countdown" ? "bg-amber-500 text-black border-amber-400" : phase === "finished" ? (endReason === "tracking_lost" ? "bg-red-600 text-white border-red-500" : "bg-red-500 text-white border-red-400") : "bg-white/10 border-white/10"}`}>
                  {phase === "idle" && "Chờ camera"}
                  {phase === "requesting" && "Đang xin quyền camera..."}
                  {phase === "ready" && "Sẵn sàng • EAR 0.20"}
                  {phase === "countdown" && `Chuẩn bị... ${countdown}`}
                  {phase === "playing" && "● ĐANG CHƠI • 60FPS"}
                  {phase === "finished" && (endReason === "tracking_lost" ? "⚠ MẤT TRACK" : "Kết thúc")}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
                  <span className={`w-2 h-2 rounded-full ${faceCount > 0 ? "bg-emerald-400" : "bg-red-400 animate-pulse"}`} /> {faceCount} mặt • {fps} FPS
                </span>
                {mode === "multi" && <span className="px-3 py-1.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/20 text-fuchsia-200">P1 trái • P2 phải</span>}
              </div>
            </div>

            {/* Main game card */}
            <div className="grid lg:grid-cols-[1.45fr_0.85fr] gap-5">
              {/* Video area */}
              <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-black/60 backdrop-blur">
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

                  {phase === "playing" && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden opacity-20">
                      <div className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-[scanline_2s_linear_infinite]" />
                    </div>
                  )}

                  {/* Tracking warning banner - khi chưa chơi hoặc đang chơi sắp mất */}
                  {trackingWarning && phase !== "finished" && (
                    <div className="absolute top-12 left-3 right-3 flex justify-center pointer-events-none">
                      <div className="px-3 py-2 rounded-xl bg-amber-500 text-black text-xs font-bold shadow-lg flex items-center gap-2 animate-pulse">
                        <span>⚠️</span>
                        <span>{phase === "playing" ? "Đang mất tín hiệu— giữ mặt trong khung!" : "Không thấy mắt — hãy vào vùng camera, đủ sáng, nhìn thẳng"}</span>
                      </div>
                    </div>
                  )}

                  {phase === "countdown" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px]">
                      <div className="text-[92px] sm:text-[120px] font-black leading-none tracking-tighter text-white drop-shadow-[0_8px_30px_rgba(99,102,241,0.6)] animate-[pulse-eye_0.9s_ease_infinite]">{countdown === 0 ? "GO!" : countdown}</div>
                      <div className="text-sm tracking-[0.3em] text-white/70 mt-2">ĐỪNG CHỚP • ĐỪNG RỜI KHUNG</div>
                    </div>
                  )}

                  {phase === "finished" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4">
                      <div className={`w-full max-w-md rounded-[20px] border backdrop-blur p-5 sm:p-6 text-center shadow-2xl ${endReason === "tracking_lost" ? "bg-red-950/90 border-red-500/30" : "bg-[#0f1220]/90 border-white/15"}`}>
                        {endReason === "tracking_lost" ? (
                          <>
                            <div className="w-12 h-12 mx-auto rounded-2xl bg-red-500 flex items-center justify-center text-xl">⚠️</div>
                            <div className="mt-3 text-xs tracking-[0.2em] text-red-300">MẤT TÍN HIỆU</div>
                            <div className="mt-1 font-black text-xl leading-tight">RỜI KHỎI VÙNG CAMERA</div>
                            <div className="mt-2 text-sm text-white/70 leading-relaxed">Bạn đã rời khỏi vùng camera / không thể track đôi mắt. Lượt chơi đã <b className="text-white">tự động kết thúc</b> và kết quả <b className="font-mono text-white">{formatDuration(Math.round(elapsedMs))}</b> đã được <b className="text-emerald-300">lưu vào Local Highscore</b>.</div>
                            <div className="mt-2 text-xs text-white/50">Hãy đảm bảo mặt đủ sáng, nhìn thẳng và ở trong khung hình.</div>
                          </>
                        ) : mode === "single" ? (
                          <>
                            <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-xl">⏱️</div>
                            <div className="mt-3 text-xs tracking-[0.2em] text-white/60">THỜI GIAN CỦA BẠN</div>
                            <div className="mt-1 font-mono font-black text-4xl tracking-tight">{formatDuration(Math.round(elapsedMs))}</div>
                            <div className="text-xs text-white/50 mt-1">Kỷ lục: {bestSingleMs ? formatDuration(bestSingleMs) : "--"} • <span className="text-emerald-300">Đã tự động lưu ✓</span></div>
                            {elapsedMs >= bestSingleMs && elapsedMs > 800 && <div className="mt-2 inline-flex px-3 py-1 rounded-full bg-amber-400 text-black text-xs font-bold">🎉 KỶ LỤC MỚI!</div>}
                            {saveStatus === "saving" && <div className="text-xs text-amber-200 mt-2">Đang đồng bộ Supabase...</div>}
                            {saveStatus === "success" && <div className="text-xs text-emerald-300 mt-2">✓ Đã lưu Local {supabaseReady ? "+ Supabase" : "(Supabase chưa cấu hình)"}</div>}
                            {saveStatus === "error" && <div className="text-xs text-red-300 mt-2 break-words">✗ Lỗi Supabase: {saveErrorMsg} (vẫn đã lưu Local)</div>}
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
                              {winner === 1 && "P2 đã chớp / rời khung trước"}
                              {winner === 2 && "P1 đã chớp / rời khung trước"}
                              {winner === "draw" && "Cả hai chớp cùng lúc!"}
                              {!winner && `Thời gian: ${formatDuration(Math.round(elapsedMs))}`}
                            </div>
                            <div className="mt-1 font-mono text-white/80">{formatDuration(Math.round(elapsedMs))}</div>
                          </>
                        )}
                        <div className="mt-5 grid grid-cols-2 gap-2.5">
                          <button onClick={triggerCountdown} className={`py-2.5 rounded-full font-bold text-sm transition ${endReason === "tracking_lost" ? "bg-white text-black hover:bg-zinc-100" : "bg-white text-black hover:bg-zinc-100"}`}>Chơi lại</button>
                          <button onClick={() => setMode("menu")} className="py-2.5 rounded-full bg-white/10 border border-white/15 font-bold text-sm hover:bg-white/15 transition">Menu</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Top info bar inside video */}
                  <div className="absolute top-3 left-3 right-3 flex items-center justify-between gap-2 pointer-events-none">
                    <div className="flex items-center gap-2">
                      <span className={`px-2.5 py-1 rounded-full backdrop-blur border text-xs font-mono ${faceCount === 0 ? "bg-red-500/90 border-red-400 text-white animate-pulse" : "bg-black/55 border-white/15"}`}>{faceCount === 0 ? "Không thấy mặt" : faceCount === 1 ? "1 mặt" : `${faceCount} mặt`} </span>
                      {phase === "playing" && <span className="hidden sm:inline-flex px-2.5 py-1 rounded-full bg-emerald-500/90 text-white text-xs font-bold">● LIVE 60FPS</span>}
                    </div>
                    <div className="hidden sm:flex items-center gap-1.5 text-xs">
                      {earValues.map((ear, i) => (
                        <span key={i} className={`px-2.5 py-1 rounded-full border font-mono backdrop-blur ${blinkStates[i] === "closed" ? "bg-red-500 text-white border-red-400" : blinkStates[i] === "closing" ? "bg-amber-500 text-black border-amber-400" : "bg-black/55 border-white/15"}`}>
                          P{i + 1}: {ear.toFixed(2)} {blinkStates[i] === "closed" ? "• CLOSED" : blinkStates[i] === "closing" ? "• ..." : "• OPEN"}
                        </span>
                      ))}
                      {earValues.length === 0 && faceCount === 0 && <span className="px-2.5 py-1 rounded-full bg-black/55 border border-white/15 font-mono">EAR --</span>}
                    </div>
                  </div>

                  <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                    <div className="flex gap-1.5">
                      {Array.from({ length: mode === "multi" ? 2 : 1 }).map((_, i) => (
                        <div key={i} className={`w-2.5 h-2.5 rounded-full border border-white/20 shadow ${blinkStates[i] === "closed" ? "bg-red-500 shadow-red-500/30" : blinkStates[i] === "closing" ? "bg-amber-400 shadow-amber-400/30" : faceCount > i ? "bg-emerald-400 shadow-emerald-400/30" : "bg-white/20"}`} />
                      ))}
                    </div>
                    <span className="text-[11px] px-2 py-1 rounded-full bg-black/50 border border-white/10 text-white/70">Gương lật • EAR 0.20 cố định</span>
                  </div>
                </div>

                <div className="p-4 sm:p-5 bg-gradient-to-b from-transparent to-white/[0.03] border-t border-white/10 flex flex-wrap gap-2.5 items-center justify-between">
                  <div className="flex flex-wrap gap-2.5">
                    {phase === "ready" && (
                      <button onClick={triggerCountdown} disabled={!landmarkerReady || faceCount === 0} className="px-6 py-2.5 rounded-full bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-sm shadow-lg shadow-indigo-600/20 transition flex items-center gap-2">
                        ▶ Bắt đầu {mode === "multi" ? "đấu" : ""} {faceCount === 0 ? "(cần thấy mặt)" : ""}
                      </button>
                    )}
                    {phase === "playing" && (
                      <button onClick={() => { setEndReason("blink"); setPhase("finished"); }} className="px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/15 border border-white/15 text-sm font-semibold">Dừng</button>
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
                  <div className="mx-4 mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-200 flex flex-col gap-2">
                    <div>Không tải được model MediaPipe: {lmState.message}. Thử refresh hoặc kiểm tra mạng/CDN (cần truy cập cdn.jsdelivr.net & storage.googleapis.com).</div>
                    <button onClick={() => initLandmarker()} className="self-start px-3 py-1.5 rounded-full bg-amber-500 text-black text-xs font-bold hover:bg-amber-400">↻ Thử lại tải model</button>
                  </div>
                )}
                {lmState.status === "loading" && (
                  <div className="mx-4 mb-4 p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-sm text-indigo-200">Đang tải model MediaPipe 1.0.1... (lần đầu ~3-5s, hỗ trợ cả khi đeo kính)</div>
                )}
                {landmarkerReady && faceCount === 0 && (phase === "ready" || phase === "countdown") && (
                  <div className="mx-4 mb-4 p-3 rounded-xl bg-white/5 border border-white/10 text-xs text-white/70">
                    💡 Mẹo đeo kính: lau sạch kính, tránh ánh đèn phản chiếu trên tròng, ngồi cách camera 50-70cm, nhìn thẳng. Nếu vẫn “Không thấy mặt”, thử tháo kính test rồi đeo lại, hoặc bấm <b>Reload cam</b>.
                  </div>
                )}
              </div>

              {/* Right panel */}
              <div className="space-y-4">
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
                      <div className="text-[11px] text-white/50">NGƯỠNG</div>
                      <div className="font-mono font-bold text-sm">0.20</div>
                    </div>
                    <div className="rounded-xl bg-black/30 border border-white/5 p-2.5">
                      <div className="text-[11px] text-white/50">FPS</div>
                      <div className="font-mono font-bold text-sm text-emerald-300">{fps}</div>
                    </div>
                    <div className="rounded-xl bg-black/30 border border-white/5 p-2.5">
                      <div className="text-[11px] text-white/50">MẮT</div>
                      <div className={`font-bold text-sm ${blinkStates[0] === "closed" ? "text-red-400" : trackingWarning ? "text-amber-300" : "text-emerald-300"}`}>{trackingWarning ? "MẤT" : blinkStates[0] ?? "--"}</div>
                    </div>
                  </div>

                  {mode === "single" && (
                    <div className="mt-4 flex items-center gap-2 text-xs">
                      <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="Tên bạn" maxLength={18} className="flex-1 px-3 py-2 rounded-full bg-white/5 border border-white/10 focus:border-indigo-400 outline-none" />
                      <span className="hidden sm:inline text-white/50">auto-lưu</span>
                    </div>
                  )}
                  {phase === "finished" && mode === "single" && endReason !== "tracking_lost" && saveStatus && (
                    <div className={`mt-3 text-xs px-3 py-2 rounded-xl border ${saveStatus === "success" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-200" : saveStatus === "error" ? "bg-red-500/10 border-red-500/20 text-red-200" : "bg-amber-500/10 border-amber-500/20 text-amber-200"}`}>
                      {saveStatus === "saving" && "Đang lưu..."}
                      {saveStatus === "success" && "✓ Đã tự động lưu vào Local Highscore"}
                      {saveStatus === "error" && `✗ Lỗi Supabase: ${saveErrorMsg} (vẫn đã lưu Local)`}
                    </div>
                  )}
                  {phase === "finished" && endReason === "tracking_lost" && mode === "single" && (
                    <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-200">
                      ⚠ Kết thúc do rời khung camera. Đã tự động lưu {formatDuration(Math.round(elapsedMs))} vào Local.
                    </div>
                  )}
                </div>

                {mode === "multi" ? (
                  <div className="grid grid-cols-2 gap-3">
                    {[0, 1].map(i => {
                      const isClosed = blinkStates[i] === "closed";
                      const isClosing = blinkStates[i] === "closing";
                      const hasFace = faceCount > i;
                      return (
                        <div key={i} className={`rounded-[20px] border p-4 text-center transition ${isClosed ? "bg-red-500/15 border-red-500/40" : isClosing ? "bg-amber-500/15 border-amber-500/30" : hasFace ? "bg-emerald-500/10 border-emerald-500/20" : trackingWarning ? "bg-amber-500/10 border-amber-500/30" : "bg-white/5 border-white/10"}`}>
                          <div className={`w-10 h-10 mx-auto rounded-xl flex items-center justify-center font-black ${isClosed ? "bg-red-500 text-white" : hasFace ? "bg-white text-black" : "bg-white/10"}`}>P{i + 1}</div>
                          <div className="mt-2 font-bold text-sm">Player {i + 1}</div>
                          <div className={`text-xs mt-1 px-2 py-1 rounded-full inline-flex border ${isClosed ? "bg-red-500 text-white border-red-400" : isClosing ? "bg-amber-400 text-black border-amber-400" : hasFace ? "bg-emerald-500/20 text-emerald-200 border-emerald-500/20" : "bg-amber-500/20 text-amber-200 border-amber-500/20"}`}>
                            {hasFace ? (isClosed ? "CHỚP RỒI!" : isClosing ? "Sắp chớp..." : "Đang nhìn") : trackingWarning && phase === "playing" ? "Mất tín hiệu!" : "Chưa thấy"}
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
                    <div className="mt-3 text-xs text-white/40">Ngưỡng 0.20 • Tự động lưu sau mỗi ván • Rời khung = lưu &amp; thua</div>
                  </div>
                )}

                <div className="rounded-[20px] border border-amber-500/20 bg-amber-500/10 p-4">
                  <div className="text-xs font-bold tracking-widest text-amber-200">LƯU Ý THEO DÕI</div>
                  <ul className="mt-2 space-y-1.5 text-xs text-white/70 leading-relaxed">
                    <li>• Giữ mặt trong khung, không che mắt</li>
                    <li>• Nếu “Không thấy mặt”, điều chỉnh ánh sáng / khoảng cách</li>
                    <li>• Đang chơi mà mất track quá {LOST_FRAMES_THRESHOLD} khung → tự thua &amp; lưu</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="mt-auto border-t border-white/5 py-5 text-center text-xs text-white/30">
        <div className="max-w-6xl mx-auto px-4">
          © 2026 Staredown • EAR cố định 0.20 • 60 FPS • MediaPipe 478 pts • v0.2.1 • build 2026-08-29-fix-glasses
        </div>
      </footer>
    </div>
  );
}
