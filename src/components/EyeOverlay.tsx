"use client";
import { useEffect, useRef } from "react";
import { LEFT_EYE, RIGHT_EYE } from "@/lib/ear";

type Props = {
  landmarks?: { x: number; y: number }[][];
  videoWidth: number;
  videoHeight: number;
  blinkState?: ("open" | "closing" | "closed")[];
};

export default function EyeOverlay({ landmarks, videoWidth, videoHeight, blinkState }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = videoWidth;
    canvas.height = videoHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!landmarks || landmarks.length === 0) return;

    landmarks.forEach((face, idx) => {
      const state = blinkState?.[idx] ?? "open";
      const color = state === "closed" ? "rgba(239,68,68,0.95)" : state === "closing" ? "rgba(251,146,60,0.9)" : "rgba(99,102,241,0.95)";
      const fill = state === "closed" ? "rgba(239,68,68,0.25)" : "rgba(99,102,241,0.12)";

      // Draw eye outlines
      [LEFT_EYE, RIGHT_EYE].forEach(eye => {
        ctx.beginPath();
        eye.outline.forEach((lmIdx, i) => {
          const pt = face[lmIdx];
          if (!pt) return;
          const x = pt.x * canvas.width;
          const y = pt.y * canvas.height;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw landmark dots for the 6 EAR points
        eye.indices.forEach(idx2 => {
          const p = face[idx2];
          if (!p) return;
          ctx.beginPath();
          ctx.arc(p.x * canvas.width, p.y * canvas.height, 1.8, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        });
      });

      // Face index label
      const nose = face[1];
      if (nose) {
        ctx.fillStyle = color;
        ctx.font = "bold 13px ui-sans-serif";
        ctx.fillText(`P${idx + 1}`, nose.x * canvas.width - 14, nose.y * canvas.height - 28);
      }
    });
  }, [landmarks, videoWidth, videoHeight, blinkState]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" style={{ transform: "scaleX(-1)" }} />;
}
