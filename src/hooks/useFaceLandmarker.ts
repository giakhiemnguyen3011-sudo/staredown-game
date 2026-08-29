"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

export type FaceLandmarkerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; landmarker: FaceLandmarker }
  | { status: "error"; message: string };

export function useFaceLandmarker(numFaces = 2) {
  const [state, setState] = useState<FaceLandmarkerState>({ status: "idle" });
  const landmarkerRef = useRef<FaceLandmarker | null>(null);

  const init = useCallback(async () => {
    if (landmarkerRef.current) return landmarkerRef.current;
    setState({ status: "loading" });
    // FIX kính/không kính đều không track: wasm path cũ 0.10.14 không khớp @mediapipe/tasks-vision 1.0.1 -> init fail hoàn toàn
    // npm 1.0.1 docs dùng "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm" (unversioned)
    const wasmRoots = [
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm",
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm",
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
    ];
    const delegates: ("GPU" | "CPU")[] = ["GPU", "CPU"];
    let lastErr: unknown = null;
    for (const wasmRoot of wasmRoots) {
      for (const delegate of delegates) {
        try {
          const vision = await FilesetResolver.forVisionTasks(wasmRoot);
          const landmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
              modelAssetPath:
                "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
              delegate,
            },
            runningMode: "VIDEO",
            numFaces,
            // Hạ ngưỡng để nhận diện được cả khi đeo kính (gọng/kính phản chiếu làm giảm confidence) - 0.3 thay vì 0.5 mặc định
            minFaceDetectionConfidence: 0.3,
            minFacePresenceConfidence: 0.3,
            minTrackingConfidence: 0.3,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: false,
          });
          landmarkerRef.current = landmarker;
          setState({ status: "ready", landmarker });
          console.log(`[FaceLandmarker] ready via ${wasmRoot} delegate=${delegate}`);
          return landmarker;
        } catch (e: unknown) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[FaceLandmarker] init failed wasm=${wasmRoot} delegate=${delegate}:`, msg);
        }
      }
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error("[FaceLandmarker] all init attempts failed", msg);
    setState({ status: "error", message: msg });
    return null;
  }, [numFaces]);

  useEffect(() => {
    init();
    return () => {
      try {
        landmarkerRef.current?.close();
      } catch {}
      landmarkerRef.current = null;
    };
  }, [init]);

  return { state, init, landmarkerRef };
}
