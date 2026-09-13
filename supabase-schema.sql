-- Supabase SQL Editor oynasida bir marta Run qiling.
create table if not exists public.math_students (
  id uuid primary key, full_name text not null, school_class text not null, password text not null,
  results jsonb not null default '{}'::jsonb, attempts jsonb not null default '[]'::jsonb,
  pending_review jsonb not null default '{}'::jsonb, telegram_sent boolean not null default false,
  telegram_error text, created_at timestamptz not null default now()
);
create unique index if not exists math_students_name_class_unique on public.math_students (lower(full_name), school_class);
create table if not exists public.math_questions (
  id text primary key, section text not null, grade integer check (grade between 1 and 11),
  prompt text not null, options jsonb, answer text, created_at timestamptz not null default now()
);
create index if not exists math_questions_section_grade_index on public.math_questions (section, grade);
create table if not exists public.math_app_settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
insert into public.math_app_settings (key, value) values ('main', '{"gradingMode":"teacher","adminUsername":"admin","adminPassword":"admin"}'::jsonb) on conflict (key) do nothing;
alter table public.math_students enable row level security;
alter table public.math_questions enable row level security;
alter table public.math_app_settings enable row level security;
