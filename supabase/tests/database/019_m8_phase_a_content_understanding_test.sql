begin;

set role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = pgtap, extensions, public;

select plan(34);

-- Preserve the retired-account fixture without restoring it to the M8.6 pool.
insert into public.source_accounts (username, region, active, api_supported)
values ('utdreport', 'GLOBAL', true, true);

select has_table('app_private', 'content_understandings', 'content understandings table exists');
select has_column('app_private', 'content_understandings', 'raw_post_id', 'analysis references a raw post');
select has_column('app_private', 'content_understandings', 'status', 'analysis stores status');
select has_column('app_private', 'content_understandings', 'analysis_version', 'analysis stores contract version');
select has_column('app_private', 'content_understandings', 'model', 'analysis stores model');
select has_column('app_private', 'content_understandings', 'prompt_version', 'analysis stores prompt version');
select has_column('app_private', 'content_understandings', 'input_fingerprint', 'analysis stores input fingerprint');
select has_column('app_private', 'content_understandings', 'caption_summary', 'analysis stores caption summary');
select has_column('app_private', 'content_understandings', 'visual_summary', 'analysis stores visual summary');
select has_column('app_private', 'content_understandings', 'combined_summary', 'analysis stores combined summary');
select has_column('app_private', 'content_understandings', 'entities', 'analysis stores entities');
select has_column('app_private', 'content_understandings', 'topics', 'analysis stores topics');
select has_column('app_private', 'content_understandings', 'on_image_text', 'analysis stores on-image text');
select has_column('app_private', 'content_understandings', 'important_numbers', 'analysis stores important numbers');
select has_column('app_private', 'content_understandings', 'source_names', 'analysis stores source names');
select has_column('app_private', 'content_understandings', 'claims', 'analysis stores claims');
select has_column('app_private', 'content_understandings', 'content_type', 'analysis stores content type');
select has_column('app_private', 'content_understandings', 'visual_format', 'analysis stores visual format');
select has_column('app_private', 'content_understandings', 'analysis_confidence', 'analysis stores confidence');
select has_column('app_private', 'content_understandings', 'evidence_state', 'analysis stores evidence state');
select has_column('app_private', 'content_understandings', 'error_category', 'analysis stores safe error category');
select has_column('app_private', 'content_understandings', 'analyzed_at', 'analysis stores analyzed timestamp');
select has_column('app_private', 'content_understandings', 'created_at', 'analysis stores created timestamp');
select has_column('app_private', 'content_understandings', 'updated_at', 'analysis stores updated timestamp');

select ok(
  (select relrowsecurity from pg_class where oid = to_regclass('app_private.content_understandings')),
  'content understandings enable RLS'
);
select ok(
  has_table_privilege('service_role', 'app_private.content_understandings', 'SELECT, INSERT, UPDATE, DELETE'),
  'service role can operate on content understandings'
);
select ok(
  not has_table_privilege('anon', 'app_private.content_understandings', 'SELECT')
    and not has_table_privilege('authenticated', 'app_private.content_understandings', 'SELECT'),
  'client roles cannot read content understandings'
);
select isnt_empty(
  $$select 1 from pg_constraint c
    join pg_class r on r.oid = c.conrelid
    join pg_namespace n on n.oid = r.relnamespace
   where n.nspname = 'app_private'
     and r.relname = 'content_understandings'
     and c.contype = 'u'
     and pg_get_constraintdef(c.oid) ilike '%raw_post_id%'
     and pg_get_constraintdef(c.oid) ilike '%analysis_version%'
     and pg_get_constraintdef(c.oid) ilike '%input_fingerprint%'$$,
  'analysis input identity is unique'
);
select ok(
  (select pg_get_constraintdef(c.oid) ilike '%ANALYZE_CONTENT%'
     from pg_constraint c
     join pg_class r on r.oid = c.conrelid
     join pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'app_private'
      and r.relname = 'editorial_jobs'
      and c.conname = 'editorial_jobs_job_type_check'),
  'editorial queue allows ANALYZE_CONTENT'
);
select ok(
  has_function_privilege('service_role', 'public.enqueue_editorial_job(text,jsonb,text,integer,timestamptz)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.enqueue_editorial_job(text,jsonb,text,integer,timestamptz)', 'EXECUTE'),
  'queue enqueue remains service-role-only'
);

set local role service_role;

insert into public.raw_posts (
  source_account_id, external_post_id, caption, media_type, media_product_type,
  published_at, collected_at, raw_payload
)
values (
  (select id from public.source_accounts where username = 'utdreport' limit 1),
  'm8-a-db-post', 'Thoughts? 👀', 'IMAGE', null,
  '2026-09-27T00:00:00Z', '2026-09-27T00:01:00Z', '{"id":"m8-a-db-post"}'::jsonb
)
returning id as raw_post_id \gset

select public.enqueue_editorial_job(
  'ANALYZE_CONTENT', '{"chain_key":"m8-a-db"}'::jsonb,
  'm8-a:ANALYZE_CONTENT', 3, '2026-09-27T00:02:00Z'::timestamptz
) as analysis_job_id \gset
select ok(:'analysis_job_id' is not null, 'ANALYZE_CONTENT is enqueueable');
select throws_ok(
  $$select public.enqueue_editorial_job('NOT_A_JOB', '{}'::jsonb, 'm8-a:invalid', 3, now())$$,
  '22023', null, 'unknown editorial job type remains rejected'
);

insert into app_private.content_understandings (
  raw_post_id, status, analysis_version, model, prompt_version, input_fingerprint,
  entities, topics, on_image_text, important_numbers, source_names, claims,
  evidence_state, analysis_confidence, analyzed_at
)
values (
  :'raw_post_id'::uuid, 'SUCCEEDED', 'm8-a-v1', 'test-model', 'prompt-v1', 'fingerprint-1',
  '[]'::jsonb, '[]'::jsonb, '[{"text":"3 months","slide_index":null}]'::jsonb,
  '["3 months"]'::jsonb, '[]'::jsonb, '[]'::jsonb,
  '{"visual_summary":"OBSERVED"}'::jsonb, 0.94, '2026-09-27T00:03:00Z'
);
select throws_ok(
  format($sql$insert into app_private.content_understandings (
    raw_post_id, status, analysis_version, model, prompt_version, input_fingerprint
  ) values (%L::uuid, 'SUCCEEDED', 'm8-a-v1', 'test-model', 'prompt-v1', 'fingerprint-1')$sql$, :'raw_post_id'),
  '23505', null, 'same post and analysis fingerprint cannot duplicate'
);
insert into app_private.content_understandings (
  raw_post_id, status, analysis_version, model, prompt_version, input_fingerprint
)
values (
  :'raw_post_id'::uuid, 'PARTIAL', 'm8-a-v1', 'test-model', 'prompt-v1', 'fingerprint-2'
);
select is(
  (select count(*)::integer from app_private.content_understandings where raw_post_id = :'raw_post_id'::uuid),
  2,
  'changed input fingerprint preserves an auditable historical row'
);

reset role;
select * from finish();
rollback;
