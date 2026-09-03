"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { getSupabase } from "@/lib/supabase";
import { getOrCreateAccount, generateFriendCode, PingTracker } from "@/lib/online";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type OnlineNetMode = "lan" | "global";
export type OnlinePhase = "idle" | "searching" | "matched" | "room" | "countdown" | "playing" | "finished";
export type OnlineRole = "host" | "guest" | null;

type Opponent = {
  id: string;
  name: string;
  friendCode: string;
  cameraReady: boolean;
  ping?: number;
};

type RoomEvent =
  | { type: "camera_ready"; from: string; ready: boolean; name: string; friendCode: string }
  | { type: "countdown_start"; from: string; startAt: number } // host timestamp
  | { type: "blink"; from: string; ts: number }
  | { type: "tracking_lost"; from: string; ts: number }
  | { type: "ping"; from: string; t0: number }
  | { type: "pong"; from: string; t0: number; t1: number }
  | { type: "webrtc_offer"; from: string; sdp: string }
  | { type: "webrtc_answer"; from: string; sdp: string }
  | { type: "webrtc_ice"; from: string; candidate: RTCIceCandidateInit }
  | { type: "leave"; from: string };

type _MatchmakingEvent =
  | { type: "searching"; from: string; name: string; friendCode: string; ts: number }
  | { type: "match_invite"; from: string; to: string; roomCode: string; name: string }
  | { type: "match_accept"; from: string; to: string; roomCode: string };

