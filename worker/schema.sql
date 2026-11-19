-- Настройки Telegram-бота ASMO. Один бот на пользователя.
create table if not exists public.planner_bot (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  token        text not null,
  bot          text not null default '',
  hook_secret  text not null,
  code         text,
  chat         bigint,
  chat_name    text not null default '',
  tz           text not null default 'Asia/Tashkent',
  digest       boolean not null default true,
  digest_time  text not null default '09:00',
  remind       boolean not null default true,
  last_digest  text not null default '',
  sent         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

alter table public.planner_bot enable row level security;

drop policy if exists "own bot select" on public.planner_bot;
drop policy if exists "own bot insert" on public.planner_bot;
drop policy if exists "own bot update" on public.planner_bot;
drop policy if exists "own bot delete" on public.planner_bot;
create policy "own bot select" on public.planner_bot for select to authenticated using (user_id = auth.uid());
create policy "own bot insert" on public.planner_bot for insert to authenticated with check (user_id = auth.uid());
create policy "own bot update" on public.planner_bot for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own bot delete" on public.planner_bot for delete to authenticated using (user_id = auth.uid());

-- Расписание пар из HEMIS. Пишет только воркер (service key); сайт читает свои пары.
create table if not exists public.planner_hemis (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  base       text not null,                       -- https://student.tstu.uz
  login      text not null,
  token      text not null default '',            -- токен HEMIS, сайту не виден
  pass       text not null default '',            -- пароль, зашифрованный ключом HEMIS_KEY; пусто, если не сохранять
  lessons    jsonb not null default '[]'::jsonb,  -- [{id,date,start,end,title,type,room,teacher}]
  synced_at  timestamptz not null default now(),
  error      text not null default ''
);

alter table public.planner_hemis enable row level security;
drop policy if exists "own hemis select" on public.planner_hemis;
create policy "own hemis select" on public.planner_hemis for select to authenticated using (user_id = auth.uid());
-- браузеру доступны только безопасные колонки: токен и пароль не читаются даже владельцем
revoke all on public.planner_hemis from anon, authenticated;
grant select (user_id, base, login, lessons, synced_at, error) on public.planner_hemis to authenticated;
