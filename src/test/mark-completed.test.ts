import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks =====

const mockCol = {
  updateOne: vi.fn(),
  updateMany: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async () => mockCol),
}));

import { NextRequest } from "next/server";
import { PATCH } from "../../app/api/chats/[id]/route";
import { POST as bulkComplete } from "../../app/api/chats/bulk-complete/route";

// ===== Helpers =====

function patchReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/chats/c1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function bulkReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/chats/bulk-complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const patchParams = { params: Promise.resolve({ id: "c1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockCol.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  mockCol.updateMany.mockResolvedValue({ matchedCount: 3, modifiedCount: 3 });
});

// ============================================================================
// PATCH /api/chats/[id]
// ============================================================================

describe("PATCH /api/chats/[id] — handling_status update", () => {
  it("rejects an invalid handling_status with 400", async () => {
    const res = await PATCH(patchReq({ handling_status: "bogus" }), patchParams);
    expect(res.status).toBe(400);
    expect(mockCol.updateOne).not.toHaveBeenCalled();
  });

  it("completed also clears the auto-reply schedule", async () => {
    const res = await PATCH(
      patchReq({ handling_status: "completed" }),
      patchParams
    );
    expect(res.status).toBe(200);
    const set = mockCol.updateOne.mock.calls[0][1].$set;
    expect(set.handling_status).toBe("completed");
    expect(set.auto_reply_pending).toBe(false);
    expect(set.auto_reply_due_at).toBeNull();
  });

  it("non-completed status does NOT touch the auto-reply schedule", async () => {
    await PATCH(patchReq({ handling_status: "in_progress" }), patchParams);
    const set = mockCol.updateOne.mock.calls[0][1].$set;
    expect(set.handling_status).toBe("in_progress");
    expect(set).not.toHaveProperty("auto_reply_pending");
    expect(set).not.toHaveProperty("auto_reply_due_at");
  });

  it("returns 404 when the conversation does not exist", async () => {
    mockCol.updateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const res = await PATCH(
      patchReq({ handling_status: "completed" }),
      patchParams
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// POST /api/chats/bulk-complete
// ============================================================================

describe("POST /api/chats/bulk-complete — mark multiple completed without reply", () => {
  it("rejects an empty id list with 400", async () => {
    const res = await bulkComplete(bulkReq({ conversation_ids: [] }));
    expect(res.status).toBe(400);
    expect(mockCol.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a missing id list with 400", async () => {
    const res = await bulkComplete(bulkReq({}));
    expect(res.status).toBe(400);
    expect(mockCol.updateMany).not.toHaveBeenCalled();
  });

  it("rejects more than 500 ids with 400", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `c${i}`);
    const res = await bulkComplete(bulkReq({ conversation_ids: ids }));
    expect(res.status).toBe(400);
    expect(mockCol.updateMany).not.toHaveBeenCalled();
  });

  it("updates matching conversations to completed + clears auto-reply", async () => {
    const res = await bulkComplete(
      bulkReq({ conversation_ids: ["a", "b", "c"] })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true, matched: 3, modified: 3 });

    const [filter, update] = mockCol.updateMany.mock.calls[0];
    expect(filter).toEqual({ conversation_id: { $in: ["a", "b", "c"] } });
    expect(update.$set.handling_status).toBe("completed");
    expect(update.$set.auto_reply_pending).toBe(false);
    expect(update.$set.auto_reply_due_at).toBeNull();
  });

  it("trims and drops blank ids before querying", async () => {
    await bulkComplete(
      bulkReq({ conversation_ids: ["a", "", "   ", " b "] })
    );
    const [filter] = mockCol.updateMany.mock.calls[0];
    expect(filter).toEqual({ conversation_id: { $in: ["a", "b"] } });
  });
});
