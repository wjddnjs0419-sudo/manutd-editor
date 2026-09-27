update public.creative_generation_configs
set
  description = 'Grounded Instagram Carousel generation configuration for Milestone 5 and the ManUtd Editor M8 console.',
  quality_gate_config = quality_gate_config || jsonb_build_object(
    'min_slides', 3,
    'max_slides', 4,
    'style_profile', 'manutd_editor',
    'style_version', 'manutd-editor-v1',
    'enable_style_validator', true
  )
where version = 'm5-v1';
