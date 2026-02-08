import { Vector3 } from 'three';

export interface MstEdge {
  from: string;
  to: string;
  weight: number;
}

interface WeightedEdge {
  aIndex: number;
  bIndex: number;
  weight: number;
}

export function buildMst(frameIds: string[], frameCenters: Map<string, Vector3>): MstEdge[] {
  if (frameIds.length <= 1) {
    return [];
  }

  const weightedEdges: WeightedEdge[] = [];
  for (let i = 0; i < frameIds.length; i += 1) {
    for (let j = i + 1; j < frameIds.length; j += 1) {
      const a = frameCenters.get(frameIds[i]);
      const b = frameCenters.get(frameIds[j]);
      if (!a || !b) {
        continue;
      }
      weightedEdges.push({
        aIndex: i,
        bIndex: j,
        weight: a.distanceTo(b),
      });
    }
  }

  weightedEdges.sort((left, right) => left.weight - right.weight);

  const parent = frameIds.map((_, index) => index);
  const rank = frameIds.map(() => 0);

  const find = (index: number): number => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }
    return parent[index];
  };

  const unite = (aIndex: number, bIndex: number): boolean => {
    const rootA = find(aIndex);
    const rootB = find(bIndex);
    if (rootA === rootB) {
      return false;
    }

    if (rank[rootA] < rank[rootB]) {
      parent[rootA] = rootB;
    } else if (rank[rootA] > rank[rootB]) {
      parent[rootB] = rootA;
    } else {
      parent[rootB] = rootA;
      rank[rootA] += 1;
    }

    return true;
  };

  const mstEdges: MstEdge[] = [];
  for (const edge of weightedEdges) {
    if (unite(edge.aIndex, edge.bIndex)) {
      mstEdges.push({
        from: frameIds[edge.aIndex],
        to: frameIds[edge.bIndex],
        weight: edge.weight,
      });

      if (mstEdges.length === frameIds.length - 1) {
        break;
      }
    }
  }

  return mstEdges;
}
