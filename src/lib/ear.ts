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

// Smoothing with EMA for faster response (alpha 0.6) + small SMA fallback
export class EARSmoother {
  private buf: number[] = [];
  private ema: number | null = null;
  constructor(private windowSize = 2, private alpha = 0.65) {}
  push(v: number): number {
    // EMA gives immediate response, SMA buffers tiny noise
    if (this.ema === null) this.ema = v;
    else this.ema = this.alpha * v + (1 - this.alpha) * this.ema;
    this.buf.push(v);
    if (this.buf.length > this.windowSize) this.buf.shift();
    // Blend EMA (70%) + SMA (30%) for stability without lag
    const sma = this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
    return this.ema * 0.7 + sma * 0.3;
  }
  reset() { this.buf = []; this.ema = null; }
  getLastRaw(): number | null { return this.buf.length ? this.buf[this.buf.length-1] : null; }
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

// Robustness for glasses + squint:
// - Glasses: landmarks may be noisy, blendshape is more reliable -> blend >0.65 alone triggers
// - Squint: EAR ~0.17-0.20 but blend low (0.2-0.4) should NOT trigger, need true close
// - True close: EAR < threshold-0.03 (deep) triggers even without blend
export function isEyeClosed(ear: number, avgBlend: number | null, threshold: number): boolean {
  const blend = avgBlend ?? 0;
  if (blend > 0.65) return true; // strong blend alone (glasses case)
  if (ear < threshold - 0.03) return true; // deep close, EAR alone enough
  if (ear < threshold - 0.02 && blend > 0.25) return true; // moderately deep + some blend
  if (ear < threshold && blend > 0.38) return true; // just below threshold needs blend corroboration (squint protection)
  // Fallback: if EAR very low (< threshold) but blend unavailable (null -> 0), we still want to catch full close
  // So if ear < threshold * 0.85 (~0.17 when thresh 0.20) -> treat as closed even with low blend
  if (ear < threshold * 0.84) return true;
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
