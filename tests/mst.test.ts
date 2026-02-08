import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildMst } from '../src/core/mst';

describe('mst builder', () => {
  it('returns a connected tree with n-1 edges', () => {
    const frameIds = ['a', 'b', 'c', 'd'];
    const centers = new Map<string, Vector3>([
      ['a', new Vector3(0, 0, 0)],
      ['b', new Vector3(2, 0, 0)],
      ['c', new Vector3(1, 2, 0)],
      ['d', new Vector3(-1, 1, 0)],
    ]);

    const edges = buildMst(frameIds, centers);

    expect(edges).toHaveLength(frameIds.length - 1);

    const adjacency = new Map<string, Set<string>>();
    for (const id of frameIds) {
      adjacency.set(id, new Set());
    }

    for (const edge of edges) {
      adjacency.get(edge.from)?.add(edge.to);
      adjacency.get(edge.to)?.add(edge.from);
    }

    const visited = new Set<string>();
    const queue = [frameIds[0]];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          queue.push(next);
        }
      }
    }

    expect(visited.size).toBe(frameIds.length);
  });
});
