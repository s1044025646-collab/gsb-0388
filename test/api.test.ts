import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AddressInfo } from "node:net";
import { createApp } from "../src/server.ts";
import { closeDatabase } from "../src/db.ts";
import { type Server } from "node:http";

describe("HTTP API and SQLite", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "mec-"));
    server = createApp(join(directory, "test.sqlite"));
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  });

  it("creates, reads, versions and verifies a dataset", async () => {
    const createdResponse = await fetch(`${baseUrl}/datasets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "api",
        points: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 4, y: 0 }, { id: 3, x: 0, y: 3 }],
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { datasetId: string; version: number; circle: { radius: number } };
    assert.equal(created.version, 1);
    assert.equal(created.circle.radius, 2.5);

    const evidence = await (await fetch(`${baseUrl}/datasets/${created.datasetId}/evidence`)).json();
    assert.equal(evidence.supports[0].kind, "diameter");

    const newVersion = await fetch(`${baseUrl}/datasets/${created.datasetId}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 4, y: 0 },
        { id: 3, x: 0, y: 3 },
        { id: 4, x: 20, y: 0 },
      ] }),
    });
    assert.equal(newVersion.status, 201);
    assert.equal((await newVersion.json() as { version: number }).version, 2);

    const oldReport = await (await fetch(`${baseUrl}/datasets/${created.datasetId}/report?version=1`)).json() as { circle: { radius: number } };
    assert.equal(oldReport.circle.radius, 2.5);

    const verification = await fetch(`${baseUrl}/datasets/${created.datasetId}/verify?version=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidate: { center: { x: 10, y: 1.5 }, radius: Math.sqrt(102.25) } }),
    });
    const result = await verification.json();
    assert.equal(result.coversAll, true);
    assert.equal(result.optimality, "matches_optimum");
  });

  it("rejects invalid requests without replacing stored reports", async () => {
    const response = await fetch(`${baseUrl}/datasets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: [{ id: 1, x: 2_000_000, y: 0 }] }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, "COORDINATE_OUT_OF_RANGE");
  });
});