export function useOnline(playerName: string) {
  const [account, setAccount] = useState(() => ({ id: "ssr", friendCode: "XXXXXX" }));
  const [friendCode, setFriendCode] = useState("XXXXXX");
  useEffect(() => {
    const acc = getOrCreateAccount();
    setAccount(acc);
    setFriendCode(acc.friendCode);
  }, []);
  const [netMode, setNetMode] = useState<OnlineNetMode>("global");
  const [phase, setPhase] = useState<OnlinePhase>("idle");
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [role, setRole] = useState<OnlineRole>(null);
  const [opponent, setOpponent] = useState<Opponent | null>(null);
  const [selfCameraReady, setSelfCameraReady] = useState(false);
  const [pingMs, setPingMs] = useState(0);
  const [opponentPingMs, setOpponentPingMs] = useState(0);
  const [searchingState, setSearchingState] = useState<string>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [publicRooms, setPublicRooms] = useState<Array<{ code: string; hostName: string; hostId: string; visibility: "public" | "friend"; createdAt: number; netMode: OnlineNetMode }>>([]);
  // keep legacy alias for roomCode vs code mismatch fix
  const [roomVisibility, setRoomVisibility] = useState<"public" | "friend">("public");

  const matchmakingChannelRef = useRef<RealtimeChannel | null>(null);
  const roomChannelRef = useRef<RealtimeChannel | null>(null);
  const lobbyChannelRef = useRef<RealtimeChannel | null>(null);
  const pingTrackerRef = useRef(new PingTracker(5));
  const accountRef = useRef(account);
  const playerNameRef = useRef(playerName);
  const phaseRef = useRef(phase);
  const roomCodeRef = useRef(roomCode);
  const selfReadyRef = useRef(selfCameraReady);

  // WebRTC refs for LAN optimization + remote video
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const webrtcReadyRef = useRef(false);
  const [isWebRTCReady, setIsWebRTCReady] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pingIntervalRef = useRef<number | null>(null);

  useEffect(() => { accountRef.current = account; }, [account]);
  useEffect(() => { playerNameRef.current = playerName; }, [playerName]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { roomCodeRef.current = roomCode; }, [roomCode]);
  useEffect(() => { selfReadyRef.current = selfCameraReady; }, [selfCameraReady]);

  // Regen friend code
  const regenerateCode = useCallback(() => {
    const newCode = generateFriendCode();
    localStorage.setItem("staredown_friend_code_v1", newCode);
    setFriendCode(newCode);
    setAccount(prev => ({ ...prev, friendCode: newCode }));
    return newCode;
  }, []);

  const addLocalStream = useCallback((stream: MediaStream) => {
    localStreamRef.current = stream;
    if (pcRef.current) {
      try {
        stream.getTracks().forEach(track => {
          // Avoid adding duplicate senders
          const senders = pcRef.current!.getSenders();
          if (!senders.find(s => s.track && s.track.id === track.id)) {
            pcRef.current!.addTrack(track, stream);
          }
        });
        console.log("[webrtc] added local tracks", stream.getTracks().length);
      } catch (e) { console.warn("[webrtc] addTrack failed", e); }
    }
  }, []);

  // Cleanup helper
  const cleanupMatchmaking = useCallback(() => {
    if (matchmakingChannelRef.current) {
      try { getSupabase()?.removeChannel(matchmakingChannelRef.current); } catch {}
      matchmakingChannelRef.current = null;
    }
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const cleanupRoom = useCallback(() => {
    if (roomChannelRef.current) {
      try { getSupabase()?.removeChannel(roomChannelRef.current); } catch {}
      roomChannelRef.current = null;
    }
    if (lobbyChannelRef.current) {
      try { getSupabase()?.removeChannel(lobbyChannelRef.current); } catch {}
      lobbyChannelRef.current = null;
    }
    // close webrtc
    try { dcRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
    dcRef.current = null;
    pcRef.current = null;
    webrtcReadyRef.current = false;
    setIsWebRTCReady(false);
    if (pingIntervalRef.current) {
      window.clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const cleanupAll = useCallback(() => {
    cleanupMatchmaking();
    cleanupRoom();
    setPhase("idle");
    setRoomCode(null);
    setRole(null);
    setOpponent(null);
    setSelfCameraReady(false);
    setSearchingState("idle");
    setIsConnected(false);
  }, [cleanupMatchmaking, cleanupRoom]);

  // Room channel creation (shared for friend code and matched)
  const joinRoomChannel = useCallback((code: string, asRole: OnlineRole) => {
    const supabase = getSupabase();
    if (!supabase) { setErrorMsg("Supabase chưa cấu hình"); return null; }
    if (roomChannelRef.current) {
      try { supabase.removeChannel(roomChannelRef.current); } catch {}
    }
    const upper = code.toUpperCase();
    const channel = supabase.channel(`online:room:${upper}`, {
      config: { broadcast: { self: false }, presence: { key: accountRef.current.id } }
    });

    let pingInterval: number | null = null;

    const startPingLoop = () => {
      // ping every 900ms for minimal desync, adaptive
      const intervalMs = netMode === "lan" ? 500 : 900;
      pingInterval = window.setInterval(() => {
        const t0 = Date.now();
        // try webrtc first if ready
        if (webrtcReadyRef.current && dcRef.current?.readyState === "open") {
          try { dcRef.current.send(JSON.stringify({ type: "ping", from: accountRef.current.id, t0 })); } catch {}
        } else {
          channel.send({ type: "broadcast", event: "ping", payload: { from: accountRef.current.id, t0 } });
        }
      }, intervalMs as unknown as number) as unknown as number;
      pingIntervalRef.current = pingInterval;
    };

    channel
      .on("broadcast", { event: "camera_ready" }, ({ payload }: { payload: RoomEvent & { name: string; friendCode: string; ready: boolean } }) => {
        if (payload.from === accountRef.current.id) return;
        setOpponent(prev => {
          if (!prev || prev.id !== payload.from) {
            return { id: payload.from, name: payload.name, friendCode: payload.friendCode, cameraReady: payload.ready };
          }
          return { ...prev, cameraReady: payload.ready };
        });
      })
      .on("broadcast", { event: "countdown_start" }, ({ payload }: { payload: { from: string; startAt: number } }) => {
        if (payload.from === accountRef.current.id) return;
        // Guest receives countdown start, caller will handle in UI via callback
        // We dispatch custom event via window for page.tsx to listen? Instead expose via callback ref
        // Store in window dispatch
        window.dispatchEvent(new CustomEvent("online:countdown_start", { detail: payload }));
      })
      .on("broadcast", { event: "blink" }, ({ payload }: { payload: { from: string; ts: number } }) => {
        if (payload.from === accountRef.current.id) return;
        window.dispatchEvent(new CustomEvent("online:blink", { detail: payload }));
      })
      .on("broadcast", { event: "tracking_lost" }, ({ payload }: { payload: { from: string; ts: number } }) => {
        if (payload.from === accountRef.current.id) return;
        window.dispatchEvent(new CustomEvent("online:tracking_lost", { detail: payload }));
      })
      .on("broadcast", { event: "ping" }, ({ payload }: { payload: { from: string; t0: number } }) => {
        if (payload.from === accountRef.current.id) return;
        const t1 = Date.now();
        // reply pong via same transport
        if (webrtcReadyRef.current && dcRef.current?.readyState === "open") {
          try { dcRef.current.send(JSON.stringify({ type: "pong", from: accountRef.current.id, t0: payload.t0, t1 })); } catch {}
        } else {
          channel.send({ type: "broadcast", event: "pong", payload: { from: accountRef.current.id, t0: payload.t0, t1 } });
        }
      })
      .on("broadcast", { event: "pong" }, ({ payload }: { payload: { from: string; t0: number; t1: number } }) => {
        if (payload.from === accountRef.current.id) return; // pong from self? ignore
        // actually pong.from is opponent, t0 is our original
        const t2 = Date.now();
        const rtt = t2 - payload.t0;
        const avg = pingTrackerRef.current.push(rtt);
        setPingMs(avg);
        // also estimate opponent ping as symmetric
        setOpponentPingMs(rtt); // rough
      })
      // WebRTC signaling
      .on("broadcast", { event: "webrtc_offer" }, async ({ payload }: { payload: { from: string; sdp: string } }) => {
        if (payload.from === accountRef.current.id) return;
        // Guest receives offer
        try {
          await ensurePeer(false);
          await pcRef.current!.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: payload.sdp }));
          const answer = await pcRef.current!.createAnswer();
          await pcRef.current!.setLocalDescription(answer);
          channel.send({ type: "broadcast", event: "webrtc_answer", payload: { from: accountRef.current.id, sdp: answer.sdp! } });
        } catch (e) { console.warn("[webrtc] offer handling failed", e); }
      })
      .on("broadcast", { event: "webrtc_answer" }, async ({ payload }: { payload: { from: string; sdp: string } }) => {
        if (payload.from === accountRef.current.id) return;
        try {
          await pcRef.current?.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: payload.sdp }));
        } catch (e) { console.warn("[webrtc] answer handling failed", e); }
      })
      .on("broadcast", { event: "webrtc_ice" }, async ({ payload }: { payload: { from: string; candidate: RTCIceCandidateInit } }) => {
        if (payload.from === accountRef.current.id) return;
        try { await pcRef.current?.addIceCandidate(new RTCIceCandidate(payload.candidate)); } catch (e) { console.warn("[webrtc] ice failed", e); }
      })
      .on("broadcast", { event: "leave" }, ({ payload }: { payload: { from: string } }) => {
        if (payload.from === accountRef.current.id) return;
        setErrorMsg("Đối thủ đã rời phòng");
        // keep room but show opponent left
        setOpponent(null);
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        // presenceState values are arrays of presence objects
        const all = Object.values(state).flat() as unknown as Array<{ user_id?: string; id?: string; name?: string; friendCode?: string; cameraReady?: boolean }>;
        // Find opponent presence (not self)
        const opp = all.find(p => (p.user_id ?? (p as unknown as { id: string }).id) !== accountRef.current.id);
        if (opp) {
          const oid = (opp as unknown as { user_id: string }).user_id ?? (opp as unknown as { id: string }).id;
          setOpponent(prev => ({
            id: oid,
            name: (opp as unknown as { name: string }).name ?? prev?.name ?? "Opponent",
            friendCode: (opp as unknown as { friendCode: string }).friendCode ?? prev?.friendCode ?? "------",
            cameraReady: (opp as unknown as { cameraReady: boolean }).cameraReady ?? prev?.cameraReady ?? false,
          }));
          setIsConnected(true);
        }
      });

    // Helper for webrtc peer
    const ensurePeer = async (isInitiator: boolean) => {
      if (pcRef.current) return;
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
          { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
          { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
        ],
      });
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          channel.send({ type: "broadcast", event: "webrtc_ice", payload: { from: accountRef.current.id, candidate: e.candidate.toJSON() } });
        }
      };
      pc.onconnectionstatechange = () => {
        console.log("[webrtc] state", pc.connectionState);
        if (pc.connectionState === "connected") {
          webrtcReadyRef.current = true;
          setIsWebRTCReady(true);
          console.log("[webrtc] P2P ready, switching to data channel for low ping");
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          webrtcReadyRef.current = false;
          setIsWebRTCReady(false);
        }
      };
      pc.ontrack = (event) => {
        console.log("[webrtc] ontrack", event.track.kind, event.streams[0]?.id);
        const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
        setRemoteStream(stream);
      };
      // If we already have a local stream (camera), add its tracks now
      if (localStreamRef.current) {
        try {
          localStreamRef.current.getTracks().forEach(track => {
            if (!pc.getSenders().find(s => s.track?.id === track.id)) pc.addTrack(track, localStreamRef.current!);
          });
        } catch (e) { console.warn("[webrtc] addTrack on ensurePeer failed", e); }
      }
      if (isInitiator) {
        const dc = pc.createDataChannel("game", { ordered: true });
        dc.onopen = () => { webrtcReadyRef.current = true; setIsWebRTCReady(true); console.log("[webrtc] dc open initiator"); };
        dc.onclose = () => { webrtcReadyRef.current = false; setIsWebRTCReady(false); };
        dc.onmessage = (ev) => handleDCMessage(ev.data);
        dcRef.current = dc;
      } else {
        pc.ondatachannel = (ev) => {
          const dc = ev.channel;
          dc.onopen = () => { webrtcReadyRef.current = true; setIsWebRTCReady(true); console.log("[webrtc] dc open guest"); };
          dc.onclose = () => { webrtcReadyRef.current = false; setIsWebRTCReady(false); };
          dc.onmessage = (ev2) => handleDCMessage(ev2.data);
          dcRef.current = dc;
        };
      }
      pcRef.current = pc;
      if (isInitiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        channel.send({ type: "broadcast", event: "webrtc_offer", payload: { from: accountRef.current.id, sdp: offer.sdp! } });
      }
    };

    const handleDCMessage = (data: string) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "ping" && msg.from !== accountRef.current.id) {
          const t1 = Date.now();
          dcRef.current?.send(JSON.stringify({ type: "pong", from: accountRef.current.id, t0: msg.t0, t1 }));
        } else if (msg.type === "pong") {
          const t2 = Date.now();
          const rtt = t2 - msg.t0;
          const avg = pingTrackerRef.current.push(rtt);
          setPingMs(avg);
        } else if (msg.type === "camera_ready") {
          setOpponent(prev => prev ? { ...prev, cameraReady: msg.ready } : { id: msg.from, name: msg.name, friendCode: msg.friendCode, cameraReady: msg.ready });
        } else if (msg.type === "countdown_start") {
          window.dispatchEvent(new CustomEvent("online:countdown_start", { detail: msg }));
        } else if (msg.type === "blink") {
          window.dispatchEvent(new CustomEvent("online:blink", { detail: msg }));
        } else if (msg.type === "tracking_lost") {
          window.dispatchEvent(new CustomEvent("online:tracking_lost", { detail: msg }));
        }
      } catch (e) { console.warn("[webrtc] dc parse failed", e); }
    };

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ user_id: accountRef.current.id, name: playerNameRef.current, friendCode: friendCode, cameraReady: selfReadyRef.current });
        setIsConnected(true);
        setPhase("room");
        setRoomCode(upper);
        setRole(asRole);
        startPingLoop();
        // Hỗ trợ cross-network 2 vùng: WebRTC cho cả LAN & Global (STUN+TURN), host luôn tạo offer
        if (asRole === "host") {
          setTimeout(() => ensurePeer(true).catch(e=>console.warn(e)), 1200);
        }
        console.log(`[online] joined room ${upper} as ${asRole}`);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setErrorMsg(`Không vào được phòng ${upper} (${status})`);
        setPhase("idle");
      }
    });

    roomChannelRef.current = channel;
    return channel;
  }, [friendCode, netMode]);

  // Lobby for Public / Friend-only rooms listing
  const subscribeLobby = useCallback((mode: OnlineNetMode = "global") => {
    const supabase = getSupabase();
    if (!supabase) return;
    // if already subscribed to same mode lobby, keep
    if (lobbyChannelRef.current) {
      try { supabase.removeChannel(lobbyChannelRef.current); } catch {}
      lobbyChannelRef.current = null;
    }
    const channel = supabase.channel(`online:lobby:${mode}`, {
      config: { broadcast: { self: false }, presence: { key: accountRef.current.id } }
    });
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as unknown as Record<string, Array<{ roomCode: string; code?: string; hostName: string; hostId: string; visibility: "public" | "friend"; createdAt: number; netMode: OnlineNetMode }>>;
      const all = Object.values(state).flat();
      // deduplicate by roomCode/code
      const map = new Map<string, typeof all[0]>();
      all.forEach(r => {
        const c = (r as unknown as { code?: string; roomCode?: string }).code || (r as unknown as { roomCode?: string }).roomCode;
        if (c && !map.has(c)) map.set(c, r);
      });
      const mapped = Array.from(map.values()).map(r => {
        const c = (r as unknown as { code?: string; roomCode?: string }).code || (r as unknown as { roomCode?: string }).roomCode || "";
        return { code: c, hostName: r.hostName, hostId: r.hostId, visibility: r.visibility, createdAt: r.createdAt, netMode: r.netMode };
      }).filter(r => r.netMode === mode).slice(0, 20);
      setPublicRooms(mapped as unknown as Array<{ code: string; hostName: string; hostId: string; visibility: "public" | "friend"; createdAt: number; netMode: OnlineNetMode }>);
    });
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // track as observer (no room) to receive presence, but don't announce
        await channel.track({ observer: true, id: accountRef.current.id } as unknown as Record<string, unknown>);
        console.log(`[lobby] subscribed ${mode}`);
      }
    });
    lobbyChannelRef.current = channel;
  }, []);

  const announceRoomInLobby = useCallback((code: string, visibility: "public" | "friend", mode: OnlineNetMode) => {
    const supabase = getSupabase();
    if (!supabase) return;
    const upper = code.toUpperCase();
    // Optimistic: hiện ngay trong tìm kiếm khi vừa tạo, kèm tag PUBLIC/FRIEND + tên host
    setPublicRooms(prev => {
      if (prev.some(r => r.code === upper)) return prev;
      const newRoom = { code: upper, hostName: playerNameRef.current || "Bạn", hostId: accountRef.current.id, visibility, createdAt: Date.now(), netMode: mode };
      return [newRoom, ...prev].slice(0, 20);
    });
    const lobbyChannelName = `online:lobby:${mode}`;
    if (lobbyChannelRef.current) {
      try { supabase.removeChannel(lobbyChannelRef.current); } catch {}
      lobbyChannelRef.current = null;
    }
    const channel = supabase.channel(lobbyChannelName, {
      config: { broadcast: { self: false }, presence: { key: accountRef.current.id } }
    });
    // Đặt handler trước subscribe để không lỡ sync
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState() as unknown as Record<string, Array<{ roomCode: string; code?: string; hostName: string; hostId: string; visibility: "public" | "friend"; createdAt: number; netMode: OnlineNetMode }>>;
      const all = Object.values(state).flat();
      const map = new Map<string, typeof all[0]>();
      all.forEach(r => {
        const c = (r as unknown as { code?: string; roomCode?: string }).code || (r as unknown as { roomCode?: string }).roomCode;
        if (c && !map.has(c)) map.set(c, r);
      });
      const mapped = Array.from(map.values()).map(r => {
        const c = (r as unknown as { code?: string; roomCode?: string }).code || (r as unknown as { roomCode?: string }).roomCode || "";
        return { code: c, hostName: r.hostName, hostId: r.hostId, visibility: r.visibility, createdAt: r.createdAt, netMode: r.netMode };
      }).filter(r => r.netMode === mode && r.code).slice(0, 20);
      if (mapped.length > 0) setPublicRooms(mapped as unknown as Array<{ code: string; hostName: string; hostId: string; visibility: "public" | "friend"; createdAt: number; netMode: OnlineNetMode }>);
    });
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ code: upper, roomCode: upper, hostName: playerNameRef.current || "Bạn", hostId: accountRef.current.id, visibility, createdAt: Date.now(), netMode: mode });
        console.log(`[lobby] announced room ${upper} ${visibility} ${mode} by ${playerNameRef.current}`);
      }
    });
    lobbyChannelRef.current = channel;
  }, []);

  const createRoomWithVisibility = useCallback((visibility: "public" | "friend") => {
    const code = visibility === "public" ? generateFriendCode() : friendCode; // public uses random, friend uses own code for easy share
    cleanupMatchmaking();
    joinRoomChannel(code, "host");
    setRoomVisibility(visibility);
    setPhase("room");
    setSearchingState(visibility === "public" ? `Phòng Public ${code} • chờ người vào...` : `Phòng Friend-only ${code} • chờ bạn bè...`);
    // announce in lobby
    announceRoomInLobby(code, visibility, netMode);
    return code;
  }, [friendCode, netMode, joinRoomChannel, cleanupMatchmaking, announceRoomInLobby]);

  // Matchmaking via presence on shared channel
  const startRandomMatchmaking = useCallback((mode: OnlineNetMode) => {
    const supabase = getSupabase();
    if (!supabase) { setErrorMsg("Supabase chưa cấu hình"); return; }
    cleanupRoom();
    cleanupMatchmaking();
    setNetMode(mode);
    setPhase("searching");
    setSearchingState("Đang tìm đối thủ...");
    setErrorMsg(null);
    setOpponent(null);

    const channelName = `online:matchmaking:${mode}`;
    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false }, presence: { key: accountRef.current.id } }
    });

    let matched = false;

    const tryInvite = (target: { id: string; name: string; friendCode: string }) => {
      if (matched) return;
      // Decide initiator by lexicographic id to avoid double invite
      const selfId = accountRef.current.id;
      if (selfId > target.id) {
        // wait for target to invite us
        setSearchingState(`Đã thấy ${target.name} • chờ mời...`);
        return;
      }
      matched = true;
      const newRoomCode = generateFriendCode();
      setSearchingState(`Đã ghép với ${target.name} • tạo phòng ${newRoomCode}...`);
      // invite
      channel.send({ type: "broadcast", event: "match_invite", payload: { from: selfId, to: target.id, roomCode: newRoomCode, name: playerNameRef.current } });
      // slight delay then join as host
      setTimeout(() => {
        cleanupMatchmaking();
        joinRoomChannel(newRoomCode, "host");
        setOpponent({ id: target.id, name: target.name, friendCode: target.friendCode, cameraReady: false });
        setPhase("matched");
      }, 400);
    };

    channel
      .on("broadcast", { event: "searching" }, ({ payload }: { payload: { from: string; name: string; friendCode: string; ts: number } }) => {
        if (payload.from === accountRef.current.id) return;
        if (phaseRef.current !== "searching") return;
        console.log("[matchmaking] found searching", payload);
        tryInvite({ id: payload.from, name: payload.name, friendCode: payload.friendCode });
      })
      .on("broadcast", { event: "match_invite" }, ({ payload }: { payload: { from: string; to: string; roomCode: string; name: string } }) => {
        if (payload.to !== accountRef.current.id) return;
        if (matched) return;
        matched = true;
        setSearchingState(`Được mời bởi ${payload.name} • tham gia ${payload.roomCode}...`);
        // accept
        channel.send({ type: "broadcast", event: "match_accept", payload: { from: accountRef.current.id, to: payload.from, roomCode: payload.roomCode } });
        setTimeout(() => {
          cleanupMatchmaking();
          joinRoomChannel(payload.roomCode, "guest");
          setOpponent({ id: payload.from, name: payload.name, friendCode: "------", cameraReady: false });
          setPhase("matched");
        }, 300);
      })
      .on("broadcast", { event: "match_accept" }, ({ payload }: { payload: { from: string; to: string; roomCode: string } }) => {
        if (payload.to !== accountRef.current.id) return;
        // host confirms accept, already joining
        console.log("[matchmaking] accept from", payload.from);
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState() as unknown as Record<string, Array<{ user_id: string; name: string; friendCode: string }>>;
        const all = Object.values(state).flat();
        const others = all.filter(p => (p as unknown as { user_id: string }).user_id !== accountRef.current.id);
        if (others.length > 0 && phaseRef.current === "searching" && !matched) {
          // pick the oldest presence (first)
          const first = others[0] as unknown as { user_id: string; name: string; friendCode: string };
          tryInvite({ id: first.user_id, name: first.name, friendCode: first.friendCode });
        }
      });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ user_id: accountRef.current.id, name: playerNameRef.current, friendCode: friendCode });
        // broadcast searching
        channel.send({ type: "broadcast", event: "searching", payload: { from: accountRef.current.id, name: playerNameRef.current, friendCode: friendCode, ts: Date.now() } });
        setIsConnected(true);
        console.log(`[matchmaking] searching on ${channelName}`);
        // timeout after 30s - increased to avoid work timeout
        setTimeout(() => {
          if (phaseRef.current === "searching" && !matched) {
            setSearchingState("Chưa tìm thấy ai • đang chờ... (tự reconnect)");
          }
        }, 5000);
        setTimeout(() => {
          if (phaseRef.current === "searching" && !matched) {
            setErrorMsg("Không tìm thấy đối thủ sau 90s. Đang tự thử lại...");
            setSearchingState("Tự reconnect...");
            // auto retry once to avoid manual timeout
            try { channel.send({ type: "broadcast", event: "searching", payload: { from: accountRef.current.id, name: playerNameRef.current, friendCode: friendCode, ts: Date.now() } }); } catch {}
          }
        }, 90000);
      } else if (status === "CHANNEL_ERROR") {
        setErrorMsg("Lỗi kết nối matchmaking");
        setPhase("idle");
      }
    });

    matchmakingChannelRef.current = channel;
  }, [friendCode, cleanupMatchmaking, cleanupRoom, joinRoomChannel]);

  const cancelMatchmaking = useCallback(() => {
    cleanupMatchmaking();
    setPhase("idle");
    setSearchingState("idle");
    setErrorMsg(null);
  }, [cleanupMatchmaking]);

  const createFriendRoom = useCallback(() => {
    return createRoomWithVisibility("friend");
  }, [createRoomWithVisibility]);

  const createPublicRoom = useCallback(() => {
    return createRoomWithVisibility("public");
  }, [createRoomWithVisibility]);

  const joinFriendRoom = useCallback((inputCode: string) => {
    const code = inputCode.trim().toUpperCase();
    if (!code || code.length < 4) { setErrorMsg("Mã phòng không hợp lệ (4-8 ký tự)"); return; }
    if (code === friendCode) { setErrorMsg("Không thể tự tham gia phòng của mình"); return; }
    cleanupMatchmaking();
    joinRoomChannel(code, "guest");
    setRoomVisibility("friend");
    setPhase("room");
    setSearchingState(`Đang tham gia phòng ${code}...`);
    return code;
  }, [friendCode, joinRoomChannel, cleanupMatchmaking]);

  const joinPublicRoom = useCallback((code: string) => {
    const upper = code.trim().toUpperCase();
    if (!upper) { setErrorMsg("Mã phòng trống"); return; }
    cleanupMatchmaking();
    joinRoomChannel(upper, "guest");
    setRoomVisibility("public");
    setPhase("room");
    setSearchingState(`Đang vào phòng Public ${upper}...`);
    return upper;
  }, [joinRoomChannel, cleanupMatchmaking]);

  const leaveRoom = useCallback(() => {
    // broadcast leave
    if (roomChannelRef.current) {
      try { roomChannelRef.current.send({ type: "broadcast", event: "leave", payload: { from: accountRef.current.id } }); } catch {}
    }
    cleanupRoom();
    cleanupMatchmaking();
    setPhase("idle");
    setRoomCode(null);
    setRole(null);
    setOpponent(null);
    setSelfCameraReady(false);
    setSearchingState("idle");
  }, [cleanupRoom, cleanupMatchmaking]);

  // Camera ready broadcast + presence update
  const updateCameraReady = useCallback((ready: boolean) => {
    setSelfCameraReady(ready);
    selfReadyRef.current = ready;
    // broadcast
    if (roomChannelRef.current) {
      const payload = { from: accountRef.current.id, ready, name: playerNameRef.current, friendCode: friendCode };
      if (webrtcReadyRef.current && dcRef.current?.readyState === "open") {
        try { dcRef.current.send(JSON.stringify({ type: "camera_ready", ...payload })); } catch {}
      } else {
        roomChannelRef.current.send({ type: "broadcast", event: "camera_ready", payload });
      }
      // also update presence
      try { roomChannelRef.current.track({ user_id: accountRef.current.id, name: playerNameRef.current, friendCode: friendCode, cameraReady: ready }); } catch {}
    }
  }, [friendCode]);

  // Host starts countdown
  const broadcastCountdownStart = useCallback(() => {
    if (!roomChannelRef.current) return;
    const startAt = Date.now() + 3200; // 3.2s for 3-2-1 + buffer
    const payload = { from: accountRef.current.id, startAt };
    if (webrtcReadyRef.current && dcRef.current?.readyState === "open") {
      try { dcRef.current.send(JSON.stringify({ type: "countdown_start", ...payload })); } catch {}
    } else {
      roomChannelRef.current.send({ type: "broadcast", event: "countdown_start", payload });
    }
    // also dispatch for self
    window.dispatchEvent(new CustomEvent("online:countdown_start", { detail: payload }));
    setPhase("countdown");
  }, []);

  const broadcastBlink = useCallback((ts: number = Date.now()) => {
    if (!roomChannelRef.current) return;
    const payload = { from: accountRef.current.id, ts };
    if (webrtcReadyRef.current && dcRef.current?.readyState === "open") {
      try { dcRef.current.send(JSON.stringify({ type: "blink", ...payload })); } catch {}
    } else {
      roomChannelRef.current.send({ type: "broadcast", event: "blink", payload });
    }
    // winner logic handled by game loop listening to events
  }, []);

  const broadcastTrackingLost = useCallback((ts: number = Date.now()) => {
    if (!roomChannelRef.current) return;
    const payload = { from: accountRef.current.id, ts };
    if (webrtcReadyRef.current && dcRef.current?.readyState === "open") {
      try { dcRef.current.send(JSON.stringify({ type: "tracking_lost", ...payload })); } catch {}
    } else {
      roomChannelRef.current.send({ type: "broadcast", event: "tracking_lost", payload });
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAll();
    };
  }, [cleanupAll]);

  return {
    account,
    friendCode,
    regenerateCode,
    netMode,
    setNetMode,
    phase,
    setPhase,
    roomCode,
    role,
    opponent,
    selfCameraReady,
    updateCameraReady,
    pingMs,
    opponentPingMs,
    searchingState,
    errorMsg,
    setErrorMsg,
    isConnected,
    publicRooms,
    roomVisibility,
    setRoomVisibility,
    subscribeLobby,
    announceRoomInLobby,
    createRoomWithVisibility,
    remoteStream,
    addLocalStream,
    startRandomMatchmaking,
    cancelMatchmaking,
    createFriendRoom,
    createPublicRoom,
    joinFriendRoom,
    joinPublicRoom,
    leaveRoom,
    broadcastCountdownStart,
    broadcastBlink,
    broadcastTrackingLost,
    isWebRTCReady,
  };
}
