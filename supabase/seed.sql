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

update public.creative_generation_configs
set is_active = false
where version <> 'm5-v1' and is_active;

insert into public.telegram_agent_configs (
  version,
  timezone,
  morning_brief_time,
  briefing_top_n,
  recent_message_limit,
  summary_trigger_count,
  alert_cooldown_minutes,
  model_config,
  is_active
)
values (
  1,
  'Asia/Seoul',
  '09:00',
  3,
  12,
  20,
  60,
  $json$
  {
    "version": "m6-v1",
    "conversation_model": "gpt-5.6-luna",
    "summary_model": "gpt-5.6-luna",
    "briefing_model": "gpt-5.6-luna",
    "reasoning": "low",
    "max_output_tokens": 1800,
    "timeout_ms": 20000,
    "max_retries": 2
  }
  $json$::jsonb,
  true
)
on conflict (version) do update
set
  timezone = excluded.timezone,
  morning_brief_time = excluded.morning_brief_time,
  briefing_top_n = excluded.briefing_top_n,
  recent_message_limit = excluded.recent_message_limit,
  summary_trigger_count = excluded.summary_trigger_count,
  alert_cooldown_minutes = excluded.alert_cooldown_minutes,
  model_config = excluded.model_config,
  is_active = excluded.is_active;

insert into public.creative_generation_configs (
  version,
  description,
  classifier_config,
  generation_config,
  mode_configs,
  quality_gate_config,
  is_active,
  effective_from
)
values (
  'm5-v1',
  'Grounded Instagram Carousel generation configuration for Milestone 5.',
  $json$
  {
    "version": "classifier-v1",
    "model": "gpt-5.6-luna",
    "reasoning": "low",
    "confidence_threshold": 0.75,
    "keywords": {
      "match": ["official lineup", "starting xi", "full time", "full-time", "goal", "red card", "var", "half-time", "final score", "라인업", "선발", "골", "퇴장", "전반 종료", "경기 종료", "최종 스코어"],
      "news": ["ruled out", "injury", "transfer", "contract", "official announcement", "six weeks", "부상", "이적", "계약", "공식 발표", "결장"],
      "analysis": ["why", "tactical", "stats", "form", "comparison", "trend", "전술", "통계", "폼", "비교", "트렌드", "왜"]
    },
    "phase_keywords": {
      "PRE_MATCH": ["lineup", "starting xi", "squad", "matchup", "라인업", "선발", "스쿼드", "매치업"],
      "LIVE": ["goal", "red card", "var", "half-time", "골", "퇴장", "전반 종료", "부상 교체"],
      "POST_MATCH": ["full time", "full-time", "final score", "match stats", "경기 종료", "최종 스코어", "경기 통계"]
    }
  }
  $json$::jsonb,
  $json$
  {
    "model": "gpt-5.6-terra",
    "reasoning": "medium",
    "max_output_tokens": 5000,
    "response_format": "strict_json_schema",
    "max_retries": 2,
    "timeout_ms": 30000
  }
  $json$::jsonb,
  $json$
  {
    "NEWS_UPDATE": {"evidence_policy": "STRICT", "prompt_version": "news-v1"},
    "ANALYSIS_CONTEXT": {"evidence_policy": "PARTIAL_ALLOWED", "prompt_version": "analysis-v1"},
    "MATCH_CONTENT": {"evidence_policy": "PARTIAL_ALLOWED", "prompt_version": "match-v1"}
  }
  $json$::jsonb,
  $json$
  {
    "min_slides": 4,
    "max_slides": 7,
    "hook_count": 3,
    "max_repair_attempts": 1,
    "require_visual_direction": true
  }
  $json$::jsonb,
  true,
  '2026-09-18T00:00:00+09:00'::timestamptz
)
on conflict (version) do update
set
  description = excluded.description,
  classifier_config = excluded.classifier_config,
  generation_config = excluded.generation_config,
  mode_configs = excluded.mode_configs,
  quality_gate_config = excluded.quality_gate_config,
  is_active = excluded.is_active,
  effective_from = excluded.effective_from,
  effective_to = null;
