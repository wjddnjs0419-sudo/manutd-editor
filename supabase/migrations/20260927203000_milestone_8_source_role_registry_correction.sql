update public.information_sources
set editorial_role = 'FACT_PRIMARY'::public.editorial_source_role,
    reliability_score = greatest(reliability_score, 10),
    reliability_rationale = 'Official Manchester United source; primary factual grounding'
where canonical_name = 'Manchester United';
