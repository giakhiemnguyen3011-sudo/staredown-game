# Staredown Game 👁️ — MediaPipe + Supabase + Next.js

Game web-based thi **không chớp mắt**, dùng **MediaPipe FaceLandmarker (478 điểm)** để track mắt realtime 30 FPS. Ai chớp trước sẽ thua.

## Tính năng
- **Local Highscore (1 người, 1 máy)**: Countdown 3-2-1 → tính giờ → lưu kỷ lục localStorage + Supabase `high_scores`.
- **Local Multiplayer (2 người, 1 máy)**: 1 camera track 2 khuôn mặt, sắp xếp trái/phải thành P1/P2, phát hiện người chớp trước.
- **EAR + Blendshape**: `EAR = (|p2-p6|+|p3-p5|)/(2|p1-p4|)` với 6 điểm mỗi mắt + `eyeBlinkLeft/Right >0.5`, làm mịn 5 khung, yêu cầu 3 khung liên tiếp mới tính chớp (chống nhiễu).
- **Ổn định realtime**: WASM GPU (fallback CPU), `requestAnimationFrame` + `detectForVideo`, FPS live, overlay mắt, ngưỡng EAR chỉnh được (0.15–0.30).
- **Vercel ready**: Next.js 16, Tailwind 4, không cần COOP/COEP.

## Chạy local
```bash
cd D:\staredown-game
npm install
npm run dev
# mở http://localhost:3000
npm run build && npm start # check prod
```

## Cấu hình Supabase (tùy chọn)
1. Tạo project tại supabase.com → lấy `URL` và `anon key` ở Project Settings > API
2. Tạo file `.env.local` (copy từ `.env.example`):
```
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
```
3. Chạy `supabase.sql` trong SQL Editor để tạo bảng `high_scores`.
4. Nếu để trống, game vẫn chạy chỉ với LocalStorage (không lỗi).

## Deploy Vercel
```bash
# C1: CLI
npm i -g vercel
vercel --prod
# nhớ set Env Variables trong Vercel Dashboard

# C2: Import từ GitHub trên vercel.com/new
```
Build command: `npm run build`, Output: `.next`

## Cấu trúc
```
src/app/page.tsx        # Toàn bộ UI + game loop (menu/single/multi)
src/hooks/useFaceLandmarker.ts
src/lib/ear.ts          # EAR calc + smoother
src/lib/supabase.ts     # client + fetch/submit
src/components/EyeOverlay.tsx # canvas vẽ mắt
supabase.sql            # schema
vercel.json, .env.example
```

## Tips ổn định tracking
- Ánh sáng đều, không ngược sáng, không đeo kính râm.
- Cách camera 50–70cm, mặt chính diện.
- Multiplayer: đứng cạnh nhau, cùng độ cao, cách 40–60cm.
- Nếu mắt nhỏ/bị false blink → hạ ngưỡng EAR xuống 0.18–0.20.

## Thư mục
Dự án đã lưu tại `D:\staredown-game` — sẵn sàng deploy.
