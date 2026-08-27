-- Chạy trong Supabase SQL Editor để tạo bảng high_scores
-- https://supabase.com/dashboard/project/_/sql

create extension if not exists "uuid-ossp";

create table if not exists public.high_scores (
  id uuid primary key default uuid_generate_v4(),
  player_name text not null check (char_length(player_name) between 1 and 30),
  duration_ms integer not null check (duration_ms > 0 and duration_ms < 6000000),
  created_at timestamptz not null default now()
);

-- Cho phép đọc public, ghi public (game local không auth).
-- FIX LỖI "violates row-level security policy" nếu trước đó bạn đã bật RLS:
alter table public.high_scores disable row level security;
-- Xóa policy cũ nếu có (tránh lỗi duplicate)
drop policy if exists "Allow read" on public.high_scores;
drop policy if exists "Allow insert" on public.high_scores;
-- Nếu bạn MUỐN bật RLS cho an toàn, hãy comment dòng disable ở trên và bỏ comment 3 dòng dưới:
-- alter table public.high_scores enable row level security;
-- create policy "Allow read" on public.high_scores for select using (true);
-- create policy "Allow insert" on public.high_scores for insert with check (true);
-- Đảm bảo anon có quyền (cần thiết nếu RLS disable vẫn lỗi):
grant all on public.high_scores to anon, authenticated, service_role;

create index if not exists high_scores_duration_idx on public.high_scores (duration_ms desc);
create index if not exists high_scores_created_at_idx on public.high_scores (created_at desc);

-- Ví dụ query top 10
-- select * from public.high_scores order by duration_ms desc limit 10;
