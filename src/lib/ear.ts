// Eye Aspect Ratio utilities for MediaPipe FaceLandmarker 478 landmarks
// Landmark indices based on MediaPipe Face Mesh
export const LEFT_EYE = {
  // p1, p2, p3, p4, p5, p6 for EAR
  indices: [33, 160, 158, 133, 153, 144] as const,
  // For drawing
  outline: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246] as const,
};
export const RIGHT_EYE = {
  indices: [362, 385, 387, 263, 373, 380] as const,
  outline: [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398] as const,
};

type Point = { x: number; y: number; z?: number };

function dist(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function calcEAR(landmarks: Point[], eye: typeof LEFT_EYE | typeof RIGHT_EYE): number {
  const pts = eye.indices.map(i => landmarks[i]);
  if (pts.some(p => !p)) return 0.3; // fallback open
  const [p1, p2, p3, p4, p5, p6] = pts;
  const vertical1 = dist(p2, p6);
  const vertical2 = dist(p3, p5);
  const horizontal = dist(p1, p4);
  if (horizontal === 0) return 0.3;
  return (vertical1 + vertical2) / (2 * horizontal);
}

export function calcAvgEAR(landmarks: Point[]): number {
  const left = calcEAR(landmarks, LEFT_EYE);
  const right = calcEAR(landmarks, RIGHT_EYE);
  return (left + right) / 2;
}

// Smoothing with EMA for faster response - tuned for quick blink (alpha 0.75, window 1 for minimal lag)
export class EARSmoother {
  private buf: number[] = [];
  private ema: number | null = null;
  constructor(private windowSize = 1, private alpha = 0.78) {}
  push(v: number): number {
    // EMA gives immediate response, tiny SMA for stability
    if (this.ema === null) this.ema = v;
    else this.ema = this.alpha * v + (1 - this.alpha) * this.ema;
    this.buf.push(v);
    if (this.buf.length > this.windowSize) this.buf.shift();
    // Blend EMA 85% + SMA 15% - more responsive for quick blink
    const sma = this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
    return this.ema * 0.85 + sma * 0.15;
  }
  reset() { this.buf = []; this.ema = null; }
  getLastRaw(): number | null { return this.buf.length ? this.buf[this.buf.length-1] : null; }
  getSmoothed(): number | null { return this.ema; }
}

// Adaptive threshold - tối ưu cho mắt hí (nhỏ) và chớp nhanh
// baseline <0.23 = mắt hí → dùng hệ số nhỏ hơn + clamp thấp hơn để nhạy hơn
export function getAdaptiveThreshold(baselineOpenEAR: number): number {
  if (!isFinite(baselineOpenEAR) || baselineOpenEAR < 0.15 || baselineOpenEAR > 0.45) return 0.20;
  const isSmallEye = baselineOpenEAR < 0.23;
  const mult = isSmallEye ? 0.58 : 0.62;
  const low = isSmallEye ? 0.15 : 0.17;
  const high = isSmallEye ? 0.22 : 0.24;
  const raw = baselineOpenEAR * mult;
  return Math.min(high, Math.max(low, raw));
}

// Hỗ trợ mắt hí (EAR mở thấp 0.16-0.21) và chớp cực nhanh (80-120ms ≈ 1-2 frame @120fps)
// - Mắt hí: baseline thấp → threshold thấp, cần phát hiện với độ giảm nhỏ hơn + blend nhẹ
// - Chớp nhanh: không kịp giảm sâu, dựa vào velocity (raw vs smoothed) + blend
export function isEyeClosed(ear: number, avgBlend: number | null, threshold: number): boolean {
  const blend = avgBlend ?? 0;
  const isSmallEyeMode = threshold <= 0.17; // suy ra từ baseline <0.23

  // Blend mạnh → nhắm (kính hoặc chớp nhanh). Hạ ngưỡng cho mắt hí
  if (isSmallEyeMode ? blend > 0.48 : blend > 0.55) return true;

  // Nhắm sâu so với ngưỡng (dung sai nhỏ hơn cho mắt hí)
  if (isSmallEyeMode) {
    if (ear < threshold - 0.012) return true; // mắt hí chỉ cần giảm 0.012 so với ngưỡng thấp
    if (ear < threshold - 0.008 && blend > 0.18) return true;
    if (ear < threshold && blend > 0.22) return true;
    if (ear < threshold * 0.90) return true; // nhạy hơn cho mắt hí (0.135 với thresh 0.15)
    if (ear < threshold * 0.95 && blend > 0.12) return true;
  } else {
    if (ear < threshold - 0.02) return true;
    if (ear < threshold - 0.015 && blend > 0.20) return true;
    if (ear < threshold && blend > 0.30) return true;
    if (ear < threshold * 0.88) return true;
    if (ear < threshold * 0.92 && blend > 0.15) return true;
  }
  return false;
}

// Chớp cực nhanh: check raw trước, velocity raw vs smoothed
export function isEyeClosedQuick(rawEar: number, smoothedEar: number, avgBlend: number | null, threshold: number): boolean {
  if (isEyeClosed(rawEar, avgBlend, threshold)) return true;
  if (isEyeClosed(smoothedEar, avgBlend, threshold)) return true;
  const isSmallEyeMode = threshold <= 0.17;
  // Velocity: raw giảm đột ngột so với smoothed → chớp nhanh
  // Mắt hí cần velocity nhỏ hơn (0.03), mắt thường 0.035
  const velThresh = isSmallEyeMode ? 0.028 : 0.035;
  if (rawEar < smoothedEar - velThresh && rawEar < threshold * 1.02) {
    // kèm blend nhẹ hoặc đã dưới ngưỡng thì tính
    if ((avgBlend ?? 0) > 0.12 || rawEar < threshold) return true;
  }
  // Trường hợp chớp siêu nhanh chỉ 1 frame: raw giảm mạnh nhưng chưa kịp cập nhật smoothed
  if (rawEar < threshold * 0.92 && (avgBlend ?? 0) > 0.10) return true;
  return false;
}

// Deprecated: đã xóa logic Delta EAR theo yêu cầu - giữ stub để không vỡ import cũ
export function isEyeClosedDelta(
  rawEar: number,
  smoothedEar: number,
  baseline: number | null,
  avgBlend: number | null,
  threshold: number
): { closed: boolean; delta: number | null; method: "delta" | "legacy" | "none" } {
  const closed = isEyeClosedQuick(rawEar, smoothedEar, avgBlend, threshold);
  return { closed, delta: null, method: closed ? "legacy" : "none" };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const msRemainder = ms % 1000;
  if (minutes > 0) {
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(Math.floor(msRemainder / 10)).padStart(2, "0")}`;
  }
  return `${String(seconds).padStart(2, "0")}.${String(Math.floor(msRemainder / 10)).padStart(2, "0")}s`;
}
