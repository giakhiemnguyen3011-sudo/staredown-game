-- Chạy trong Supabase SQL Editor để tạo bảng high_scores
-- https://supabase.com/dashboard/project/_/sql

create extension if not exists "uuid-ossp";

create table if not exists public.high_scores (
  id uuid primary key default uuid_generate_v4(),
  player_name text not null check (char_length(player_name) between 1 and 30),
  duration_ms integer not null check (duration_ms > 0 and duration_ms < 6000000),
  created_at timestamptz not null default now(),
  client_id text
);

-- Cho phép đọc public, ghi public (game local không auth). Nếu cần bảo mật hơn, thêm RLS + policies với anon key.
alter table public.high_scores disable row level security;
-- Nếu bạn bật RLS, dùng:
-- alter table public.high_scores enable row level security;
-- create policy "Allow read" on public.high_scores for select using (true);
-- create policy "Allow insert" on public.high_scores for insert with check (true);

create index if not exists high_scores_duration_idx on public.high_scores (duration_ms desc);
create index if not exists high_scores_created_at_idx on public.high_scores (created_at desc);
create index if not exists high_scores_client_id_idx on public.high_scores (client_id);

-- Backfill for existing table if client_id missing (safe to run multiple times)
alter table public.high_scores add column if not exists client_id text;
create index if not exists high_scores_client_id_idx on public.high_scores (client_id);

-- Ví dụ query top 10
-- select * from public.high_scores order by duration_ms desc limit 10;
