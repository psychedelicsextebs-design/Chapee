import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";

// ---- Mocks ----------------------------------------------------------------
const mockAutoReplyCol = {
  findOne: vi.fn(),
  updateOne: vi.fn(),
};
const mockTemplatesCol = {
  find: vi.fn(),
};

vi.mock("@/lib/mongodb", () => ({
  getCollection: vi.fn(async (name: string) => {
    if (name === "reply_templates") return mockTemplatesCol;
    return mockAutoReplyCol;
  }),
}));

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(async () => ({ valid: true, userId: "test-user" })),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({})),
}));

// alias `@/` は ./src/ 解決なので、 root 直下の `app/` は相対 import で参照
import { GET, PUT } from "../../app/api/settings/auto-reply/route";
import type { NextRequest } from "next/server";

function jsonReq(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: { get: (_k: string) => null },
  } as unknown as NextRequest;
}

const VALID_ID_A = "507f1f77bcf86cd799439011"; // 24 hex, valid ObjectId format
const VALID_ID_B = "507f1f77bcf86cd799439022";
const ORPHAN_ID = "60c7a981ed577f0b474caade"; // 実在しない前提
const INVALID_ID = "not-a-valid-objectid";
const EMPTY_CONTENT_ID = "607f1f77bcf86cd799439999";

function setupTemplates(
  rows: Array<{ _id: string; content?: string }>
) {
  mockTemplatesCol.find.mockReturnValue({
    project: () => ({
      toArray: async () => rows.map((r) => ({ _id: new ObjectId(r._id), content: r.content })),
    }),
  });
}

