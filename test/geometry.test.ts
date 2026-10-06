import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enumerateMinimumCircle,
  inclusionTolerance,
  minimumEnclosingCircle,
  type InputPoint,
} from "../src/geometry.ts";
import { verifyCandidate } from "../src/candidate.ts";

const rightTriangle: InputPoint[] = [
  { id: 1, x: 0, y: 0 },
  { id: 2, x: 4, y: 0 },
  { id: 3, x: 0, y: 3 },
];

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-10, `${actual} != ${expected}`);
}

describe("minimum enclosing circle", () => {
  it("returns empty result for empty point set", () => {
    const result = minimumEnclosingCircle([]);
    assert.equal(result.circle, null);
    assert.deepEqual(result.coverage, []);
  });

  it("computes the 3-4-5 diameter circle", () => {
    const result = minimumEnclosingCircle(rightTriangle);
    assert.deepEqual(result.circle!.center, { x: 2, y: 1.5 });
    near(result.circle!.radius, 2.5);
    near(result.circle!.radiusSquared, 6.25);
    assert.deepEqual(result.circle!.support.map((p) => p.id), [2, 3]);
  });

  it("uses three supports for an acute triangle", () => {
    const result = minimumEnclosingCircle([
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 4, y: 0 },
      { id: 3, x: 2, y: 4 },
    ]);
    assert.equal(result.supports[0]!.kind, "circumcircle");
    assert.equal(result.circle!.support.length, 3);
    near(result.circle!.center.x, 2);
    near(result.circle!.center.y, 1.5);
    near(result.circle!.radiusSquared, 6.25);
  });

  it("uses only the endpoints for collinear points", () => {
    const result = minimumEnclosingCircle([
      { id: 1, x: -5, y: 1 },
      { id: 2, x: 0, y: 1 },
      { id: 3, x: 7, y: 1 },
    ]);
    assert.equal(result.supports[0]!.kind, "diameter");
    assert.deepEqual(result.circle!.support.map((p) => p.id), [1, 3]);
  });

  it("handles duplicates, all-identical points, negative coordinates and a rectangle", () => {
    const duplicates = minimumEnclosingCircle([
      { id: 1, x: 2, y: 2 },
      { id: 2, x: 2, y: 2 },
      { id: 3, x: 5, y: 6 },
    ]);
    assert.equal(duplicates.duplicateGroups[0]!.pointIds.join(","), "1,2");
    assert.equal(duplicates.circle!.support.length, 2);

    const same = minimumEnclosingCircle([{ id: 9, x: -3, y: -8 }, { id: 10, x: -3, y: -8 }]);
    assert.equal(same.circle!.radius, 0);
    assert.deepEqual(same.circle!.support.map((p) => p.id), [9]);

    const rectangle = minimumEnclosingCircle([
      { id: 1, x: -2, y: -1 },
      { id: 2, x: 4, y: -1 },
      { id: 3, x: 4, y: 5 },
      { id: 4, x: -2, y: 5 },
    ]);
    near(rectangle.circle!.center.x, 1);
    near(rectangle.circle!.center.y, 2);
    near(rectangle.circle!.radiusSquared, 18);
  });

  it("is invariant under reordering, translation and positive integer scaling", () => {
    const reordered = minimumEnclosingCircle([...rightTriangle].reverse());
    assert.deepEqual(reordered.circle!.center, { x: 2, y: 1.5 });
    assert.deepEqual(reordered.circle!.support.map((p) => p.id).sort(), [2, 3]);

    const translated = minimumEnclosingCircle(rightTriangle.map((p) => ({ ...p, x: p.x + 10, y: p.y - 7 })));
    near(translated.circle!.center.x, 12);
    near(translated.circle!.center.y, -5.5);
    near(translated.circle!.radius, 2.5);

    const scaled = minimumEnclosingCircle(rightTriangle.map((p) => ({ ...p, x: p.x * 3, y: p.y * 3 })));
    near(scaled.circle!.radius, 7.5);
  });

  it("reports complete coverage and change points", () => {
    const result = minimumEnclosingCircle([...rightTriangle, { id: 4, x: 1, y: 1 }]);
    assert.equal(result.coverage.every((row) => row.covered), true);
    assert.deepEqual(result.changes.map((event) => event.id).sort(), [2, 3]);
  });

  it("verifies candidate failures and optimum radius difference", () => {
    const tooSmall = verifyCandidate(rightTriangle, { center: { x: 2, y: 1.5 }, radius: 2 }, 2.5);
    assert.equal(tooSmall.coversAll, false);
    assert.equal(tooSmall.uncoveredPointIds.length, 3);
    assert.equal(tooSmall.optimality, "not_optimal");

    const optimal = verifyCandidate(rightTriangle, { center: { x: 2, y: 1.5 }, radius: 2.5 }, 2.5);
    assert.equal(optimal.coversAll, true);
    assert.equal(optimal.optimality, "matches_optimum");
  });

  it("matches brute-force candidates for small random sets", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 20; trial += 1) {
      const points: InputPoint[] = Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        x: Math.floor(random() * 21) - 10,
        y: Math.floor(random() * 21) - 10,
      }));
      const incremental = minimumEnclosingCircle(points).circle!;
      const brute = enumerateMinimumCircle(points)!;
      near(incremental.radiusSquared, brute.radiusSquared);
      for (const point of points) {
        const dx = point.x - incremental.center.x;
        const dy = point.y - incremental.center.y;
        assert.ok(dx * dx + dy * dy <= incremental.radiusSquared + inclusionTolerance(incremental.center, incremental.radiusSquared));
      }
    }
  });

  it("radius is nondecreasing when adding points", () => {
    let previous = 0;
    const points: InputPoint[] = [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 3, y: 4 },
      { id: 3, x: -2, y: 9 },
      { id: 4, x: 100, y: -5 },
    ];
    for (const point of points) {
      const radius = minimumEnclosingCircle(points.slice(0, point.id)).circle!.radius;
      assert.ok(radius >= previous - 1e-10);
      previous = radius;
    }
  });
});
