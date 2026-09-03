"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useFaceLandmarker } from "@/hooks/useFaceLandmarker";
import { calcAvgEAR, EARSmoother, formatDuration, getAdaptiveThreshold, isEyeClosedQuick } from "@/lib/ear";
import { getSupabase, getSupabaseConfigError, submitHighScore, HighScore, deleteMyGlobalScores, getWeeklyRangeLabel } from "@/lib/supabase";
import EyeOverlay from "@/components/EyeOverlay";
import { useOnline } from "@/hooks/useOnline";
import ThemePicker from "@/components/ThemePicker";
import { getCurrentTheme, ThemePreset } from "@/lib/theme";

// ---------- Constants ----------
const EAR_DEFAULT = 0.2; // fallback nếu chưa hiệu chỉnh
const SMOOTHER_WINDOW = 1; // giảm xuống 1 để phản ứng tức thì, track nhiều khung hơn
const REQUIRED_CLOSED_FRAMES = 1; // ngay lập tức khi xuống dưới ngưỡng
const REQUIRED_OPEN_FRAMES = 1;
const LOST_FRAMES_THRESHOLD = 9; // ~75ms @120fps (scale theo fps), giữ nhạy nhưng tránh false do fps cao
const COUNTDOWN_LOST_THRESHOLD = 6; // ~50ms @120fps
const AUTO_SAVE_MIN_MS = 500;

