import type { DiscoveryObservation } from "./types.ts";

export interface ObservationCluster {
  readonly clusterKey: string;
  readonly representativeTitle: string;
  readonly observations: readonly DiscoveryObservation[];
  readonly sourceCategories: readonly string[];
  readonly platforms: readonly string[];
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "맨체스터", "유나이티드", "manchester", "united"]);

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/u).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

function similar(left: string, right: string): boolean {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return false;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap >= 2 && overlap / Math.min(a.size, b.size) >= 0.6;
}

function clusterFor(observation: DiscoveryObservation, clusters: ObservationCluster[]): number | null {
  const exact = clusters.findIndex((cluster) => cluster.observations.some((item) => item.contentFingerprint === observation.contentFingerprint));
  if (exact >= 0) return exact;
  const related = clusters.findIndex((cluster) => similar(cluster.representativeTitle, observation.title));
  return related >= 0 ? related : null;
}

export function clusterObservations(observations: readonly DiscoveryObservation[]): readonly ObservationCluster[] {
  const clusters: ObservationCluster[] = [];
  for (const observation of observations) {
    const index = clusterFor(observation, clusters);
    if (index === null) {
      clusters.push({
        clusterKey: `trend:${observation.contentFingerprint.slice(0, 24)}`,
        representativeTitle: observation.title,
        observations: [observation],
        sourceCategories: [observation.sourceRole],
        platforms: [observation.platform],
      });
      continue;
    }
    const current = clusters[index]!;
    clusters[index] = {
      ...current,
      observations: [...current.observations, observation],
      sourceCategories: [...new Set([...current.sourceCategories, observation.sourceRole])],
      platforms: [...new Set([...current.platforms, observation.platform])],
    };
  }
  return clusters;
}
