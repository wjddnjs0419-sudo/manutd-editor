export type ManutdEditorialArticleType =
  | "GENERAL"
  | "MATCH_RECORD"
  | "TRANSFER_INTEREST"
  | "INJURY_RETURN"
  | "INTERVIEW_CONFLICT"
  | "FAN_BACKSTAGE";

export interface ManutdEditorGoldenExample {
  id: string;
  slug?: string;
  article_types: readonly ManutdEditorialArticleType[];
  hook: string;
  hook_type: string;
  expression_pattern: string;
  why_it_works: string;
  style_only: true;
  generation_evidence_ids: readonly string[];
}

export const MANUTD_EDITOR_GOLDEN_EXAMPLES:
  readonly ManutdEditorGoldenExample[] = [
    {
      id: "distance-question",
      article_types: ["MATCH_RECORD"],
      hook: "6.6km 덜 뛴 맨유 / 문제는 전술일까, 에너지일까",
      hook_type: "숫자 + 쟁점 질문",
      expression_pattern: "구체적인 차이를 먼저 제시하고 그 원인을 질문한다",
      why_it_works: "수치의 크기보다 팬이 궁금해할 이유를 연결한다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "garnacho-minutes",
      slug: "garnacho",
      article_types: ["MATCH_RECORD", "TRANSFER_INTEREST"],
      hook: "맨유 떠난 가르나초의 현재 / 최근 4경기 출전시간 ‘0’분",
      hook_type: "인물 + 예상 밖 수치",
      expression_pattern:
        "익숙한 인물의 현재 상황 뒤에 확인 가능한 숫자를 둔다",
      why_it_works: "상황과 구체적인 디테일이 한 호흡으로 이어진다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "free-agent-months",
      slug: "sancho",
      article_types: ["TRANSFER_INTEREST"],
      hook: "자유 계약만 3개월째",
      hook_type: "경과 시간",
      expression_pattern: "현재 상태를 짧은 시간 정보로 압축한다",
      why_it_works: "짧은 문장으로 다음 상황에 대한 궁금증을 만든다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "training-ground-detail",
      article_types: ["FAN_BACKSTAGE", "INJURY_RETURN"],
      hook: "10부리그 훈련장",
      hook_type: "뜻밖의 장소",
      expression_pattern: "상황의 의외성을 장소 하나로 보여준다",
      why_it_works: "설명보다 구체적인 장면을 먼저 떠올리게 한다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "minutes-reality",
      article_types: ["MATCH_RECORD", "INJURY_RETURN"],
      hook: "그러나 현실은 출전시간 단 31분",
      hook_type: "기대와 현실의 대비",
      expression_pattern: "앞선 기대와 확인된 결과를 대조한다",
      why_it_works: "대조가 있을 때만 반전을 만들고 수치로 뒷받침한다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "manager-assessment",
      article_types: ["INTERVIEW_CONFLICT"],
      hook: "에메리의 평가 ‘현재 그보다 앞선 선수들이 있다’",
      hook_type: "실제 발언",
      expression_pattern: "발언자와 확인된 발언을 한 화면에서 연결한다",
      why_it_works: "화자와 맥락이 분명할 때만 인용이 힘을 얻는다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "return-question",
      article_types: ["INJURY_RETURN"],
      hook: "우가르테 훈련 복귀 / 맨유에 아직 필요할까?",
      hook_type: "복귀 소식 + 핵심 질문",
      expression_pattern: "확인된 소식을 먼저 말하고 쟁점을 묻는다",
      why_it_works: "사실과 질문을 분리해 기대를 과장하지 않는다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "return-competition",
      article_types: ["INJURY_RETURN"],
      hook: "돌아와 보니 경쟁자는 더 많아졌다",
      hook_type: "복귀 뒤 상황 변화",
      expression_pattern: "복귀 전후의 실제 경쟁 구도를 대비한다",
      why_it_works: "상황 변화가 기사 근거로 확인될 때 서사를 만든다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "strength-and-task",
      article_types: ["INTERVIEW_CONFLICT"],
      hook: "수비력은 확실하다. 문제는 안정성과 빌드업",
      hook_type: "장점 인정 + 과제 제시",
      expression_pattern: "장점을 인정한 뒤 근거가 있는 과제를 붙인다",
      why_it_works: "한쪽으로 치우치지 않고 평가의 초점을 잡는다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "rooney-quote",
      article_types: ["INTERVIEW_CONFLICT"],
      hook: "‘우승 메달? 필요 없다’ / 루니의 뜻밖의 답변",
      hook_type: "실제 인용 + 맥락",
      expression_pattern: "짧은 실제 발언을 앞세우고 발언 맥락을 예고한다",
      why_it_works: "발언 원문과 화자가 검증된 경우에만 호기심을 만든다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "stadium-change",
      article_types: ["TRANSFER_INTEREST", "FAN_BACKSTAGE"],
      hook: "올드 트래포드의 시대가 끝난다? / 맨유, 10만 석 새 구장 추진",
      hook_type: "큰 변화 + 규모 + 질문",
      expression_pattern:
        "변화 가능성은 질문으로, 확인된 계획은 구체적으로 제시한다",
      why_it_works: "확정과 추진 단계의 차이를 제목에서 유지한다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "conflicting-signal",
      article_types: ["TRANSFER_INTEREST"],
      hook: "맨유 떠난다던 가브리엘 / 근데 왜 1군 사진에?",
      hook_type: "상충하는 단서",
      expression_pattern: "서로 다른 보도를 단정하지 않고 질문으로 연결한다",
      why_it_works: "불확실성을 감추지 않고 독자의 의문으로 바꾼다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "first-match",
      article_types: ["INJURY_RETURN", "FAN_BACKSTAGE"],
      hook: "드디어 맨유 유니폼 입었다 / 발레바, 첫 실전 소화",
      hook_type: "기다림 뒤 첫 장면",
      expression_pattern: "기다린 상황과 확인된 첫 실전을 연결한다",
      why_it_works: "진행 단계를 과장 없이 구체화한다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "unexpected-sale",
      article_types: ["FAN_BACKSTAGE"],
      hook: "올드 트래포드 잔디를 판다고?",
      hook_type: "뜻밖의 소재 + 대화형 질문",
      expression_pattern: "낯선 사실을 일상적인 질문으로 바꾼다",
      why_it_works: "독자가 바로 이해할 수 있는 말로 소재를 좁힌다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "return-caveat",
      article_types: ["INJURY_RETURN"],
      hook: "복귀신호는 아니다",
      hook_type: "오해 바로잡기",
      expression_pattern: "먼저 퍼질 수 있는 오해를 짧게 교정한다",
      why_it_works: "기사의 제한 조건을 앞세워 잘못된 기대를 막는다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "manager-contender",
      article_types: ["TRANSFER_INTEREST"],
      hook: "후임 1순위로 급부상한 콘테",
      hook_type: "변화 가능성 + 인물",
      expression_pattern: "후보 보도 강도를 보존하며 인물을 먼저 보여준다",
      why_it_works: "순위나 가능성의 근거가 있을 때만 변화의 강도를 전달한다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "manager-question",
      article_types: ["TRANSFER_INTEREST"],
      hook: "콘테 맨유행?",
      hook_type: "짧은 의문형",
      expression_pattern: "루머는 물음표로 남기고 핵심 인물만 제시한다",
      why_it_works: "짧은 제목에서도 확정되지 않은 상태를 지킨다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "revival-hope",
      article_types: ["FAN_BACKSTAGE"],
      hook: "빌라에서 부활을 꿈꾸며",
      hook_type: "기대에서 시작",
      expression_pattern: "선수의 목표나 기대를 서사의 도입부로 쓴다",
      why_it_works:
        "목표가 실제 발언 또는 기사 근거와 연결될 때 공감대를 만든다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "transfer-race",
      article_types: ["TRANSFER_INTEREST"],
      hook: "맨유도 영입 경쟁에 합류?",
      hook_type: "경쟁 구도 + 불확실성",
      expression_pattern: "경쟁 소식과 아직 확정되지 않은 상태를 함께 표현한다",
      why_it_works: "관심과 공식 제안을 혼동하지 않는다",
      style_only: true,
      generation_evidence_ids: [],
    },
    {
      id: "injury-list",
      article_types: ["INJURY_RETURN"],
      hook: "점점 길어지는 부상 명단",
      hook_type: "누적되는 문제",
      expression_pattern: "시간에 따라 늘어난 상황을 짧게 묶는다",
      why_it_works: "누적 추세가 기사에서 확인될 때만 문제의 크기를 보여준다",
      style_only: true,
      generation_evidence_ids: [],
    },
  ];

