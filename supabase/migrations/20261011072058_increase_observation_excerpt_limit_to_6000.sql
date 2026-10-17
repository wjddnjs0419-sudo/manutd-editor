alter table app_private.discovery_observations
  drop constraint if exists discovery_observations_excerpt_bounded,
  add constraint discovery_observations_excerpt_bounded
    check (excerpt is null or length(excerpt) <= 6_000);

alter table app_private.source_observations
  drop constraint if exists source_observations_excerpt_bounded,
  add constraint source_observations_excerpt_bounded
    check (excerpt is null or length(excerpt) <= 6_000);
