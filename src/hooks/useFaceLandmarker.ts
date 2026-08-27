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
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
      landmarkerRef.current = landmarker;
      setState({ status: "ready", landmarker });
      return landmarker;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FaceLandmarker] init failed", msg);
      // Retry with CPU delegate if GPU fails
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
        );
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numFaces,
          outputFaceBlendshapes: true,
        });
        landmarkerRef.current = landmarker;
        setState({ status: "ready", landmarker });
        return landmarker;
      } catch (e2: unknown) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        setState({ status: "error", message: msg2 });
        return null;
      }
    }
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
