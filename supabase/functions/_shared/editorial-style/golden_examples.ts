export interface ManutdEditorGoldenExample {
  slug: "sancho" | "garnacho";
  style_only: true;
  generation_evidence_ids: readonly string[];
  structure: readonly ["HOOK", "CONTEXT", "KEY_FACT"] | readonly ["HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION"];
  traits: readonly string[];
}

export const MANUTD_EDITOR_GOLDEN_EXAMPLES: readonly ManutdEditorGoldenExample[] = [
  {
    slug: "sancho",
    style_only: true,
    generation_evidence_ids: [],
    structure: ["HOOK", "CONTEXT", "KEY_FACT"],
    traits: ["현재 상태를 숫자와 대비로 시작", "계약 상황을 짧게 설명", "뜻밖의 훈련 장소를 핵심 사실로 배치"],
  },
  {
    slug: "garnacho",
    style_only: true,
    generation_evidence_ids: [],
    structure: ["HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION"],
    traits: ["최근 출전시간을 강한 훅으로 사용", "이적 경로를 짧게 정리", "감독 평가와 다음 경쟁을 근거 있게 연결"],
  },
];