// ---------- Types ----------
type GameMode = "menu" | "single" | "multi" | "online";
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

  // Settings - EAR adaptive 0.17-0.24 (base 0.20) + glass/squint handling
  const [showDebug, setShowDebug] = useState(true);
  const [playerName, setPlayerName] = useState("Player");
  const [supabaseReady, setSupabaseReady] = useState(false);
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [highScores, setHighScores] = useState<HighScore[]>([]);
  const [localScores, setLocalScores] = useState<LocalScore[]>([]);
  const [saveStatus, setSaveStatus] = useState<null | "saving" | "success" | "error">(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [trackingWarning, setTrackingWarning] = useState(false);
  // Global Highscore UI - All-time top 10 vs Weekly top 50 (reset Monday)
  const [globalTab, setGlobalTab] = useState<"alltime" | "weekly">("alltime");
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalScoresFull, setGlobalScoresFull] = useState<HighScore[]>([]);

  // Online (BETA) - Supabase Realtime LAN/Global
  const online = useOnline(playerName);
  const onlineRef = useRef(online);
  useEffect(() => { onlineRef.current = online; }, [online]);
  const [onlineFriendInput, setOnlineFriendInput] = useState("");
  const [_onlineCountdownSync, setOnlineCountdownSync] = useState<number | null>(null);
  const [onlineLobbyTab, setOnlineLobbyTab] = useState<"public" | "all">("public");
  const [onlineRoomSearch, setOnlineRoomSearch] = useState("");
  const [onlineCopyFeedback, setOnlineCopyFeedback] = useState<string | null>(null);
  const [onlineJoinCode, setOnlineJoinCode] = useState("");

  // Theme - avoid hydration mismatch (server always midnight, client hydrates then loads stored)
  const [currentTheme, setCurrentTheme] = useState<ThemePreset>(() => {
    // Use first theme as SSR fallback to match server
    try {
      const { THEMES: _t } = require("@/lib/theme");
      return _t[0];
    } catch { return { id: "midnight", name: "Midnight", bg: "#070a14", card: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.10)", accent: "#6366f1", accent2: "#8b5cf6", glow1: "rgba(99,102,241,0.20)", glow2: "rgba(6,182,212,0.15)", textAccent: "#a5b4fc" } as ThemePreset; }
  });
  const [clientIdShort, setClientIdShort] = useState("");
  useEffect(() => {
    const upd = () => setCurrentTheme(getCurrentTheme());
    upd();
    window.addEventListener("theme-change", upd);
    window.addEventListener("storage", upd);
    // Load client id for display (avoid hydration mismatch)
    try { setClientIdShort((localStorage.getItem("staredown_account_id_v1") || "").slice(0, 6)); } catch {}
    return () => { window.removeEventListener("theme-change", upd); window.removeEventListener("storage", upd); };
  }, []);

  // Lobby subscribe for public rooms (auto)
  useEffect(() => {
    if (mode !== "online") return;
    online.subscribeLobby(online.netMode);
  }, [mode, online.netMode, online]);

  // Bind remoteStream to remote video element (split-screen right side)
  useEffect(() => {
    const v = remoteVideoRef.current;
    if (!v) return;
    if (online.remoteStream) {
      v.srcObject = online.remoteStream;
      v.play().catch(() => console.warn("[online] remote video play blocked"));
    } else {
      v.srcObject = null;
    }
  }, [online.remoteStream]);

  // Auto clear copy feedback
  useEffect(() => {
    if (!onlineCopyFeedback) return;
    const t = setTimeout(() => setOnlineCopyFeedback(null), 2000);
    return () => clearTimeout(t);
  }, [onlineCopyFeedback]);

  // Video / MediaPipe
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);

  const { state: lmState, init: initLandmarker } = useFaceLandmarker(mode === "single" ? 1 : 2);
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
  const smootherRefs = useRef<EARSmoother[]>([new EARSmoother(SMOOTHER_WINDOW, 0.85), new EARSmoother(SMOOTHER_WINDOW, 0.85)]);
  const closedFramesRef = useRef<number[]>([0, 0]);
  const openFramesRef = useRef<number[]>([0, 0]);
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());
  const lastFpsFramesRef = useRef(0);
  const trackingLostFramesRef = useRef(0);
  const hasAutoSavedRef = useRef(false);
  const lastNoFaceLogRef = useRef(0);
  // Adaptive EAR for glasses/squint
  const calibrationSamplesRef = useRef<number[]>([]);
  const adaptiveThresholdRef = useRef<number>(EAR_DEFAULT);
  const [adaptiveThresholdUI, setAdaptiveThresholdUI] = useState<number>(EAR_DEFAULT);
  // Sudden drop 0.04+ trong 1-3 khung hình -> lập tức nhắm (giảm từ 0.07 theo yêu cầu)
  const earHistoryRef = useRef<number[][]>([[], []]);
  const SUDDEN_DROP_THRESHOLD = 0.04;
  const SUDDEN_DROP_FRAMES = 3;
  const uiThrottleRef = useRef(0);
  // For countdown tracking lost
  const countdownTrackingLostRef = useRef(0);
  // Online refs for fairness
  const onlineBlinkTsRef = useRef<{ local: number | null; remote: number | null }>({ local: null, remote: null });
  const onlineFinishedAtRef = useRef<number | null>(null);

  // Helpers for Global - All-time top 10 vs Weekly top 50 (Monday reset)
  const refreshGlobal = useCallback(async () => {
    setGlobalLoading(true);
    try {
      const { fetchAllTimeTop10, fetchWeeklyTop50 } = await import("@/lib/supabase");
      if (globalTab === "alltime") {
        const data = await fetchAllTimeTop10();
        setHighScores(data.slice(0, 10));
        setGlobalScoresFull(data);
      } else {
        const data = await fetchWeeklyTop50();
        setGlobalScoresFull(data);
        // Keep highScores (top 3 in local panel) as All-time for reference
        fetchAllTimeTop10().then(d => setHighScores(d.slice(0, 10))).catch(() => {});
      }
    } catch (e) {
      console.warn("refreshGlobal failed", e);
    } finally { setGlobalLoading(false); }
  }, [globalTab]);

  // Refetch when tab changes
  useEffect(() => {
    refreshGlobal();
  }, [globalTab, refreshGlobal]);

  // Delete Global (by client_id, robust to name change)
  const [deleteGlobalLoading, setDeleteGlobalLoading] = useState(false);
  const handleDeleteMyGlobal = useCallback(async () => {
    if (!confirm("Xóa tất cả điểm Global của máy này? Hành động này sẽ xóa theo client_id (không phụ thuộc tên) và không thể hoàn tác.")) return;
    setDeleteGlobalLoading(true);
    const res = await deleteMyGlobalScores();
    setDeleteGlobalLoading(false);
    if (res.error) {
      alert(`Lỗi xóa: ${res.error}`);
    } else {
      alert(`Đã xóa ${res.deletedCount} bản ghi Global của máy này.` + (res.deletedCount === 0 ? " (không có bản ghi nào thuộc máy này)" : ""));
      refreshGlobal();
    }
  }, [refreshGlobal]);

  // Load local data
  useEffect(() => {
    setLocalScores(loadLocalScores());
    const savedName = typeof window !== "undefined" ? localStorage.getItem(LS_NAME_KEY) : null;
    if (savedName) setPlayerName(savedName);
    const cfgErr = getSupabaseConfigError();
    setSupabaseError(cfgErr);
    setSupabaseReady(!!getSupabase() && !cfgErr);
    refreshGlobal();
    const best = loadLocalScores()[0]?.durationMs ?? 0;
    setBestSingleMs(best);
  }, [refreshGlobal]);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(LS_NAME_KEY, playerName);
  }, [playerName]);

  // Camera lifecycle - robust cho cả kính/không kính, fallback nếu 60fps không hỗ trợ
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setPhase("requesting");
    setTrackingWarning(false);
    trackingLostFramesRef.current = 0;
    // Tăng FPS: ưu tiên 120fps -> 60fps -> 30fps để track nhiều khung hình hơn mỗi giây
    const tries: MediaStreamConstraints[] = [
      { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user", frameRate: { ideal: 120, min: 60 } }, audio: false },
      { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user", frameRate: { ideal: 60, min: 30 } }, audio: false },
      { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user", frameRate: { ideal: 60, min: 30 } }, audio: false },
      { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user", frameRate: { ideal: 30 } }, audio: false },
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
          setTimeout(() => res(), 5000);
        });
      }
      await v.play().catch(() => {
        // Safari cần user gesture, thử lại sau countdown
        console.warn("[camera] play() bị chặn, đợi user click Bắt đầu");
      });
      if (v.videoWidth) setVideoSize({ w: v.videoWidth, h: v.videoHeight });
      // Online split-screen: push local tracks to WebRTC if in online mode
      if (modeRef.current === "online") {
        try { onlineRef.current.addLocalStream(stream); } catch (e) { console.warn("[online] addLocalStream failed", e); }
      }
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
      calibrationSamplesRef.current = [];
      earHistoryRef.current = [[], []];
      // Leave online room when back to menu
      if (onlineRef.current.phase !== "idle") onlineRef.current.leaveRoom();
    } else {
      startCamera();
    }
    return () => { /* keep camera when switching */ };
  }, [mode, startCamera, stopCamera]);

  // Countdown effect - abort if user leaves camera (tracking lost during countdown)
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
      countdownTrackingLostRef.current = 0;
      setTrackingWarning(false);
      smootherRefs.current.forEach(s => s.reset());
      closedFramesRef.current = [0, 0];
      earHistoryRef.current = [[], []];
      // Finalize adaptive threshold from calibration samples
      if (calibrationSamplesRef.current.length >= 8) {
        const sorted = [...calibrationSamplesRef.current].sort((a,b)=>a-b);
        const median = sorted[Math.floor(sorted.length/2)];
        const tuned = getAdaptiveThreshold(median);
        adaptiveThresholdRef.current = tuned;
        setAdaptiveThresholdUI(tuned);
        console.log(`[EAR] calibrated median=${median.toFixed(3)} -> thresh=${tuned.toFixed(3)} (${calibrationSamplesRef.current.length} samples)`);
      }
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 900);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  const triggerCountdown = useCallback(() => {
    if (!landmarkerReady) return;
    if (phase !== "ready" && phase !== "finished") return;
    // Online mode: only host can trigger, via broadcast
    if (modeRef.current === "online") {
      if (online.role !== "host") return;
      if (!online.opponent || !online.opponent.cameraReady || !online.selfCameraReady) return;
      online.broadcastCountdownStart();
      return;
    }
    setCountdown(3);
    setPhase("countdown");
    setElapsedMs(0);
    setWinner(null);
    setEndReason(null);
    setTrackingWarning(false);
    trackingLostFramesRef.current = 0;
    countdownTrackingLostRef.current = 0;
    hasAutoSavedRef.current = false;
    closedFramesRef.current = [0, 0];
    openFramesRef.current = [0, 0];
    smootherRefs.current.forEach(s => s.reset());
    // Reset calibration for new game
    calibrationSamplesRef.current = [];
    adaptiveThresholdRef.current = EAR_DEFAULT;
    setAdaptiveThresholdUI(EAR_DEFAULT);
    earHistoryRef.current = [[], []];
    onlineBlinkTsRef.current = { local: null, remote: null };
    onlineFinishedAtRef.current = null;
  }, [landmarkerReady, phase]);

  // Online event listeners (BETA) - sync countdown/blink/tracking
  useEffect(() => {
    if (mode !== "online") return;
    const onCountdown = (e: Event) => {
      const detail = (e as CustomEvent).detail as { from: string; startAt: number };
      // adjust countdown to be synced: startAt is when playing starts
      const now = Date.now();
      const delayToStart = detail.startAt - now;
      // if delay ~3200, keep 3, else adjust
      const initial = delayToStart > 2500 ? 3 : delayToStart > 1500 ? 2 : delayToStart > 500 ? 1 : 0;
      setCountdown(initial);
      setPhase("countdown");
      setElapsedMs(0);
      setWinner(null);
      setEndReason(null);
      setTrackingWarning(false);
      trackingLostFramesRef.current = 0;
      countdownTrackingLostRef.current = 0;
      hasAutoSavedRef.current = false;
      closedFramesRef.current = [0, 0];
      openFramesRef.current = [0, 0];
      smootherRefs.current.forEach(s => s.reset());
      calibrationSamplesRef.current = [];
      adaptiveThresholdRef.current = EAR_DEFAULT;
      setAdaptiveThresholdUI(EAR_DEFAULT);
      earHistoryRef.current = [[], []];
      onlineBlinkTsRef.current = { local: null, remote: null };
      onlineFinishedAtRef.current = null;
      setOnlineCountdownSync(detail.startAt);
      console.log("[online] countdown_start from", detail.from, "startAt", detail.startAt, "delay", delayToStart);
    };
    const onBlink = (e: Event) => {
      const detail = (e as CustomEvent).detail as { from: string; ts: number };
      const curPhase = phaseRef.current as string;
      // if we already finished, check for draw within window
      if (curPhase === "finished") {
        const now2 = Date.now();
        const remoteTs2 = detail.ts;
        const localTs2 = onlineBlinkTsRef.current.local;
        const finishedAt = onlineFinishedAtRef.current ?? now2;
        if (Math.abs(now2 - finishedAt) < 350 && localTs2 && Math.abs(localTs2 - remoteTs2) < 120) {
          setWinner("draw" as unknown as 1 | 2 | "draw");
          console.log("[online] blink draw after finish");
        }
        return;
      }
      if (curPhase !== "playing") return;
      const now = Date.now();
      const remoteTs = detail.ts;
      const localTs = onlineBlinkTsRef.current.local;
      onlineBlinkTsRef.current.remote = remoteTs;
      // fairness: compensate ping
      const ping = onlineRef.current.pingMs || 0;
      const adjustedRemoteTs = remoteTs + ping / 2;
      // if local also blinked recently, compare
      if (localTs && Math.abs(localTs - remoteTs) < 150) {
        // draw if close
        setEndReason("blink");
        setWinner("draw");
        setPhase("finished");
        onlineFinishedAtRef.current = now;
        try { navigator.vibrate?.([80, 40, 80]); } catch {}
        console.log("[online] blink draw", localTs, remoteTs);
        return;
      }
      if (localTs && localTs < remoteTs) {
        // local blinked earlier but remote arrived late - local already lost? This case handled below
      }
      // opponent blinked, local wins (opponent lost)
      setEndReason("blink");
      // guest/host winner mapping for online: winner is self, but we reuse 1/2 display as "Bạn thắng"
      setWinner(1); // treat as self win
      setPhase("finished");
      onlineFinishedAtRef.current = now;
      try { navigator.vibrate?.(120); } catch {}
      console.log("[online] opponent blink, you win", remoteTs);
    };
    const onTrackingLost = (e: Event) => {
      const detail = (e as CustomEvent).detail as { from: string; ts: number };
      const curPhase2 = phaseRef.current as string;
      if (curPhase2 === "finished") return;
      if (curPhase2 !== "playing" && curPhase2 !== "countdown") return;
      setEndReason("tracking_lost");
      setWinner(1);
      setPhase("finished");
      onlineFinishedAtRef.current = Date.now();
      console.log("[online] opponent tracking lost");
    };
    window.addEventListener("online:countdown_start", onCountdown as EventListener);
    window.addEventListener("online:blink", onBlink as EventListener);
    window.addEventListener("online:tracking_lost", onTrackingLost as EventListener);
    return () => {
      window.removeEventListener("online:countdown_start", onCountdown as EventListener);
      window.removeEventListener("online:blink", onBlink as EventListener);
      window.removeEventListener("online:tracking_lost", onTrackingLost as EventListener);
    };
  }, [mode]);

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
          await refreshGlobal();
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
  }, [phase, playerName, refreshGlobal]);

  // Reset saveStatus khi rời finished
  useEffect(() => {
    if (phase !== "finished") {
      setSaveStatus(null);
      setSaveErrorMsg(null);
    }
  }, [phase]);

  // MediaPipe loop - fix: loop phải chạy lại khi mode thay đổi (video mới mount), không chỉ khi landmarkerReady
  useEffect(() => {
    if (!landmarkerReady || lmState.status !== "ready") return;
    if (mode === "menu") return; // menu không có video
    const landmarker = lmState.landmarker;
    // Lấy video mỗi frame để tránh bug video null khi chuyển từ menu -> game (đã gây không detect dù model ready)
    const getVideo = () => videoRef.current;

    let running = true;

    const handleBlinkDetected = (indices: number[]) => {
      if (phaseRef.current !== "playing") return;
      if (modeRef.current === "online") {
        const ts = Date.now();
        onlineBlinkTsRef.current.local = ts;
        onlineRef.current.broadcastBlink(ts);
        // Check if remote already blinked very close -> draw
        const remoteTs = onlineBlinkTsRef.current.remote;
        if (remoteTs && Math.abs(ts - remoteTs) < 130) {
          setEndReason("blink");
          setWinner("draw");
          setPhase("finished");
          onlineFinishedAtRef.current = ts;
          try { navigator.vibrate?.([80, 40, 80]); } catch {}
          return;
        }
        setEndReason("blink");
        setWinner(2); // you lost (opponent wins)
        setPhase("finished");
        onlineFinishedAtRef.current = ts;
        try { navigator.vibrate?.(120); } catch {}
        return;
      }
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
      if (modeRef.current === "online") {
        const ts = Date.now();
        onlineRef.current.broadcastTrackingLost(ts);
      }
      setEndReason("tracking_lost");
      if (modeRef.current === "online") setWinner(2);
      setPhase("finished");
      setTrackingWarning(false);
      try { navigator.vibrate?.([100, 50, 100, 50]); } catch {}
    };

    const handleCountdownLost = () => {
      if (phaseRef.current !== "countdown") return;
      console.log("[countdown] user left camera -> abort");
      if (modeRef.current === "online") {
        onlineRef.current.broadcastTrackingLost(Date.now());
        setWinner(2);
      }
      setEndReason("tracking_lost");
      setPhase("finished");
      setTrackingWarning(false);
      elapsedRef.current = 0;
      setElapsedMs(0);
      try { navigator.vibrate?.([80, 40, 80]); } catch {}
    };

    const loop = () => {
      if (!running) return;
      const video = getVideo();
      // Schedule next for max FPS: use video frame callback when available (tied to camera 60fps), fallback to rAF
      const vcb = video as unknown as { requestVideoFrameCallback?: (cb: FrameRequestCallback) => number } | null;
      if (video && vcb?.requestVideoFrameCallback) {
        try { vcb.requestVideoFrameCallback(loop as unknown as FrameRequestCallback); } catch { rafRef.current = requestAnimationFrame(loop); }
      } else {
        rafRef.current = requestAnimationFrame(loop);
      }
      if (!video || video.readyState < 2 || video.paused || video.ended) {
        // Nếu video chưa sẵn sàng, vẫn cập nhật faceCount 0 để UI hiện "Không thấy mặt"
        if (phaseRef.current === "ready" || phaseRef.current === "countdown") {
          // giữ warning để user biết
        }
        return;
      }
      const nowMs = performance.now();

      try {
        const result = landmarker.detectForVideo(video, nowMs);
        const faces = result.faceLandmarks ?? [];
        const blendshapes = result.faceBlendshapes ?? [];

        const indexed = faces.map((lm, i) => ({ lm, i, blend: blendshapes[i], x: lm[1]?.x ?? 0 }))
          .sort((a, b) => a.x - b.x);

        const sortedLandmarks = indexed.map(o => o.lm);
        // Tối ưu: throttle UI update để MediaPipe track nhanh hơn (giảm re-render)
        uiThrottleRef.current++;
        const shouldUpdateUI = uiThrottleRef.current % 2 === 0;
        if (shouldUpdateUI) {
          setLandmarksForOverlay(sortedLandmarks);
          setFaceCount(faces.length);
        } else if (faces.length === 0) {
          // vẫn cập nhật khi mất mặt để warning kịp thời
          setFaceCount(faces.length);
        }

        // FPS calc + debug log khi không thấy mặt dù model ready & video playing (giúp chẩn đoán kính/ánh sáng)
        frameCountRef.current++;
        if (nowMs - lastFpsTimeRef.current > 800) {
          const frames = frameCountRef.current - lastFpsFramesRef.current;
          const dt = (nowMs - lastFpsTimeRef.current) / 1000;
          setFps(Math.round(frames / dt));
          lastFpsTimeRef.current = nowMs;
          lastFpsFramesRef.current = frameCountRef.current;
        }
        if (faces.length === 0 && (phaseRef.current === "ready" || phaseRef.current === "countdown" || phaseRef.current === "playing")) {
          if (nowMs - lastNoFaceLogRef.current > 2000) {
            lastNoFaceLogRef.current = nowMs;
            const v = getVideo();
            console.log("[detect] no face", { readyState: v?.readyState, paused: v?.paused, w: v?.videoWidth, h: v?.videoHeight, phase: phaseRef.current, fps });
          }
        }

        // Không chơi: preview EAR + calibration + countdown abort
        if (phaseRef.current !== "playing") {
          const previewEars = sortedLandmarks.map(lm => calcAvgEAR(lm as never));
          // Throttle preview UI để tăng tốc MediaPipe, vẫn giữ calibration hàng frame
          if (shouldUpdateUI) {
            setEarValues(previewEars);
            setBlinkStates(sortedLandmarks.map(() => "open" as const));
          }
          // Calibration: collect open-eye EAR during ready/countdown (when face stable)
          if ((phaseRef.current === "ready" || phaseRef.current === "countdown") && sortedLandmarks.length > 0) {
            previewEars.forEach(ear => {
              // only collect if clearly open (ear > default) to avoid closed calibration
              if (ear > EAR_DEFAULT && ear < 0.40) {
                calibrationSamplesRef.current.push(ear);
                if (calibrationSamplesRef.current.length > 40) calibrationSamplesRef.current.shift();
                // update threshold live for UI (median of samples)
                if (calibrationSamplesRef.current.length >= 10) {
                  const s = [...calibrationSamplesRef.current].sort((a,b)=>a-b);
                  const med = s[Math.floor(s.length/2)];
                  const t = getAdaptiveThreshold(med);
                  adaptiveThresholdRef.current = t;
                  // throttle UI update
                  if (Math.abs(t - adaptiveThresholdUI) > 0.005) setAdaptiveThresholdUI(t);
                }
              }
            });
          }
          // Countdown: immediately abort if user leaves camera
          if (phaseRef.current === "countdown") {
            if (sortedLandmarks.length === 0) {
              countdownTrackingLostRef.current += 1;
              setTrackingWarning(true);
              if (countdownTrackingLostRef.current >= COUNTDOWN_LOST_THRESHOLD) {
                handleCountdownLost();
                return;
              }
            } else {
              countdownTrackingLostRef.current = 0;
              setTrackingWarning(false);
            }
            // also show preview EAR but do not return before handling?
          } else if (phaseRef.current === "ready") {
            setTrackingWarning(faces.length === 0);
            countdownTrackingLostRef.current = 0;
          } else {
            setTrackingWarning(false);
            countdownTrackingLostRef.current = 0;
          }
          // reset lost counter when not playing
          trackingLostFramesRef.current = 0;
          if (phaseRef.current !== "countdown" || sortedLandmarks.length > 0) {
            // if countdown still OK, continue preview; abort already returned
          }
          if (phaseRef.current === "countdown" && sortedLandmarks.length === 0) {
            // keep showing countdown warning without going to playing logic
            return;
          }
          if (phaseRef.current !== "countdown") return;
          // even in countdown with face present, we still preview and return (not playing logic)
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
          let avgBlend: number | null = null;
          if (blend?.categories) {
            const left = blend.categories.find(c => c.categoryName === "eyeBlinkLeft");
            const right = blend.categories.find(c => c.categoryName === "eyeBlinkRight");
            avgBlend = ((left?.score ?? 0) + (right?.score ?? 0)) / 2;
          }
          const smoother = smootherRefs.current[sortedIdx] ?? (smootherRefs.current[sortedIdx] = new EARSmoother(SMOOTHER_WINDOW, 0.85));
          const smoothedEar = smoother.push(rawEar);
          newEars.push(smoothedEar);

          const thresh = adaptiveThresholdRef.current ?? EAR_DEFAULT;
          // Đột ngột giảm 0.04+ trong 1-3 khung hình → lập tức nhắm (kết hợp ngưỡng để tránh nheo mắt)
          const hist = earHistoryRef.current[sortedIdx] ?? (earHistoryRef.current[sortedIdx] = []);
          let isSuddenDrop = false;
          if (hist.length > 0) {
            const maxPrev = Math.max(...hist);
            const drop = maxPrev - rawEar;
            if (drop >= SUDDEN_DROP_THRESHOLD && rawEar < thresh + 0.02) {
              isSuddenDrop = true;
            }
          }
          const isClosedByModel = isEyeClosedQuick(rawEar, smoothedEar, avgBlend, thresh);
          const isClosed = isClosedByModel || isSuddenDrop;
          // cập nhật history sau kiểm tra (giữ 3 khung gần nhất)
          hist.push(rawEar);
          if (hist.length > SUDDEN_DROP_FRAMES) hist.shift();

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

        // Throttle UI update nhưng vẫn bắt blink mỗi khung để phản ứng nhanh
        if (shouldUpdateUI || blinkedIndices.length > 0) {
          setEarValues(newEars);
          setBlinkStates(newStates);
        }

        if (blinkedIndices.length > 0 && phaseRef.current === "playing") {
          handleBlinkDetected(blinkedIndices);
        }

      } catch (err) {
        console.warn("[detect] error", err);
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    // Debug: log khi loop bắt đầu để xác nhận không bị kẹt do video null như trước
    console.log("[MediaPipe] loop started mode=", mode, " landmarkerReady=", landmarkerReady);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      console.log("[MediaPipe] loop stopped");
    };
  }, [landmarkerReady, lmState, mode]);

  // Cleanup on unmount
  useEffect(() => () => stopCamera(), [stopCamera]);

  // ---------- Render ----------
  return (
    <div className="min-h-screen flex flex-col text-white selection:bg-indigo-500/30" style={{ background: currentTheme.bg }}>
      {/* Background glows - themed */}
      <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none">
        <div className="absolute -top-[30%] -left-[20%] w-[80%] h-[80%] rounded-full blur-[120px] opacity-20" style={{ background: `linear-gradient(135deg, ${currentTheme.accent}, ${currentTheme.accent2})` }} />
        <div className="absolute -bottom-[30%] -right-[20%] w-[80%] h-[80%] rounded-full blur-[120px] opacity-15" style={{ background: `linear-gradient(135deg, ${currentTheme.glow1}, ${currentTheme.glow2})` }} />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff06_1px,transparent_1px),linear-gradient(to_bottom,#ffffff06_1px,transparent_1px)] bg-[size:56px_56px]" />
      </div>

      {/* Header - gọn */}
      <header className="sticky top-0 z-40 backdrop-blur-xl border-b" style={{ background: `${currentTheme.bg}B3`, borderColor: currentTheme.border }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-[56px] flex items-center justify-between gap-4">
          <button onClick={() => setMode("menu")} className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 group-hover:scale-105 transition">
              <span className="text-[18px]">👁️</span>
            </div>
            <div className="text-left">
              <div className="font-black tracking-tight leading-none text-[17px]">STAREDOWN</div>
              <div className="text-[11px] tracking-[0.18em] text-white/60 -mt-0.5">EAR {mode !== "menu" ? adaptiveThresholdUI.toFixed(2) : "ADAPTIVE"} • 120FPS • MEDIAPIPE</div>
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
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" /> NGƯỠNG EAR TỰ ĐỘNG {adaptiveThresholdUI.toFixed(2)} (0.15-0.24) • KẾT THÚC NGAY KHI NHẮM • MẮT HÍ & CHỚP NHANH
                </div>
                <h1 className="mt-3 text-3xl sm:text-[40px] font-black tracking-tight leading-[0.95]">
                  AI CHỚP MẮT <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-fuchsia-400 bg-clip-text text-transparent">TRƯỚC SẼ THUA</span>
                </h1>
                <p className="mt-2.5 text-sm text-white/65 leading-relaxed max-w-2xl">
                  Camera 60-120 FPS • Track liên tục • Tự động lưu kỷ lục. Giữ mắt mở, đừng rời khỏi khung hình — rời khung = thua &amp; tự lưu.
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10">Best: <b className="font-mono text-white">{bestSingleMs ? formatDuration(bestSingleMs) : "--"}</b></span>
                  <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10">{localScores.length} lượt • Top {Math.min(localScores.length,5)} local</span>
                  <span className="px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200">● 120FPS • EAR {adaptiveThresholdUI.toFixed(2)} • MẮT HÍ / CHỚP NHANH</span>
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
                  <p className="text-white/60 leading-relaxed text-[13px]">Bấm “Bắt đầu” → đếm 3-2-1 → giữ mắt mở. Nhắm mắt là thua ngay (EAR tự động {adaptiveThresholdUI.toFixed(2)}, chống nheo). Rời khung trong countdown cũng thua.</p>
                </div>
                <div className="space-y-1.5">
                  <div className="text-white font-bold flex gap-2"><span className="w-6 h-6 rounded-full bg-white text-black flex items-center justify-center text-xs font-black">3</span> Giữ khung hình</div>
                  <p className="text-white/60 leading-relaxed text-[13px]">Không rời khỏi camera, không nghiêng &gt;30°. Nếu mất track, ván đấu tự kết thúc &amp; lưu.</p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <span className="px-3 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/20 text-amber-200">⚠️ Không đeo kính râm</span>
                <span className="px-3 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/20 text-indigo-200">💡 Ánh sáng đều, tránh ngược sáng</span>
                <span className="px-3 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/20 text-emerald-200">🎥 60 FPS • ngưỡng {adaptiveThresholdUI.toFixed(2)} (auto)</span>
                <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-white/70">Rời khung = tự thua</span>
              </div>
            </div>

            {/* Mode cards */}
            <div className="grid md:grid-cols-3 gap-5">
              <button onClick={() => setMode("single")} className="group text-left relative overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-indigo-600/25 via-violet-600/15 to-transparent backdrop-blur p-6 sm:p-7 hover:border-indigo-400/30 hover:from-indigo-600/30 transition">
                <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/20 blur-[40px] rounded-full group-hover:bg-indigo-500/30 transition" />
                <div className="relative">
                  <div className="w-12 h-12 rounded-2xl bg-indigo-500 flex items-center justify-center text-xl shadow-lg shadow-indigo-500/20">🎯</div>
                  <h3 className="mt-4 text-xl font-extrabold">Local Highscore</h3>
                  <p className="text-sm text-white/65 mt-1">1 người • Tự động lưu kỷ lục sau mỗi ván. EAR tự động.</p>
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

              <button onClick={() => setMode("online")} className="group text-left relative overflow-hidden rounded-[24px] border border-cyan-500/20 bg-gradient-to-br from-cyan-600/25 via-blue-600/15 to-transparent backdrop-blur p-6 sm:p-7 hover:border-cyan-400/30 hover:from-cyan-600/30 transition">
                <div className="absolute top-3 right-3 px-2 py-1 rounded-full bg-amber-400 text-black text-[10px] font-black tracking-widest">BETA</div>
                <div className="absolute top-0 right-0 w-32 h-32 bg-cyan-500/20 blur-[40px] rounded-full group-hover:bg-cyan-500/30 transition" />
                <div className="relative">
                  <div className="w-12 h-12 rounded-2xl bg-cyan-500 flex items-center justify-center text-xl shadow-lg shadow-cyan-500/20">🌐</div>
                  <h3 className="mt-4 text-xl font-extrabold">Online Multiplayer <span className="text-xs font-bold px-2 py-1 rounded-full bg-amber-400 text-black ml-1">BETA</span></h3>
                  <p className="text-sm text-white/65 mt-1">1vs1 qua mạng • Random matchmaking + Friend Code.</p>
                  <ul className="mt-3 space-y-1.5 text-xs text-white/70">
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> LAN / Global tối ưu ping</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Friend code 6 ký tự</li>
                    <li className="flex gap-2"><span className="text-emerald-400">✓</span> Đồng bộ camera & countdown</li>
                  </ul>
                  <div className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-[#070a14] font-bold text-sm group-hover:translate-x-0.5 transition">
                    Chơi Online <span>→</span>
                  </div>
                </div>
              </button>
            </div>

            {/* Global Highscore - NEW */}
            <div className="rounded-[24px] border border-emerald-500/20 bg-gradient-to-br from-emerald-600/10 via-white/[0.03] to-transparent backdrop-blur p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 className="font-black flex items-center gap-2 text-sm tracking-widest text-emerald-200"><span className="w-7 h-7 rounded-lg bg-emerald-500/20 flex items-center justify-center">🌍</span> GLOBAL HIGHSCORE</h4>
                <div className="flex items-center gap-2">
                  <div className="flex p-1 rounded-full bg-white/5 border border-white/10">
                    <button onClick={() => setGlobalTab("alltime")} className={`px-3 py-1 rounded-full text-xs font-bold transition ${globalTab === "alltime" ? "bg-emerald-500 text-white shadow" : "text-white/60 hover:text-white"}`}>All-time Top 10</button>
                    <button onClick={() => setGlobalTab("weekly")} className={`px-3 py-1 rounded-full text-xs font-bold transition ${globalTab === "weekly" ? "bg-emerald-500 text-white shadow" : "text-white/60 hover:text-white"}`}>Weekly Top 50</button>
                  </div>
                  <button onClick={() => refreshGlobal()} disabled={globalLoading} className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-xs hover:bg-white/10 disabled:opacity-50">↻ {globalLoading ? "..." : "Làm mới"}</button>
                  <button onClick={handleDeleteMyGlobal} disabled={deleteGlobalLoading || !supabaseReady} title="Xóa tất cả điểm Global của máy này (theo client_id, không phụ thuộc tên)" className="px-3 py-1.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-200 text-xs hover:bg-red-500/25 disabled:opacity-50">🗑 {deleteGlobalLoading ? "..." : "Xóa của tôi"}</button>
                </div>
              </div>
              <div className="mt-1 text-xs text-white/50">
                Lưu vào Supabase • {supabaseReady ? `sẵn sàng • ${globalScoresFull.length} bản ghi` : supabaseError ?? "chưa cấu hình"} • Tên: <b className="text-white">{playerName}</b> • <span className="text-white/30">Client: {clientIdShort ? `${clientIdShort}…` : "…"}</span>
                <span className="ml-2 px-2 py-0.5 rounded-full text-[11px] border" style={{ borderColor: currentTheme.border, background: globalTab === "weekly" ? "rgba(16,185,129,0.15)" : "rgba(99,102,241,0.15)", color: globalTab === "weekly" ? "#6ee7b7" : "#a5b4fc" }}>
                  {globalTab === "alltime" ? "All-time • từ 01/09/2026" : `Weekly • ${getWeeklyRangeLabel()} • reset T2`}
                </span>
              </div>
              <div className="mt-4">
                {globalLoading ? (
                  <div className="py-8 text-center text-sm text-white/50">Đang tải bảng xếp hạng toàn cầu...</div>
                ) : !supabaseReady ? (
                  <div className="py-6 text-center text-sm text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl">Chưa cấu hình Supabase — bảng Global trống. Hãy thêm <code className="px-1 py-0.5 bg-white/10 rounded">NEXT_PUBLIC_SUPABASE_URL</code> trong <code>.env.local</code> rồi chạy lại <code>supabase.sql</code>.</div>
                ) : globalScoresFull.length === 0 ? (
                  <div className="py-8 text-center text-sm text-white/50 border border-dashed border-white/10 rounded-xl">Chưa có kỷ lục toàn cầu — hãy là người đầu tiên!</div>
                ) : (
                  <div className="space-y-2 max-h-[320px] overflow-auto pr-1">
                    {globalScoresFull.map((h, i) => {
                      const isMe = h.player_name === playerName.trim() && playerName.trim().length>0;
                      return (
                        <div key={h.id} className={`flex items-center gap-3 p-2.5 rounded-xl border transition ${isMe ? "bg-emerald-500/15 border-emerald-500/30 shadow shadow-emerald-500/10" : "bg-white/5 border-white/5 hover:bg-white/[0.07]"}`}>
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black shrink-0 ${i===0?"bg-amber-400 text-black":i===1?"bg-zinc-300 text-black":i===2?"bg-amber-700 text-white":"bg-white/10 text-white"}`}>{i+1}</div>
                          <div className="flex-1 min-w-0">
                            <div className={`text-sm font-bold truncate ${isMe?"text-emerald-300":""}`}>{h.player_name} {isMe && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500 text-white align-middle">YOU</span>}</div>
                            <div className="text-xs text-white/45">{new Date(h.created_at).toLocaleString("vi-VN")} • #{h.id.slice(0,6)}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono font-black text-emerald-200">{formatDuration(h.duration_ms)}</div>
                            <div className="text-[11px] text-white/40">{(h.duration_ms/1000).toFixed(2)}s</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="mt-3 text-xs text-white/40 flex flex-wrap gap-2 items-center justify-between">
                <span>Global sync sau mỗi ván • tự động làm mới</span>
                {supabaseReady && globalScoresFull.length>0 && <span className="text-emerald-300">● Live Supabase</span>}
              </div>
              <div className="mt-3 text-xs text-white/50 bg-white/5 border border-white/10 rounded-xl p-2.5">💡 <b>Xóa Global:</b> nút “Xóa của tôi” sẽ xóa tất cả bản ghi có <code className="px-1 py-0.5 bg-white/10 rounded">client_id</code> của máy bạn (được gắn khi đăng điểm), nên dù bạn đổi tên vẫn xóa đúng. Các điểm cũ trước khi có <code>client_id</code> sẽ được xóa qua lịch sử ID cục bộ nếu còn.</div>
            </div>

            {/* Theme customization */}
            <div className="rounded-[24px] border p-6 backdrop-blur" style={{ borderColor: currentTheme.border, background: `linear-gradient(135deg, ${currentTheme.card}, transparent)` }}>
              <h4 className="font-black flex items-center gap-2 text-sm tracking-widest" style={{ color: currentTheme.textAccent }}><span className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${currentTheme.accent}33` }}>🎨</span> TÙY CHỈNH GIAO DIỆN</h4>
              <div className="mt-1 text-xs text-white/50">Chọn bảng màu cho nền, viền và trang trí — áp dụng tức thì, lưu cục bộ</div>
              <div className="mt-4"><ThemePicker onChange={setCurrentTheme} /></div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="px-3 py-1.5 rounded-full border" style={{ borderColor: currentTheme.border, background: `${currentTheme.accent}22`, color: currentTheme.textAccent }}>Nền: {currentTheme.bg}</span>
                <span className="px-3 py-1.5 rounded-full border" style={{ borderColor: currentTheme.border, background: `${currentTheme.card}` }}>Viền: {currentTheme.border}</span>
                <span className="px-3 py-1.5 rounded-full text-white" style={{ background: `linear-gradient(135deg, ${currentTheme.accent}, ${currentTheme.accent2})` }}>Accent: {currentTheme.accent}</span>
              </div>
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
                  <div className="font-bold text-indigo-200">Ngưỡng tự động</div>
                  <div className="text-white/70 mt-1">EAR = <b className="text-white">{adaptiveThresholdUI.toFixed(2)}</b> (0.17-0.24) • Smoother {SMOOTHER_WINDOW} (EMA) • Đóng 1 frame = thua ngay • Tự hiệu chỉnh khi mở mắt, chống nheo + hỗ trợ kính.</div>
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
                  {phase === "ready" && `Sẵn sàng • EAR ${adaptiveThresholdUI.toFixed(2)}`}
                  {phase === "countdown" && `Chuẩn bị... ${countdown}`}
                  {phase === "playing" && "● ĐANG CHƠI • 120FPS"}
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
                            <div className="mt-1 font-black text-xl leading-tight">{elapsedMs < 500 ? "RỜI KHUNG KHI ĐẾM NGƯỢC" : "RỜI KHỎI VÙNG CAMERA"}</div>
                            <div className="mt-2 text-sm text-white/70 leading-relaxed">
                              {elapsedMs < 500
                                ? <>Bạn đã rời khỏi camera trong lúc đếm ngược 3-2-1. Ván đấu đã <b className="text-white">hủy và kết thúc ngay</b> (không tính điểm, cần &gt;0.5s mới lưu).</>
                                : <>Bạn đã rời khỏi vùng camera / không thể track đôi mắt. Lượt chơi đã <b className="text-white">tự động kết thúc</b> và kết quả <b className="font-mono text-white">{formatDuration(Math.round(elapsedMs))}</b> đã được <b className="text-emerald-300">lưu vào Local Highscore</b>.</>
                              }
                            </div>
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
                      {phase === "playing" && <span className="hidden sm:inline-flex px-2.5 py-1 rounded-full bg-emerald-500/90 text-white text-xs font-bold">● LIVE 120FPS</span>}
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
                    <span className="text-[11px] px-2 py-1 rounded-full bg-black/50 border border-white/10 text-white/70">Gương lật • EAR {adaptiveThresholdUI.toFixed(2)} auto</span>
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
                      <div className="font-mono font-bold text-sm">{adaptiveThresholdUI.toFixed(2)}</div>
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
                    <div className="mt-3 text-xs text-white/40">Ngưỡng {adaptiveThresholdUI.toFixed(2)} (auto 0.17-0.24) • Tự động lưu • Rời khung countdown cũng thua</div>
                  </div>
                )}

                {mode === "single" && (
                  <div className="rounded-[20px] border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
                    <div className="flex items-center justify-between">
                      <h4 className="font-bold text-sm flex items-center gap-2"><span className="w-6 h-6 rounded-lg bg-emerald-500/20 flex items-center justify-center text-xs">🌍</span> Top 5 Global {globalLoading && <span className="text-xs text-white/40">...</span>}</h4>
                      <button onClick={() => refreshGlobal()} className="text-xs px-2.5 py-1 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">↻</button>
                    </div>
                    <div className="mt-3 space-y-1.5 max-h-[180px] overflow-auto">
                      {!supabaseReady ? <div className="text-xs text-amber-200 text-center py-4">Chưa cấu hình Supabase</div> : globalScoresFull.length===0 ? <div className="text-xs text-white/50 text-center py-6">Chưa có Global</div> : globalScoresFull.slice(0,5).map((h, idx) => {
                        const isMe = h.player_name===playerName.trim();
                        return (
                          <div key={h.id} className={`flex items-center gap-2 text-sm p-2 rounded-xl border ${isMe?"bg-emerald-500/15 border-emerald-500/20":"bg-white/[0.04] border-white/5"}`}>
                            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${idx===0?"bg-amber-400 text-black":"bg-white/10"}`}>{idx+1}</span>
                            <span className="flex-1 truncate flex items-center gap-1">{h.player_name} {isMe && <span className="text-[10px] px-1 rounded bg-emerald-500 text-white">YOU</span>}</span>
                            <span className="font-mono text-emerald-300">{formatDuration(h.duration_ms)}</span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-2 text-xs text-white/40">Global sync Supabase • tự hiệu chỉnh EAR {adaptiveThresholdUI.toFixed(2)}</div>
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

        {mode === "online" && (
          <div className="space-y-5 animate-[fadeIn_0.3s]">
            {/* Top bar online */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <button onClick={() => { online.leaveRoom(); setMode("menu"); }} className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/15 border border-white/10 text-sm transition">← Về menu</button>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="px-2 py-1 rounded-full bg-cyan-500 text-white font-black text-[10px] tracking-widest">BETA</span>
                <span className={`px-3 py-1.5 rounded-full border text-xs font-bold ${online.phase === "searching" ? "bg-amber-500 text-black border-amber-400 animate-pulse" : online.phase === "room" || online.phase === "matched" ? "bg-cyan-600 text-white border-cyan-400" : phase === "playing" ? "bg-emerald-500 text-white border-emerald-400 animate-pulse" : phase === "countdown" ? "bg-amber-500 text-black border-amber-400" : phase === "finished" ? "bg-red-500 text-white border-red-400" : "bg-white/10 border-white/10"}`}>
                  {online.phase === "searching" ? `Đang tìm... ${online.searchingState}` : online.phase === "room" || online.phase === "matched" ? `Phòng ${online.roomCode}` : phase === "ready" ? "Sẵn sàng" : phase === "countdown" ? `Chuẩn bị ${countdown}` : phase === "playing" ? "● ONLINE LIVE" : phase === "finished" ? (endReason === "tracking_lost" ? "MẤT TRACK" : "Kết thúc") : "Chờ kết nối"}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
                  <span className={`w-2 h-2 rounded-full ${faceCount > 0 ? "bg-emerald-400" : "bg-red-400 animate-pulse"}`} /> {faceCount} mặt • {fps} FPS
                </span>
                <span className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-mono ${online.pingMs > 0 && online.pingMs < 80 ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200" : online.pingMs < 150 ? "bg-amber-500/15 border-amber-500/30 text-amber-200" : "bg-red-500/15 border-red-500/30 text-red-200"}`}>
                  Ping {online.pingMs ? `${Math.round(online.pingMs)}ms` : "--"} {online.isConnected && online.roomCode ? `• ${online.netMode.toUpperCase()}` : ""}
                </span>
              </div>
            </div>

            {/* Online mode notice */}
            <div className="rounded-[20px] border border-cyan-500/20 bg-cyan-500/10 p-3 flex flex-wrap gap-2 items-center justify-between text-xs">
              <div className="flex items-center gap-2"><span className="px-2 py-1 rounded-full bg-amber-400 text-black font-black text-[11px]">BETA</span><span className="text-white/80">Online Multiplayer đang thử nghiệm — tối ưu LAN (WebRTC P2P) & Global (Supabase Realtime). Ping được bù để công bằng.</span></div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${online.netMode === "lan" ? "bg-emerald-500 text-white border-emerald-400" : "bg-white/5 border-white/10"}`}>{online.netMode === "lan" ? "LAN: ~10-30ms" : "GLOBAL: ~50-120ms"} {online.isWebRTCReady ? "• P2P ✓" : online.netMode === "lan" ? "• Đang thử P2P..." : ""}</span>
            </div>

            <div className="grid lg:grid-cols-[1.45fr_0.85fr] gap-5">
              {/* Video area reused */}
              <div className="relative overflow-hidden rounded-[24px] border border-white/10 bg-black/60 backdrop-blur">
                {/* Split-screen camera: OmeTV style - Trái bạn / Phải đối thủ */}
                <div className="relative aspect-[16/9] sm:aspect-[18/10] bg-[#0a0f1e] overflow-hidden grid grid-cols-2 divide-x divide-white/10">
                  {/* Trái: Camera bạn */}
                  <div className="relative overflow-hidden bg-[#0a0f1e] group/left">
                    <video ref={videoRef} playsInline muted autoPlay className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                    {showDebug && faceCount > 0 && (
                      <div className="absolute inset-0" style={{ transform: "scaleX(-1)" }}>
                        <EyeOverlay landmarks={landmarksForOverlay} videoWidth={videoSize.w} videoHeight={videoSize.h} blinkState={blinkStates} />
                      </div>
                    )}
                    {/* Label bạn */}
                    <div className="absolute top-2 left-2 flex items-center gap-1.5">
                      <span className="px-2.5 py-1 rounded-full bg-cyan-500/90 border border-cyan-400 text-white text-[11px] font-black tracking-widest">BẠN</span>
                      <span className={`hidden sm:inline-flex px-2 py-1 rounded-full backdrop-blur border text-[11px] font-mono ${faceCount === 0 ? "bg-red-500/90 border-red-400 text-white animate-pulse" : "bg-black/60 border-white/15 text-white"}`}>{faceCount === 0 ? "Không thấy mặt" : "● LIVE"}</span>
                    </div>
                    <div className="absolute top-2 right-2 hidden sm:flex items-center gap-1">
                      {earValues.slice(0,1).map((ear, i) => (
                        <span key={i} className={`px-2 py-1 rounded-full border font-mono text-[11px] backdrop-blur ${blinkStates[i] === "closed" ? "bg-red-500 text-white border-red-400" : blinkStates[i] === "closing" ? "bg-amber-500 text-black border-amber-400" : "bg-black/60 border-white/15 text-white"}`}>{ear.toFixed(2)}</span>
                      ))}
                    </div>
                    <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                      <div className="flex gap-1.5">{Array.from({ length: 1 }).map((_, i) => (<div key={i} className={`w-2 h-2 rounded-full border border-white/20 shadow ${blinkStates[i] === "closed" ? "bg-red-500 shadow-red-500/30" : blinkStates[i] === "closing" ? "bg-amber-400" : faceCount > i ? "bg-emerald-400" : "bg-white/20"}`} />))}</div>
                      <span className="text-[10px] px-2 py-1 rounded-full bg-black/60 border border-white/10 text-white/80 truncate max-w-[60%]">{playerName || "Bạn"} • EAR {adaptiveThresholdUI.toFixed(2)}</span>
                    </div>
                    {phase === "playing" && <div className="absolute inset-0 pointer-events-none opacity-20"><div className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-[scanline_2s_linear_infinite]" /></div>}
                  </div>
                  {/* Phải: Camera đối thủ - trống nếu chưa ghép */}
                  <div className="relative overflow-hidden bg-gradient-to-br from-[#0e1220] to-[#111a2e] flex items-center justify-center">
                    {online.remoteStream && online.opponent ? (
                      <>
                        <video ref={remoteVideoRef} playsInline autoPlay className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
                        <div className="absolute top-2 left-2 flex items-center gap-1.5">
                          <span className="px-2.5 py-1 rounded-full bg-fuchsia-500/90 border border-fuchsia-400 text-white text-[11px] font-black tracking-widest">ĐỐI THỦ</span>
                          <span className={`px-2 py-1 rounded-full text-[11px] font-bold border backdrop-blur ${online.opponent.cameraReady ? "bg-emerald-500 text-white border-emerald-400" : "bg-amber-500/20 text-amber-200 border-amber-500/30"}`}>{online.opponent.cameraReady ? "✓ Sẵn sàng" : "○ Chưa sẵn sàng"}</span>
                        </div>
                        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                          <span className="text-[11px] px-2 py-1 rounded-full bg-black/60 border border-white/10 text-white truncate max-w-[65%]">{online.opponent.name} • {online.opponent.friendCode}</span>
                          <span className={`text-[11px] px-2 py-1 rounded-full border font-mono ${online.pingMs < 80 ? "bg-emerald-500/20 border-emerald-500/30 text-emerald-200" : online.pingMs < 150 ? "bg-amber-500/20 border-amber-500/30 text-amber-200" : "bg-red-500/20 border-red-500/30 text-red-200"}`}>{Math.round(online.pingMs)}ms</span>
                        </div>
                        <div className="absolute top-2 right-2 px-2 py-1 rounded-full bg-black/60 border border-white/10 text-[10px] text-white/70">{online.netMode.toUpperCase()} {online.isWebRTCReady ? "• P2P" : ""}</div>
                        {phase === "playing" && <div className="absolute inset-0 pointer-events-none opacity-15"><div className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-fuchsia-400 to-transparent animate-[scanline_2s_linear_infinite]" /></div>}
                      </>
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center bg-[radial-gradient(circle_at_50%_30%,rgba(99,102,241,0.15),transparent_60%)]">
                        <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-2xl mb-3">{online.phase === "searching" ? "🔍" : online.opponent ? "👤" : "📷"}</div>
                        <div className="text-sm font-bold text-white/90">{online.phase === "searching" ? "Đang tìm đối thủ..." : online.opponent ? online.opponent.name : "Chưa có đối thủ"}</div>
                        <div className="text-xs text-white/50 mt-1 leading-relaxed max-w-[220px]">
                          {online.phase === "searching" ? online.searchingState || "Đang ghép cặp ngẫu nhiên..." : online.phase === "room" && !online.opponent ? "Phòng đã tạo • đang chờ người vào" : "Để trống nếu không có đối tượng để ghép vào (kiểu OmeTV). Hãy tạo phòng hoặc dùng Random."}
                        </div>
                        {online.phase === "searching" && <div className="mt-3 w-8 h-8 border-2 border-white/20 border-t-cyan-400 rounded-full animate-spin" />}
                        {!online.opponent && online.phase !== "searching" && (
                          <div className="mt-3 flex gap-2">
                            <button onClick={() => online.startRandomMatchmaking(online.netMode)} className="px-3 py-1.5 rounded-full bg-cyan-500 text-white text-xs font-bold hover:bg-cyan-400">🎲 Tìm nhanh</button>
                            <button onClick={() => online.createRoomWithVisibility("public")} className="px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-white text-xs hover:bg-white/15">+ Tạo phòng</button>
                          </div>
                        )}
                        <div className="absolute top-2 left-2 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-white/50 text-[11px] font-black tracking-widest">ĐỐI THỦ</div>
                        <div className="absolute bottom-2 left-2 right-2 flex justify-center">
                          <span className="text-[11px] px-2.5 py-1 rounded-full bg-black/40 border border-white/10 text-white/60">Trống • chờ ghép cặp</span>
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Shared overlays covering both */}
                  {trackingWarning && phase !== "finished" && (
                    <div className="absolute top-10 left-1/2 -translate-x-1/2 flex justify-center pointer-events-none z-10">
                      <div className="px-3 py-2 rounded-xl bg-amber-500 text-black text-xs font-bold shadow-lg flex items-center gap-2 animate-pulse"><span>⚠️</span><span>{phase === "playing" ? "Mất tín hiệu — giữ mặt trong khung!" : "Không thấy mặt — vào camera, đủ sáng"}</span></div>
                    </div>
                  )}
                  {phase === "countdown" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/45 backdrop-blur-[2px] z-10">
                      <div className="text-[72px] sm:text-[96px] font-black leading-none tracking-tighter text-white drop-shadow-[0_8px_30px_rgba(6,182,212,0.6)] animate-[pulse-eye_0.9s_ease_infinite]">{countdown === 0 ? "GO!" : countdown}</div>
                      <div className="text-xs sm:text-sm tracking-[0.3em] text-white/70 mt-2">ONLINE • ĐỪNG CHỚP • PING {Math.round(online.pingMs || 0)}ms</div>
                    </div>
                  )}
                  {phase === "finished" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4 z-20">
                      <div className={`w-full max-w-md rounded-[20px] border backdrop-blur p-5 sm:p-6 text-center shadow-2xl ${endReason === "tracking_lost" ? "bg-red-950/90 border-red-500/30" : winner === 1 ? "bg-emerald-950/90 border-emerald-500/30" : winner === 2 ? "bg-red-950/90 border-red-500/30" : "bg-[#0f1220]/90 border-white/15"}`}>
                        {endReason === "tracking_lost" ? (
                          <>
                            <div className="w-12 h-12 mx-auto rounded-2xl bg-red-500 flex items-center justify-center text-xl">⚠️</div>
                            <div className="mt-3 text-xs tracking-[0.2em] text-red-300">MẤT TÍN HIỆU</div>
                            <div className="mt-1 font-black text-xl leading-tight">{elapsedMs < 500 ? "RỜI KHUNG KHI ĐẾM NGƯỢC" : "ĐỐI THỦ / BẠN RỜI KHUNG"}</div>
                            <div className="mt-2 text-sm text-white/70">{winner === 1 ? "Đối thủ rời khung — bạn thắng!" : winner === 2 ? "Bạn rời khung — bạn thua!" : "Mất kết nối camera."}</div>
                            <div className="mt-1 font-mono text-white/80">{formatDuration(Math.round(elapsedMs))} • Ping {Math.round(online.pingMs)}ms</div>
                          </>
                        ) : (
                          <>
                            <div className="text-4xl">{winner === 1 ? "🏆" : winner === 2 ? "😵" : winner === "draw" ? "🤝" : "👁️"}</div>
                            <div className="mt-2 font-black text-2xl">{winner === 1 ? "BẠN THẮNG!" : winner === 2 ? "BẠN THUA!" : winner === "draw" ? "HÒA!" : "KẾT THÚC"}</div>
                            <div className="text-sm text-white/60 mt-1">{winner === 1 ? "Đối thủ đã chớp trước" : winner === 2 ? "Bạn đã chớp trước" : winner === "draw" ? "Cả hai chớp cùng lúc!" : `Thời gian ${formatDuration(Math.round(elapsedMs))}`}</div>
                            <div className="mt-1 font-mono text-white/80">{formatDuration(Math.round(elapsedMs))} • Ping {Math.round(online.pingMs)}ms {online.isWebRTCReady ? "• P2P" : ""}</div>
                            {online.opponent && <div className="text-xs text-white/50 mt-1">vs {online.opponent.name} ({online.opponent.friendCode})</div>}
                          </>
                        )}
                        <div className="mt-5 grid grid-cols-2 gap-2.5">
                          <button onClick={() => { setPhase("ready"); setWinner(null); setEndReason(null); onlineBlinkTsRef.current = { local: null, remote: null }; }} className="py-2.5 rounded-full bg-white text-black font-bold text-sm hover:bg-zinc-100">Sẵn sàng lại</button>
                          <button onClick={() => { online.leaveRoom(); setMode("menu"); }} className="py-2.5 rounded-full bg-white/10 border border-white/15 font-bold text-sm hover:bg-white/15">Rời phòng</button>
                        </div>
                      </div>
                    </div>
                  )}
                  {phase === "ready" && online.phase !== "room" && online.phase !== "matched" && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 z-10">
                      <div className="text-center text-white/80 text-sm">Vào phòng hoặc tìm trận để bắt đầu<br/><span className="text-xs text-white/50">Camera đã sẵn sàng • EAR {adaptiveThresholdUI.toFixed(2)}</span></div>
                    </div>
                  )}
                </div>
                <div className="p-4 sm:p-5 bg-gradient-to-b from-transparent to-white/[0.03] border-t border-white/10 flex flex-wrap gap-2.5 items-center justify-between">
                  <div className="flex flex-wrap gap-2.5">
                    {phase === "ready" && online.phase === "room" && (
                      <>
                        <button onClick={() => online.updateCameraReady(!online.selfCameraReady)} className={`px-5 py-2.5 rounded-full font-bold text-sm transition border ${online.selfCameraReady ? "bg-emerald-500 text-white border-emerald-400" : "bg-white/10 border-white/15 hover:bg-white/15"}`}>{online.selfCameraReady ? "✓ Đã sẵn sàng" : "○ Sẵn sàng Camera"}</button>
                        {online.role === "host" && <button onClick={triggerCountdown} disabled={!online.opponent || !online.opponent.cameraReady || !online.selfCameraReady} className="px-6 py-2.5 rounded-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed font-bold text-sm shadow-lg shadow-cyan-600/20 transition">▶ Bắt đầu Online {(!online.opponent || !online.opponent.cameraReady) ? "(chờ đối thủ)" : ""}</button>}
                        {online.role === "guest" && <span className="px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-sm text-white/60">Chờ host bắt đầu...</span>}
                      </>
                    )}
                    {phase === "playing" && <button onClick={() => { setEndReason("blink"); setWinner(2); setPhase("finished"); }} className="px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/15 border border-white/15 text-sm font-semibold">Dừng</button>}
                    {phase === "finished" && <button onClick={() => { setPhase("ready"); setWinner(null); setEndReason(null); onlineBlinkTsRef.current = { local: null, remote: null }; }} className="px-6 py-2.5 rounded-full bg-white text-black font-bold text-sm hover:bg-zinc-100">↻ Sẵn sàng lại</button>}
                    {online.phase === "room" && <button onClick={() => online.leaveRoom()} className="px-4 py-2.5 rounded-full bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-sm">✕ Rời phòng</button>}
                    <button onClick={() => { stopCamera(); setTimeout(() => startCamera(), 250); }} className="px-4 py-2.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-sm">↻ Reload cam</button>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`px-2.5 py-1 rounded-full border text-xs font-mono ${online.pingMs < 80 ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-200" : online.pingMs < 150 ? "bg-amber-500/15 border-amber-500/30 text-amber-200" : "bg-red-500/15 border-red-500/30 text-red-200"}`}>Ping {Math.round(online.pingMs) || "--"}ms</span>
                    <label className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10"><input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} className="accent-cyan-500" /> Debug</label>
                  </div>
                </div>
                {cameraError && <div className="mx-4 mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-200 flex gap-2"><span>⚠️</span> <span>{cameraError}</span></div>}
                {lmState.status === "error" && <div className="mx-4 mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-sm text-amber-200">{lmState.message}</div>}
              </div>

              {/* Right panel - Online Lobby */}
              <div className="space-y-4">
                <div className="rounded-[24px] border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] backdrop-blur p-5 sm:p-6">
                  <div className="flex items-center justify-between">
                    <div className="text-xs tracking-[0.18em] text-white/50 font-semibold">ONLINE LOBBY • BETA</div>
                    <div className="flex items-center gap-2">
                      {onlineCopyFeedback && <span className="text-[11px] px-2 py-1 rounded-full bg-emerald-500 text-white font-bold animate-[fadeIn_0.2s]">{onlineCopyFeedback}</span>}
                      <div className={`w-2 h-2 rounded-full ${online.isConnected ? "bg-emerald-400 animate-pulse shadow shadow-emerald-400/50" : "bg-white/20"}`} />
                    </div>
                  </div>
                  {/* Tài khoản */}
                  <div className="mt-3">
                    <div className="text-xs text-white/50">Tài khoản & mã bạn bè</div>
                    <div className="mt-1 flex gap-2">
                      <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="Tên bạn (hiển thị)" maxLength={18} className="flex-1 px-3 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-cyan-400 outline-none text-sm" />
                      <div className="px-3 py-2 rounded-xl bg-cyan-500/15 border border-cyan-500/20 text-xs font-mono self-center flex items-center gap-1.5 shrink-0">
                        <span className="font-black tracking-widest">{online.friendCode}</span>
                        {online.isConnected && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2 text-xs flex-wrap">
                      <button onClick={() => { const c = online.regenerateCode(); setOnlineFriendInput(c); setOnlineCopyFeedback("Đã đổi mã ✓"); }} className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">↻ Đổi mã</button>
                      <button onClick={() => { navigator.clipboard?.writeText(online.friendCode); setOnlineCopyFeedback("Đã copy mã ✓"); }} className="px-3 py-1.5 rounded-full bg-cyan-500/15 border border-cyan-500/20 text-cyan-200 hover:bg-cyan-500/20">⎘ Copy mã</button>
                      <button onClick={() => { if (navigator.share) navigator.share({ title: "Staredown - Friend Code", text: `Mã bạn bè của tôi: ${online.friendCode} - vào Staredown Online để đấu!` }).catch(()=>{}); else { navigator.clipboard?.writeText(online.friendCode); setOnlineCopyFeedback("Đã copy mã ✓"); } }} className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:bg-white/10">↗ Chia sẻ</button>
                    </div>
                  </div>
                  {/* Net mode */}
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button onClick={() => online.setNetMode("global")} className={`py-2.5 rounded-xl border text-xs font-bold transition ${online.netMode === "global" ? "bg-cyan-500 text-white border-cyan-400 shadow" : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"}`}>🌍 Global • Realtime</button>
                    <button onClick={() => online.setNetMode("lan")} className={`py-2.5 rounded-xl border text-xs font-bold transition ${online.netMode === "lan" ? "bg-emerald-500 text-white border-emerald-400 shadow" : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"}`}>🏠 LAN • P2P</button>
                  </div>
                  <div className="text-xs text-white/40 mt-1.5 flex justify-between"><span>{online.netMode === "lan" ? "LAN: WebRTC P2P ~10-30ms" : "Global: ~50-120ms + bù ping"}</span><span className={online.isWebRTCReady ? "text-emerald-300" : "text-white/30"}>{online.isWebRTCReady ? "P2P ✓" : online.netMode === "lan" ? "đang thử P2P..." : ""}</span></div>
                  {/* Trạng thái phòng hiện tại */}
                  <div className="mt-4">
                    {online.phase === "idle" || online.phase === "searching" ? (
                      <div className="space-y-2">
                        <button onClick={() => online.phase === "searching" ? online.cancelMatchmaking() : online.startRandomMatchmaking(online.netMode)} className={`w-full py-3.5 rounded-xl font-black text-sm transition flex items-center justify-center gap-2 ${online.phase === "searching" ? "bg-amber-500 text-black animate-pulse" : "bg-gradient-to-r from-cyan-600 to-blue-600 text-white hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-600/20"}`}>
                          {online.phase === "searching" ? <><span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" /> Hủy tìm • {online.searchingState}</> : <>🎲 Ghép ngẫu nhiên ({online.netMode.toUpperCase()})</>}
                        </button>
                        <div className="text-[11px] text-white/35 text-center">Tự động tìm phòng Public trống • không cần mã</div>
                        {online.errorMsg && <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/20 rounded-xl p-2.5 flex gap-2"><span>⚠️</span><span>{online.errorMsg}</span></div>}
                      </div>
                    ) : (
                      <div className="p-3 rounded-xl bg-gradient-to-br from-cyan-500/15 to-blue-500/10 border border-cyan-500/20 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="font-bold text-sm">Phòng <span className="font-mono text-cyan-300 tracking-widest text-base">{online.roomCode}</span></div>
                          <span className={`text-[11px] px-2 py-1 rounded-full font-black ${online.role === "host" ? "bg-amber-400 text-black" : "bg-white/10 border border-white/10 text-white/70"}`}>{online.role === "host" ? "HOST" : "GUEST"}</span>
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => { navigator.clipboard?.writeText(online.roomCode || ""); setOnlineCopyFeedback(`Đã copy mã phòng ${online.roomCode} ✓`); }} className="flex-1 py-2 rounded-xl bg-white text-black text-xs font-black hover:bg-zinc-100">⎘ Copy mã phòng</button>
                          <button onClick={() => online.leaveRoom()} className="px-4 py-2 rounded-xl bg-red-500/15 border border-red-500/20 text-red-200 text-xs font-bold hover:bg-red-500/20">✕ Rời</button>
                        </div>
                        <div className="text-xs text-white/60 flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />{online.searchingState || (online.opponent ? `vs ${online.opponent.name}` : "Đang chờ đối thủ vào...")} • {online.netMode.toUpperCase()} {online.isWebRTCReady ? "• P2P" : ""}</div>
                      </div>
                    )}
                  </div>
                  {/* Tạo phòng & Nhập mã - cải thiện */}
                  <div className="mt-4 p-3.5 rounded-xl bg-white/5 border border-white/10 space-y-4">
                    {/* Tạo phòng */}
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-black tracking-widest text-white/70">TẠO PHÒNG</div>
                        <span className="text-[11px] text-white/40">1-click • hiện ngay trong danh sách</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <button onClick={() => online.setRoomVisibility("public")} className={`py-2.5 rounded-xl border text-xs font-bold transition flex flex-col items-center gap-0.5 ${online.roomVisibility === "public" ? "bg-emerald-500 text-white border-emerald-400 shadow" : "bg-black/20 border-white/10 text-white/60 hover:bg-white/10"}`}>
                          <span>🌐 Public</span><span className="text-[11px] opacity-70">Ai cũng vào được</span>
                        </button>
                        <button onClick={() => online.setRoomVisibility("friend")} className={`py-2.5 rounded-xl border text-xs font-bold transition flex flex-col items-center gap-0.5 ${online.roomVisibility === "friend" ? "bg-amber-500 text-black border-amber-400 shadow" : "bg-black/20 border-white/10 text-white/60 hover:bg-white/10"}`}>
                          <span>🔒 Friend-only</span><span className="text-[11px] opacity-70">Cần mã mới vào</span>
                        </button>
                      </div>
                      <button onClick={() => { const code = online.createRoomWithVisibility(online.roomVisibility); setOnlineCopyFeedback(`Đã tạo phòng ${code} ✓`); }} disabled={online.phase === "room" || online.phase === "matched"} className="mt-2 w-full py-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 text-white text-sm font-black hover:from-cyan-500 hover:to-blue-500 disabled:opacity-40 disabled:cursor-not-allowed shadow">
                        + Tạo phòng {online.roomVisibility === "public" ? "Public" : "Friend-only"} — {online.netMode.toUpperCase()}
                      </button>
                      {online.phase === "room" && online.roomCode && <div className="mt-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-center"><span className="text-xs text-white/60">Mã phòng của bạn: </span><span className="font-mono font-black text-emerald-300 tracking-widest">{online.roomCode}</span><span className="ml-2 text-xs text-white/50">• đang chờ đối thủ (split-screen phải trống cho tới khi có người vào)</span></div>}
                    </div>
                    {/* Nhập mã - cải thiện với validation */}
                    <div className="border-t border-white/10 pt-4">
                      <div className="text-xs font-black tracking-widest text-white/70">NHẬP MÃ ĐỂ VÀO PHÒNG</div>
                      <div className="mt-2 flex gap-2">
                        <div className="flex-1 relative">
                          <input value={onlineFriendInput} onChange={e => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); setOnlineFriendInput(v); if (v.length>=4) setOnlineJoinCode(v); }} placeholder="Nhập mã 6 ký tự (VD: A1B2C3)" maxLength={8} className="w-full px-3 py-2.5 rounded-xl bg-black/30 border border-white/10 focus:border-cyan-400 outline-none font-mono text-sm uppercase tracking-widest" />
                          {onlineFriendInput.length>0 && <button onClick={() => setOnlineFriendInput("")} className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white/10 text-white/60 text-xs flex items-center justify-center hover:bg-white/15">✕</button>}
                        </div>
                        <button onClick={() => { if (onlineFriendInput.trim().length>=4) { online.joinFriendRoom(onlineFriendInput); setOnlineCopyFeedback(`Đang vào phòng ${onlineFriendInput}...`); } else { setOnlineCopyFeedback("Mã phải 4-8 ký tự"); } }} disabled={onlineFriendInput.trim().length<4} className="px-5 py-2.5 rounded-xl bg-cyan-500 text-white text-sm font-black hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed shrink-0">Vào phòng</button>
                      </div>
                      <div className="mt-1.5 text-[11px] text-white/35">Nhận mã từ bạn bè hoặc copy từ danh sách bên dưới • tự động chuyển chữ hoa, lọc ký tự lạ</div>
                      {online.errorMsg && online.phase === "room" && <div className="mt-2 text-xs text-red-200 bg-red-500/10 border border-red-500/20 rounded-lg p-2">{online.errorMsg}</div>}
                    </div>
                    {/* Danh sách phòng - cải thiện search */}
                    <div className="border-t border-white/10 pt-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs font-black tracking-widest text-white/70">TÌM PHÒNG • {online.netMode.toUpperCase()}</div>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => online.subscribeLobby(online.netMode)} className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs hover:bg-white/10">↻ Làm mới</button>
                          <div className="flex p-1 rounded-full bg-black/20 border border-white/10">
                            <button onClick={() => setOnlineLobbyTab("public")} className={`px-2.5 py-1 rounded-full text-xs font-bold transition ${onlineLobbyTab === "public" ? "bg-cyan-500 text-white shadow" : "text-white/60 hover:text-white"}`}>Public</button>
                            <button onClick={() => setOnlineLobbyTab("all")} className={`px-2.5 py-1 rounded-full text-xs font-bold transition ${onlineLobbyTab === "all" ? "bg-cyan-500 text-white shadow" : "text-white/60 hover:text-white"}`}>Tất cả</button>
                          </div>
                        </div>
                      </div>
                      {/* Search */}
                      <div className="mt-2 relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30 text-sm">🔍</span>
                        <input value={onlineRoomSearch} onChange={e => setOnlineRoomSearch(e.target.value)} placeholder="Tìm theo mã phòng hoặc tên host..." className="w-full pl-9 pr-8 py-2.5 rounded-xl bg-black/30 border border-white/10 focus:border-cyan-400 outline-none text-sm" />
                        {onlineRoomSearch && <button onClick={() => setOnlineRoomSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-white/10 text-white/60 text-xs flex items-center justify-center hover:bg-white/15">✕</button>}
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-white/35">
                        <span>{(() => { const q = onlineRoomSearch.trim().toUpperCase(); const base = online.publicRooms.filter(r => onlineLobbyTab === "public" ? r.visibility === "public" : true); const filtered = q ? base.filter(r => r.code.includes(q) || r.hostName.toUpperCase().includes(q)) : base; return `${filtered.length} phòng ${q ? `• lọc "${q}"` : ""}`; })()}</span>
                        <span className="hidden sm:inline">Bấm Vào để tham gia ngay</span>
                      </div>
                      <div className="mt-2 space-y-2 max-h-[220px] overflow-auto pr-1 custom-scrollbar">
                        {(() => {
                          const q = onlineRoomSearch.trim().toUpperCase();
                          const base = online.publicRooms.filter(r => onlineLobbyTab === "public" ? r.visibility === "public" : true);
                          const filtered = q ? base.filter(r => r.code.includes(q) || r.hostName.toUpperCase().includes(q)) : base;
                          const sorted = [...filtered].sort((a,b) => b.createdAt - a.createdAt);
                          if (sorted.length === 0) {
                            return (
                              <div className="text-xs text-white/40 text-center py-6 border border-dashed border-white/10 rounded-xl leading-relaxed">
                                {q ? `Không tìm thấy phòng nào khớp "${q}"` : "Chưa có phòng nào — hãy tạo Public để hiện ở đây"}
                                <br/><span className="text-white/30">{q ? "Thử xóa bộ lọc hoặc đổi tab Tất cả" : "Random sẽ ghép nhanh vào phòng Public trống"}</span>
                                {!q && <div className="mt-3"><button onClick={() => online.createRoomWithVisibility("public")} className="px-4 py-2 rounded-full bg-cyan-500 text-white text-xs font-bold hover:bg-cyan-400">+ Tạo Public ngay</button></div>}
                              </div>
                            );
                          }
                          return sorted.map(r => (
                            <div key={r.code} className="flex items-center gap-2 p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/[0.07] hover:border-white/10 transition">
                              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500/20 to-blue-500/20 border border-white/10 flex items-center justify-center text-xs font-black shrink-0">{r.code.slice(0,2)}</div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-mono font-bold flex items-center gap-1.5 flex-wrap">{r.code} <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-black ${r.visibility === "public" ? "bg-emerald-500 text-white" : "bg-amber-500 text-black"}`}>{r.visibility === "public" ? "Public" : "Friend"}</span> <span className="text-[10px] px-1 py-0.5 rounded-full bg-white/10 border border-white/10">{r.netMode.toUpperCase()}</span></div>
                                <div className="text-xs text-white/50 truncate flex items-center gap-1"><span>{r.hostName}</span><span className="w-1 h-1 rounded-full bg-white/20" />{new Date(r.createdAt).toLocaleTimeString("vi-VN")}<span className="hidden sm:inline">• {Math.floor((Date.now()-r.createdAt)/1000/60)} phút trước</span></div>
                              </div>
                              <div className="flex flex-col gap-1 shrink-0">
                                {r.visibility === "public" ? (
                                  <button onClick={() => online.joinPublicRoom(r.code)} className="px-4 py-1.5 rounded-full bg-emerald-500 text-white text-xs font-bold hover:bg-emerald-400 shadow">Vào</button>
                                ) : (
                                  <span className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/40 text-center">Cần mã</span>
                                )}
                                <button onClick={() => { navigator.clipboard?.writeText(r.code); setOnlineCopyFeedback(`Đã copy ${r.code} ✓`); setOnlineFriendInput(r.code); }} className="px-2 py-1 rounded-full bg-white/5 border border-white/10 text-[11px] text-white/60 hover:bg-white/10">⎘ Copy</button>
                              </div>
                            </div>
                          ));
                        })()}
                      </div>
                      <div className="text-xs text-white/30 mt-2 flex gap-2 flex-wrap"><span>💡 Public: vào tùy ý</span><span>• Friend-only: cần mã</span><span>• Có ô tìm kiếm theo mã/tên</span><span>• Tự sắp xếp mới nhất lên đầu</span></div>
                    </div>
                  </div>
                </div>

                <div className="rounded-[20px] border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
                  <h4 className="font-bold text-sm flex items-center gap-2"><span className="w-6 h-6 rounded-lg bg-cyan-500/20 flex items-center justify-center text-xs">👥</span> Đối thủ {online.opponent ? <span className="text-emerald-300">• Đã kết nối</span> : <span className="text-white/40">• Chưa có</span>}</h4>
                  {online.opponent ? (
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/5 border border-white/5">
                        <div className="w-10 h-10 rounded-xl bg-white text-black flex items-center justify-center font-black">{online.opponent.name.slice(0,1).toUpperCase()}</div>
                        <div className="flex-1">
                          <div className="font-bold text-sm">{online.opponent.name}</div>
                          <div className="text-xs text-white/50 font-mono">{online.opponent.friendCode}</div>
                        </div>
                        <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${online.opponent.cameraReady ? "bg-emerald-500 text-white border-emerald-400" : "bg-amber-500/20 text-amber-200 border-amber-500/30"}`}>{online.opponent.cameraReady ? "✓ Sẵn sàng" : "○ Chưa"}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-xl bg-black/30 border border-white/5 p-2.5"><div className="text-[11px] text-white/50">PING BẠN</div><div className="font-mono font-bold text-sm text-cyan-300">{Math.round(online.pingMs) || "--"}ms</div></div>
                        <div className="rounded-xl bg-black/30 border border-white/5 p-2.5"><div className="text-[11px] text-white/50">PING ĐỐI THỦ</div><div className="font-mono font-bold text-sm text-cyan-300">{Math.round(online.opponentPingMs) || "--"}ms</div></div>
                        <div className="rounded-xl bg-black/30 border border-white/5 p-2.5"><div className="text-[11px] text-white/50">CHẾ ĐỘ</div><div className="font-bold text-sm">{online.netMode.toUpperCase()} {online.isWebRTCReady ? "P2P" : ""}</div></div>
                      </div>
                      <div className="text-xs text-white/40">Đảm bảo cả hai camera đã sẵn sàng (thấy mặt) mới bắt đầu được. Ping được bù để chống desync.</div>
                    </div>
                  ) : (
                    <div className="mt-3 text-xs text-white/50 text-center py-6 border border-dashed border-white/10 rounded-xl">Chưa có đối thủ — dùng Random hoặc Friend Code để ghép.</div>
                  )}
                </div>

                <div className="rounded-[20px] border border-amber-500/20 bg-amber-500/10 p-4">
                  <div className="text-xs font-bold tracking-widest text-amber-200">BETA • TỐI ƯU MẠNG</div>
                  <ul className="mt-2 space-y-1.5 text-xs text-white/70 leading-relaxed">
                    <li>• LAN: thử WebRTC P2P trực tiếp, nếu không được fallback Supabase, ping ~10-30ms</li>
                    <li>• Global: Supabase Realtime Broadcast, ping ~50-120ms, bù ½ RTT để công bằng</li>
                    <li>• Đếm ngược & chớp được đồng bộ bằng timestamp, nếu lệch &lt;120ms tính hòa</li>
                    <li>• Camera cả hai phải sẵn sàng (thấy mặt) mới cho phép Start — tránh lệch trạng thái</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="mt-auto border-t border-white/5 py-5 text-center text-xs text-white/30">
        <div className="max-w-6xl mx-auto px-4">
          © 2026 Staredown • EAR tự động {adaptiveThresholdUI.toFixed(2)} • 60-120 FPS • MediaPipe 478 pts • v0.6.4 • SuddenDrop 0.04/3f • build 2026-09-03
        </div>
      </footer>
    </div>
  );
}
