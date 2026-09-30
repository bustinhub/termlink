create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  password_hash text not null,
  avatar_url text,
  bio text default '' check (char_length(bio) <= 180),
  custom_status text default '' check (char_length(custom_status) <= 80),
  status text not null default 'offline' check (status in ('online','idle','dnd','offline')),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table public.users add column if not exists role text not null default 'user';
alter table public.users add column if not exists is_banned boolean not null default false;
alter table public.users add column if not exists ban_reason text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='users_role_check') then
    alter table public.users add constraint users_role_check check (role in ('user','mod','admin'));
  end if;
end $$;
update public.users set role='admin', is_banned=false, ban_reason='' where username='keymaster';

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(), sender_id uuid not null references public.users(id) on delete cascade,
  receiver_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), check (sender_id <> receiver_id)
);
create unique index if not exists friendships_pair_unique on public.friendships (least(sender_id, receiver_id), greatest(sender_id, receiver_id));

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(), sender_id uuid not null references public.users(id) on delete cascade,
  receiver_id uuid not null references public.users(id) on delete cascade,
  content text not null default '' check (char_length(content) <= 4000),
  reply_to uuid references public.messages(id) on delete set null,
  edited_at timestamptz, deleted_at timestamptz, created_at timestamptz not null default now()
);
alter table public.messages add column if not exists attachment_url text;
alter table public.messages add column if not exists attachment_path text;
alter table public.messages add column if not exists attachment_type text;
alter table public.messages add column if not exists attachment_name text;
alter table public.messages alter column content set default '';
alter table public.messages alter column content drop not null;
alter table public.messages drop constraint if exists messages_content_check;
alter table public.messages add constraint messages_content_check check (content is null or char_length(content) between 0 and 4000);
create index if not exists messages_conversation_idx on public.messages (sender_id, receiver_id, created_at desc);

create table if not exists public.message_reads (message_id uuid primary key references public.messages(id) on delete cascade, reader_id uuid not null references public.users(id) on delete cascade, read_at timestamptz not null default now());

create table if not exists public.group_chats (
  id uuid primary key default gen_random_uuid(), name text not null check (char_length(name) between 1 and 40),
  created_by uuid not null references public.users(id) on delete cascade, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.group_members (
  group_id uuid not null references public.group_chats(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','mod','member')),
  joined_at timestamptz not null default now(), primary key (group_id,user_id)
);
create table if not exists public.group_messages (
  id uuid primary key default gen_random_uuid(), group_id uuid not null references public.group_chats(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade, content text default '' check (char_length(content) <= 4000),
  attachment_url text, attachment_path text, attachment_type text, attachment_name text,
  created_at timestamptz not null default now()
);
create index if not exists group_messages_idx on public.group_messages (group_id,created_at desc);

create table if not exists public.license_keys (
  id uuid primary key default gen_random_uuid(), key_hash text not null unique, key_prefix text not null,
  label text not null default '', max_uses integer not null default 3 check (max_uses between 1 and 50),
  uses integer not null default 0 check (uses >= 0), expires_at timestamptz, is_active boolean not null default true,
  created_by uuid references public.users(id) on delete set null, created_at timestamptz not null default now(), last_used_at timestamptz
);

create table if not exists public.moderation_logs (
  id bigserial primary key, actor_id uuid references public.users(id) on delete set null,
  action text not null, target_user_id uuid references public.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists moderation_logs_created_idx on public.moderation_logs(created_at desc);

-- Kept for backwards compatibility with older RELAY versions.
create table if not exists public.reactions (id uuid primary key default gen_random_uuid(),message_id uuid not null references public.messages(id) on delete cascade,user_id uuid not null references public.users(id) on delete cascade,reaction text not null,created_at timestamptz not null default now(),unique(message_id,user_id,reaction));
create table if not exists public.notifications (id uuid primary key default gen_random_uuid(),user_id uuid not null references public.users(id) on delete cascade,actor_id uuid references public.users(id) on delete cascade,type text not null,message_id uuid references public.messages(id) on delete cascade,text text not null default '',is_read boolean not null default false,created_at timestamptz not null default now());

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('chat-media','chat-media',true,5242880,array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do update set public=true,file_size_limit=5242880,allowed_mime_types=array['image/png','image/jpeg','image/webp','image/gif'];

alter table public.users enable row level security;
alter table public.friendships enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;
alter table public.group_chats enable row level security;
alter table public.group_members enable row level security;
alter table public.group_messages enable row level security;
alter table public.license_keys enable row level security;
alter table public.moderation_logs enable row level security;
alter table public.reactions enable row level security;
alter table public.notifications enable row level security;

-- RELAY accesses Supabase only from the trusted Node server using the service-role/secret key.
-- Never put SUPABASE_SERVICE_ROLE_KEY in browser code.
