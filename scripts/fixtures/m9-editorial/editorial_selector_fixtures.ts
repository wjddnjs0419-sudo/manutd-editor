/** Synthetic article metadata for deterministic selector checks; not news facts. */
export const MANUTD_EDITORIAL_SELECTOR_FIXTURES = [
  {
    id: "synthetic-match-record",
    synthetic: true,
    input: {
      headline: "[SYNTHETIC] League match points and season record",
      summary: "A fictional match recap describing the score and record.",
    },
    expected_type: "MATCH_RECORD",
  },
  {
    id: "synthetic-transfer-interest",
    synthetic: true,
    input: {
      headline: "[SYNTHETIC] Transfer interest and contract talks",
      summary: "A fictional report about a club's interest in a signing.",
    },
    expected_type: "TRANSFER_INTEREST",
  },
  {
    id: "synthetic-injury-return",
    synthetic: true,
    input: {
      headline: "[SYNTHETIC] Injury update: a player returns to training",
      summary: "A fictional rehabilitation and fitness update.",
    },
    expected_type: "INJURY_RETURN",
  },
] as const;