describe("GET /api/settings/auto-reply — orphan/empty detection", () => {
  beforeEach(() => {
    mockAutoReplyCol.findOne.mockReset();
    mockAutoReplyCol.updateOne.mockReset();
    mockTemplatesCol.find.mockReset();
  });

  it("全 country の template_id が実在 + content あり → orphans/empty 空", async () => {
    mockAutoReplyCol.findOne.mockResolvedValue({
      _id: "singleton",
      countries: {
        SG: { enabled: true, triggerHour: 8, template_id: VALID_ID_A },
        MY: { enabled: true, triggerHour: 11, template_id: VALID_ID_B },
      },
    });
    setupTemplates([
      { _id: VALID_ID_A, content: "hello" },
      { _id: VALID_ID_B, content: "world" },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      template_orphans: Record<string, string>;
      empty_content: Record<string, string>;
    };
    expect(body.template_orphans).toEqual({});
    expect(body.empty_content).toEqual({});
  });

  it("orphan template_id → template_orphans に記録", async () => {
    mockAutoReplyCol.findOne.mockResolvedValue({
      _id: "singleton",
      countries: {
        SG: { enabled: true, triggerHour: 8, template_id: ORPHAN_ID },
        MY: { enabled: true, triggerHour: 11, template_id: VALID_ID_A },
      },
    });
    setupTemplates([{ _id: VALID_ID_A, content: "hello" }]);

    const res = await GET();
    const body = (await res.json()) as {
      template_orphans: Record<string, string>;
      empty_content: Record<string, string>;
    };
    expect(body.template_orphans).toEqual({ SG: ORPHAN_ID });
    expect(body.empty_content).toEqual({});
  });

  it("template 実在するが content 空 → empty_content に記録", async () => {
    mockAutoReplyCol.findOne.mockResolvedValue({
      _id: "singleton",
      countries: {
        SG: { enabled: true, triggerHour: 8, template_id: EMPTY_CONTENT_ID },
      },
    });
    setupTemplates([{ _id: EMPTY_CONTENT_ID, content: "" }]);

    const res = await GET();
    const body = (await res.json()) as {
      template_orphans: Record<string, string>;
      empty_content: Record<string, string>;
    };
    expect(body.template_orphans).toEqual({});
    expect(body.empty_content).toEqual({ SG: EMPTY_CONTENT_ID });
  });

  it("content が whitespace のみも empty 扱い", async () => {
    mockAutoReplyCol.findOne.mockResolvedValue({
      _id: "singleton",
      countries: {
        SG: { enabled: true, triggerHour: 8, template_id: EMPTY_CONTENT_ID },
      },
    });
    setupTemplates([{ _id: EMPTY_CONTENT_ID, content: "   \n\t  " }]);

    const res = await GET();
    const body = (await res.json()) as { empty_content: Record<string, string> };
    expect(body.empty_content).toEqual({ SG: EMPTY_CONTENT_ID });
  });

  it("template_id が空文字 → orphans にも empty にも入れない (無効化として許容)", async () => {
    mockAutoReplyCol.findOne.mockResolvedValue({
      _id: "singleton",
      countries: {
        SG: { enabled: false, triggerHour: 8, template_id: "" },
      },
    });
    setupTemplates([]);

    const res = await GET();
    const body = (await res.json()) as {
      template_orphans: Record<string, string>;
      empty_content: Record<string, string>;
    };
    expect(body.template_orphans).toEqual({});
    expect(body.empty_content).toEqual({});
  });

  it("Mongo 読み込みエラー → 500", async () => {
    mockAutoReplyCol.findOne.mockRejectedValue(new Error("mongo down"));
    setupTemplates([]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBe(500);
    errSpy.mockRestore();
  });
});

describe("PUT /api/settings/auto-reply — template_id validation (層1)", () => {
  beforeEach(() => {
    mockAutoReplyCol.findOne.mockReset();
    mockAutoReplyCol.updateOne.mockReset();
    mockTemplatesCol.find.mockReset();
  });

  it("body 不正 (countries 欠落) → 400", async () => {
    const res = await PUT(jsonReq({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("countries");
    // DB 書込は発生しない
    expect(mockAutoReplyCol.updateOne).not.toHaveBeenCalled();
  });

  it("template_id 空文字 → 許容、 updateOne 実行", async () => {
    setupTemplates([]);
    const res = await PUT(
      jsonReq({
        countries: {
          SG: { enabled: false, triggerHour: 8, template_id: "" },
        },
      })
    );
    expect(res.status).toBe(200);
    expect(mockAutoReplyCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it("template_id ObjectId 形式不正 → 400 + updateOne 実行されない", async () => {
    setupTemplates([{ _id: VALID_ID_A, content: "hello" }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await PUT(
      jsonReq({
        countries: {
          SG: { enabled: true, triggerHour: 8, template_id: INVALID_ID },
        },
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      details: Array<{ country: string; template_id: string; reason: string }>;
    };
    expect(body.error).toBe("template_id validation failed");
    expect(body.details).toHaveLength(1);
    expect(body.details[0].country).toBe("SG");
    expect(body.details[0].reason).toContain("invalid ObjectId");
    expect(mockAutoReplyCol.updateOne).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("template_id は valid ObjectId だが reply_templates に不在 (orphan) → 400", async () => {
    setupTemplates([{ _id: VALID_ID_A, content: "hello" }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await PUT(
      jsonReq({
        countries: {
          SG: { enabled: true, triggerHour: 8, template_id: ORPHAN_ID },
        },
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      details: Array<{ country: string; template_id: string; reason: string }>;
    };
    expect(body.details).toHaveLength(1);
    expect(body.details[0].reason).toContain("orphan");
    expect(mockAutoReplyCol.updateOne).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("複数 country に混在 → 全 error をまとめて返す (fail-fast しない)", async () => {
    setupTemplates([{ _id: VALID_ID_A, content: "hello" }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await PUT(
      jsonReq({
        countries: {
          SG: { enabled: true, triggerHour: 8, template_id: INVALID_ID },
          MY: { enabled: true, triggerHour: 11, template_id: ORPHAN_ID },
          PH: { enabled: false, triggerHour: 3, template_id: VALID_ID_A },
        },
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      details: Array<{ country: string; template_id: string; reason: string }>;
    };
    // 2 件のエラー (SG=invalid, MY=orphan)、 PH は有効なので含まれない
    expect(body.details).toHaveLength(2);
    const countries = body.details.map((d) => d.country).sort();
    expect(countries).toEqual(["MY", "SG"]);
    warnSpy.mockRestore();
  });

  it("全て valid → 200 + updateOne 実行", async () => {
    setupTemplates([
      { _id: VALID_ID_A, content: "hello" },
      { _id: VALID_ID_B, content: "world" },
    ]);
    const res = await PUT(
      jsonReq({
        countries: {
          SG: { enabled: true, triggerHour: 8, template_id: VALID_ID_A },
          MY: { enabled: true, triggerHour: 11, template_id: VALID_ID_B },
        },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockAutoReplyCol.updateOne).toHaveBeenCalledTimes(1);
  });
});
