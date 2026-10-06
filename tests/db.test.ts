import { beforeEach, expect, it } from "vitest";
import { openDB, type Db } from "../src/repository/db";

let db: Db;
beforeEach(() => {
  db = openDB(":memory:");
});

function insert(overrides: Record<string, unknown> = {}) {
  const row = {
    id: "t-1", subject: "s", body: "b", status: "pending",
    category: null, priority: null, summary: null,
    created_at: 0, updated_at: 0,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO tickets (id, subject, body, status, category, priority, summary, created_at, updated_at)
    VALUES (@id, @subject, @body, @status, @category, @priority, @summary, @created_at, @updated_at)
  `).run(row);
}

it("accepts a pending ticket with no classification", () => {
  expect(() => insert()).not.toThrow();
});

it("rejects a category outside the allowed set", () => {
  expect(() =>
    insert({ status: "classified", category: "urgent", priority: "high", summary: "x" }),
  ).toThrow(/CHECK constraint failed/);
});

it("rejects a classified ticket without a full classification", () => {
  expect(() => insert({ status: "classified", category: "billing" })).toThrow(/CHECK constraint failed/);
});