type ClassifiedArticleType = Exclude<ManutdEditorialArticleType, "GENERAL">;

const ARTICLE_TYPE_SIGNALS: Readonly<
  Record<ClassifiedArticleType, readonly RegExp[]>
> = {
  MATCH_RECORD: [
    /\b(?:match|game|score|goal|points?|record|league|stats?)\b/iu,
    /승점|경기|골|기록|득점|실점|무승|무승부|패배|승리/u,
  ],
  TRANSFER_INTEREST: [
    /\b(?:transfer|sign(?:ing|ed)?|deal|contract|loan|interest(?:ed)?|move)\b/iu,
    /이적|영입|계약|임대|관심|바이아웃|재계약/u,
  ],
  INJURY_RETURN: [
    /\b(?:injur(?:y|ed)|return(?:s|ed)?|training|rehab|fitness|out)\b/iu,
    /부상|복귀|훈련|재활|결장|부상자/u,
  ],
  INTERVIEW_CONFLICT: [
    /\b(?:interview|said|says|quote|spoke|critic(?:ize|ized|ism)|claim(?:ed)?|assessment)\b/iu,
    /발언|인터뷰|비판|평가|지적|주장|말했다|밝혔다/u,
  ],
  FAN_BACKSTAGE: [
    /\b(?:fan|supporter|reaction|behind(?:\s|-)?the-scenes|stadium|grass|tunnel)\b/iu,
    /팬|반응|비하인드|구장|잔디|훈련장|라커룸/u,
  ],
};

