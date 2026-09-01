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

// Adaptive threshold based on open-eye baseline
// - baseline 0.28 -> 0.28*0.62=0.174 -> clamp 0.17
// - baseline 0.32 -> ~0.198
// - baseline 0.22 (small eyes) -> clamp 0.17 to avoid too sensitive
export function getAdaptiveThreshold(baselineOpenEAR: number): number {
  if (!isFinite(baselineOpenEAR) || baselineOpenEAR < 0.15 || baselineOpenEAR > 0.45) return 0.20;
  const raw = baselineOpenEAR * 0.62;
  // Clamp to handle glasses/squint: not too low (squint false) not too high (miss blink)
  return Math.min(0.24, Math.max(0.17, raw));
}

// Robustness for glasses + squint + QUICK BLINK:
// - Quick blink: eye closes for only 1-2 frames (80-120ms), need to catch even if not super deep
// - Glasses: blendshape more reliable -> blend >0.55 alone triggers (lowered from 0.65 for speed)
// - Squint: EAR ~0.17-0.20 but blend low (0.2-0.35) should NOT trigger, need true close
export function isEyeClosed(ear: number, avgBlend: number | null, threshold: number): boolean {
  const blend = avgBlend ?? 0;
  if (blend > 0.55) return true; // strong blend alone - lowered for quick blink (glasses)
  if (ear < threshold - 0.02) return true; // deep close - less deep required (was -0.03)
  if (ear < threshold - 0.015 && blend > 0.20) return true; // moderately deep + some blend (lowered)
  if (ear < threshold && blend > 0.30) return true; // just below threshold needs blend (lowered from 0.38)
  // Quick blink via raw EAR: if EAR drops to < threshold * 0.90 (e.g., 0.18 for thresh 0.20) even with low blend, it's likely a quick close
  if (ear < threshold * 0.88) return true; // was 0.84, now 0.88 more sensitive (0.176 for 0.20)
  // Extra quick check: if EAR is < threshold * 0.92 and blend >0.15, also quick
  if (ear < threshold * 0.92 && blend > 0.15) return true;
  return false;
}

// For quick blink, check both raw and smoothed - if either triggers, count as closed
export function isEyeClosedQuick(rawEar: number, smoothedEar: number, avgBlend: number | null, threshold: number): boolean {
  // Check raw first for speed (no smoothing lag), then smoothed for stability
  if (isEyeClosed(rawEar, avgBlend, threshold)) return true;
  if (isEyeClosed(smoothedEar, avgBlend, threshold)) return true;
  // Extra: if raw is significantly lower than smoothed, indicates rapid close
  if (rawEar < smoothedEar - 0.04 && rawEar < threshold) return true;
  return false;
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
