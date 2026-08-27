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

// Smoothing with simple moving average
export class EARSmoother {
  private buf: number[] = [];
  constructor(private windowSize = 5) {}
  push(v: number): number {
    this.buf.push(v);
    if (this.buf.length > this.windowSize) this.buf.shift();
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }
  reset() { this.buf = []; }
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
