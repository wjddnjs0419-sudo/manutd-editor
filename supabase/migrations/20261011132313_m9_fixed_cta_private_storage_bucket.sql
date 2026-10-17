-- Restored source for the production-applied private M9 card asset bucket.
-- The approved assets/cta.png object is uploaded separately and is not migration data.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'manutd-card-assets',
  'manutd-card-assets',
  false,
  20971520,
  array['image/png']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
