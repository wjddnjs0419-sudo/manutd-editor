insert into public.source_accounts (
  username,
  region,
  priority_weight,
  api_supported,
  followers_available,
  likes_available,
  comments_available,
  views_available,
  media_url_available,
  carousel_children_available
)
values
  ('utdreport', 'GLOBAL', 1, true, true, true, true, null, true, true),
  ('utddistrict', 'GLOBAL', 1, true, true, true, true, null, true, true),
  ('manunitedzone', 'GLOBAL', 1, true, true, true, true, true, true, true),
  ('all.man.united', 'GLOBAL', 1, null, null, null, null, null, null, null),
  ('manutd_daily', 'GLOBAL', 1, null, null, null, null, null, null, null),
  ('mufc_news.20', 'GLOBAL', 1, null, null, null, null, null, null, null),
  ('manchesterunited_central', 'GLOBAL', 1, null, null, null, null, null, null, null),
  ('mufc_gossip_', 'KR', 1, null, null, null, null, null, null, null),
  ('todayfootball', 'KR', 1, null, null, null, null, null, null, null),
  ('footballoop.mag', 'KR', 1, null, null, null, null, null, null, null)
on conflict (username) do update
set
  region = excluded.region,
  priority_weight = excluded.priority_weight,
  api_supported = excluded.api_supported,
  followers_available = excluded.followers_available,
  likes_available = excluded.likes_available,
  comments_available = excluded.comments_available,
  views_available = excluded.views_available,
  media_url_available = excluded.media_url_available,
  carousel_children_available = excluded.carousel_children_available;

insert into public.information_sources (
  canonical_name,
  entity_type,
  aliases,
  instagram_username,
  website_url,
  reliability_score,
  reliability_rationale
)
values
  (
    'Manchester United',
    'CLUB',
    array['Man Utd', 'MUFC', '맨체스터 유나이티드', '맨유'],
    'manchesterunited',
    'https://www.manutd.com',
    10,
    'Official club source for club announcements and first-party information.'
  ),
  (
    'Fabrizio Romano',
    'REPORTER',
    array['Fabrizio', '파브리지오 로마노', '로마노'],
    'fabriziorom',
    'https://www.fabrizioromano.com',
    9,
    'Named direct reporter treated as a Tier-1 source in the approved v1 registry.'
  ),
  (
    'BBC Sport',
    'MEDIA_OUTLET',
    array['BBC', 'BBC 스포츠'],
    'bbcsport',
    'https://www.bbc.com/sport',
    8,
    'Major established media outlet with editorial review.'
  ),
  (
    'Sky Sports',
    'MEDIA_OUTLET',
    array['Sky', '스카이 스포츠'],
    'skysports',
    'https://www.skysports.com',
    8,
    'Major established media outlet with editorial review.'
  ),
  (
    'The Athletic',
    'MEDIA_OUTLET',
    array['Athletic', '디 애슬레틱'],
    'theathleticfc',
    'https://www.nytimes.com/athletic',
    8,
    'Major established sports publication with editorial review.'
  )
on conflict (canonical_name) do update
set
  entity_type = excluded.entity_type,
  aliases = excluded.aliases,
  instagram_username = excluded.instagram_username,
  website_url = excluded.website_url,
  reliability_score = excluded.reliability_score,
  reliability_rationale = excluded.reliability_rationale,
  active = true;

update public.scoring_configs
set is_active = false
where version <> 'v1' and is_active;

insert into public.scoring_configs (
  version,
  description,
  config,
  is_active,
  effective_from
)
values (
  'v1',
  'Approved deterministic Priority Score configuration for Milestone 1.',
  $json$
  {
    "comment_multiplier": 4,
    "component_weights": {
      "global_spread": 12,
      "engagement_outperformance": 12,
      "engagement_velocity": 10,
      "velocity_acceleration": 6,
      "korea_gap": 15,
      "first_mover": 10,
      "korean_saturation": 10,
      "reliability": 10,
      "source_diversity": 5,
      "freshness": 10
    },
    "age_buckets_minutes": [
      {"name": "0-1h", "min": 0, "max": 60},
      {"name": "1-3h", "min": 60, "max": 180},
      {"name": "3-6h", "min": 180, "max": 360},
      {"name": "6-12h", "min": 360, "max": 720},
      {"name": "12-24h", "min": 720, "max": 1440}
    ],
    "outperformance_curve": [
      {"ratio": 0.5, "score": 0},
      {"ratio": 1.0, "score": 3},
      {"ratio": 1.5, "score": 6},
      {"ratio": 2.0, "score": 9},
      {"ratio": 2.5, "score": 12}
    ],
    "velocity_curve": [
      {"ratio": 0.5, "score": 0},
      {"ratio": 1.0, "score": 2.5},
      {"ratio": 1.5, "score": 5},
      {"ratio": 2.0, "score": 7.5},
      {"ratio": 2.5, "score": 10}
    ],
    "acceleration_curve": [
      {"ratio": 1.0, "score": 0},
      {"ratio": 1.25, "score": 1.5},
      {"ratio": 1.5, "score": 3},
      {"ratio": 1.75, "score": 4.5},
      {"ratio": 2.0, "score": 6}
    ],
    "first_mover_curve_minutes": [
      {"min": 0, "max": 15, "score": 2},
      {"min": 15, "max": 60, "score": 6},
      {"min": 60, "max": 180, "score": 10},
      {"min": 180, "max": 360, "score": 8},
      {"min": 360, "max": 720, "score": 5},
      {"min": 720, "max": 1440, "score": 2},
      {"min": 1440, "max": null, "score": 0}
    ],
    "freshness_curve_minutes": [
      {"min": 0, "max": 120, "score": 10},
      {"min": 120, "max": 240, "score": 8},
      {"min": 240, "max": 480, "score": 6},
      {"min": 480, "max": 720, "score": 4},
      {"min": 720, "max": 1440, "score": 2},
      {"min": 1440, "max": null, "score": 0}
    ],
    "source_diversity_curve": [
      {"sources": 1, "score": 1},
      {"sources": 2, "score": 3},
      {"sources": 3, "score": 5}
    ],
    "flags": {
      "first_mover_alert": {
        "global_coverage_min": 0.3,
        "korean_coverage_equals": 0,
        "engagement_velocity_ratio_min": 1.5,
        "reliability_score_min": 8
      },
      "must_cover": {
        "global_coverage_min": 0.7,
        "engagement_outperformance_ratio_min": 1.5,
        "reliability_score_min": 8
      }
    },
    "reel_view_count": {
      "mode": "secondary_signal",
      "requires_media_type_baseline": true
    }
  }
  $json$::jsonb,
  true,
  '2026-09-17T00:00:00+09:00'::timestamptz
)
on conflict (version) do update
set
  description = excluded.description,
  config = excluded.config,
  is_active = excluded.is_active,
  effective_from = excluded.effective_from,
  effective_to = null;

update public.scoring_configs
set
  description = 'Approved deterministic Priority Score configuration for Milestone 4.',
  config = config || jsonb_build_object(
    'score_version', version::text,
    'data_confidence_weights', jsonb_build_object(
      'account_coverage', 20,
      'baseline_evidence', 20,
      'metric_snapshots', 20,
      'followers', 15,
      'source_recognition', 10,
      'cluster_certainty', 10,
      'api_fields', 5
    )
  )
where is_active;

insert into app_private.intelligence_run_lock (lock_name)
values ('story-intelligence')
on conflict (lock_name) do nothing;