export function inferManutdEditorialArticleType(
  input: unknown,
): ManutdEditorialArticleType {
  const text =
    (typeof input === "string" ? input : JSON.stringify(input ?? "") ?? "")
      .toLocaleLowerCase();
  let selected: ManutdEditorialArticleType = "GENERAL";
  let selectedScore = 0;
  for (
    const type of Object.keys(ARTICLE_TYPE_SIGNALS) as ClassifiedArticleType[]
  ) {
    const score = ARTICLE_TYPE_SIGNALS[type].reduce(
      (count, signal) => count + Number(signal.test(text)),
      0,
    );
    if (score > selectedScore) {
      selected = type;
      selectedScore = score;
    }
  }
  return selected;
}

const EXAMPLE_IDS_BY_TYPE: Readonly<
  Record<ManutdEditorialArticleType, readonly string[]>
> = {
  GENERAL: ["distance-question", "return-question", "unexpected-sale"],
  MATCH_RECORD: ["distance-question", "garnacho-minutes", "minutes-reality"],
  TRANSFER_INTEREST: [
    "transfer-race",
    "manager-question",
    "conflicting-signal",
  ],
  INJURY_RETURN: ["return-question", "return-competition", "return-caveat"],
  INTERVIEW_CONFLICT: [
    "manager-assessment",
    "rooney-quote",
    "strength-and-task",
  ],
  FAN_BACKSTAGE: [
    "unexpected-sale",
    "stadium-change",
    "training-ground-detail",
  ],
};

export function selectManutdStyleExamples(
  input: unknown,
): ManutdEditorGoldenExample[] {
  const type = inferManutdEditorialArticleType(input);
  const examplesById = new Map(
    MANUTD_EDITOR_GOLDEN_EXAMPLES.map((example) => [example.id, example]),
  );
  return EXAMPLE_IDS_BY_TYPE[type].map((id) => examplesById.get(id)!).filter(
    Boolean,
  );
}
