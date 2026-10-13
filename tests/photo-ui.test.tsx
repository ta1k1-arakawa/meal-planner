// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PhotoPurchases } from "../src/PhotoPurchases";
import type { PhotoPurchase, PhotoItem } from "../worker/photo-contracts";
import type { Ingredient } from "../worker/contracts";
vi.mock("../src/photo-camera", () => ({
  compressPhoto: vi.fn(async (f: File) => f),
}));
const ingredients: Ingredient[] = [
  {
    id: "tofu",
    name: "木綿豆腐",
    state: "ready",
    unit: "g",
    display_unit: "丁",
    grams_per_display_unit: 300,
    kcal_per_100: 0,
    protein_per_100: 0,
    source: "test",
    food_code: "test",
    allergens_json: "[]",
    inventory_exempt: 0,
  },
  {
    id: "tomato",
    name: "トマト",
    state: "raw",
    unit: "g",
    display_unit: null,
    grams_per_display_unit: null,
    kcal_per_100: 0,
    protein_per_100: 0,
    source: "test",
    food_code: "test",
    allergens_json: "[]",
    inventory_exempt: 0,
  },
];
const row = (overrides: Partial<PhotoItem> = {}): PhotoItem => ({
  id: "row-1",
  purchase_id: "photo-1",
  label: "木綿豆腐",
  candidate_id: "tofu",
  ingredient_id: "tofu",
  amount: 400,
  applied_amount: 400,
  confidence: 0.99,
  auto_eligible: 1,
  status: "applied",
  reason: "明示された分量",
  evidence_json: '{"basis":"label"}',
  ...overrides,
});
const result = (overrides: Partial<PhotoPurchase> = {}): PhotoPurchase => ({
  id: "photo-1",
  status: "applied",
  version: 2,
  purchase_date: "2026-10-13",
  linked_cycle_id: null,
  relation: "new",
  model: "gemini-2.5-flash",
  error_code: null,
  image_count: 1,
  created_at: "2026-10-13T03:00:00Z",
  lease_until: "2026-10-13T03:02:00Z",
  possible_duplicate_id: null,
  manual_candidates: 0,
  items: [row()],
  ...overrides,
});
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let history: PhotoPurchase[],
  next: PhotoPurchase,
  fail: boolean,
  calls: {
    path: string;
    body: FormData | Record<string, unknown> | undefined;
  }[];
const changed = vi.fn(async () => {}),
  working = vi.fn();
beforeEach(() => {
  history = [];
  next = result();
  fail = false;
  calls = [];
  changed.mockClear();
  working.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const body =
        init?.body instanceof FormData
          ? init.body
          : init?.body
            ? JSON.parse(String(init.body))
            : undefined;
      calls.push({ path, body });
      if (!body)
        return response(path === "/api/photo-imports" ? history : next);
      if (fail) {
        fail = false;
        throw new Error("通信が切れました");
      }
      return response(next);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount() {
  return render(
    <PhotoPurchases
      ingredients={ingredients}
      disabled={false}
      onWorking={working}
      onChanged={changed}
    />,
  );
}
const photo = () =>
  new File(["test-only-image"], "test.jpg", { type: "image/jpeg" });
async function shoot() {
  fireEvent.change(screen.getByLabelText("購入品をカメラで撮影"), {
    target: { files: [photo()] },
  });
  await waitFor(() => expect(changed).toHaveBeenCalled());
}
describe("photo shopping interactions", () => {
  it("uploads immediately from camera, shows added quantities and never asks to confirm every row", async () => {
    mount();
    await shoot();
    expect(screen.getByText(/検出 1件/).textContent).toContain(
      "在庫に追加 1件",
    );
    expect(screen.getByText(/木綿豆腐：\+400g/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "この項目だけ確認して保存" }),
    ).toBeNull();
    const upload = calls.find((c) => c.body instanceof FormData)!;
    expect((upload.body as FormData).getAll("images")).toHaveLength(1);
    expect((upload.body as FormData).get("idempotencyKey")).toBeTruthy();
    expect(working.mock.calls.map((c) => c[0])).toContain(true);
  });
  it("collects multiple camera views and sends exactly one grouped request", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "複数枚で撮る" }));
    fireEvent.change(screen.getByLabelText("追加の購入品を撮影"), {
      target: { files: [photo()] },
    });
    await waitFor(() => expect(screen.getByText(/選択済み：1枚/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText("追加の購入品を撮影"), {
      target: { files: [photo()] },
    });
    await waitFor(() => expect(screen.getByText(/選択済み：2枚/)).toBeTruthy());
    expect(calls.filter((c) => c.body instanceof FormData)).toHaveLength(0);
    fireEvent.click(
      screen.getByRole("button", { name: "まとめて解析して登録" }),
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(
      (calls.find((c) => c.body instanceof FormData)!.body as FormData).getAll(
        "images",
      ),
    ).toHaveLength(2);
  });
  it("shows only uncertain rows for confirmation, never preselecting raw rice as cooked rice", async () => {
    next = result({
      status: "review",
      items: [
        row(),
        row({
          id: "unknown-row",
          label: "無洗米",
          candidate_id: "rice",
          ingredient_id: null,
          amount: null,
          applied_amount: 0,
          auto_eligible: 0,
          status: "pending",
          reason: "食品状態が違います",
        }),
      ],
    });
    mount();
    await shoot();
    const form = screen
      .getByRole("heading", { name: "あとで確認" })
      .closest("form")!;
    expect(within(form).getAllByLabelText("登録先")).toHaveLength(1);
    expect(
      (within(form).getByLabelText("登録先") as unknown as { value: string })
        .value,
    ).toBe("");
    fireEvent.change(within(form).getByLabelText("登録先"), {
      target: { value: "ignore" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "この項目だけ確認して保存" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith("/resolve"))).toBe(true),
    );
    const body = calls.find((c) => c.path.endsWith("/resolve"))!.body as Record<
      string,
      unknown
    >;
    expect(body.items).toEqual([
      { id: "unknown-row", ingredientId: null, amount: 0 },
    ]);
  });
  it("lets one pending quantity be entered while leaving other uncertain rows for later", async () => {
    next = result({
      status: "review",
      items: [
        row({
          id: "quantity-row",
          label: "トマト",
          candidate_id: "tomato",
          ingredient_id: "tomato",
          amount: null,
          applied_amount: 0,
          auto_eligible: 0,
          status: "pending",
          reason: "数量不明",
        }),
        row({
          id: "unknown-row",
          label: "未知の食品",
          candidate_id: null,
          ingredient_id: null,
          amount: null,
          applied_amount: 0,
          auto_eligible: 0,
          status: "pending",
          reason: "食品不明",
        }),
      ],
    });
    mount();
    await shoot();
    const form = screen
      .getByRole("heading", { name: "あとで確認" })
      .closest("form")!;
    fireEvent.change(within(form).getByLabelText("実際の量（g）"), {
      target: { value: "300" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "この項目だけ確認して保存" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith("/resolve"))).toBe(true),
    );
    expect(
      (
        calls.find((c) => c.path.endsWith("/resolve"))!.body as Record<
          string,
          unknown
        >
      ).items,
    ).toEqual([{ id: "quantity-row", ingredientId: "tomato", amount: 300 }]);
  });
  it("shows connection failure with manual fallback and retries a lost response with the same key", async () => {
    fail = true;
    mount();
    fireEvent.change(screen.getByLabelText("購入品をカメラで撮影"), {
      target: { files: [photo()] },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "通信が切れました",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "再送して登録結果を確認" }),
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    const bodies = calls
      .filter((c) => c.body instanceof FormData)
      .map((c) => c.body as FormData);
    expect(bodies[0].get("idempotencyKey")).toBe(
      bodies[1].get("idempotencyKey"),
    );
    expect(screen.getByText(/下の買い物リスト/)).toBeTruthy();
  });
  it("asks about purchase overlap only as an exception and offers Undo from result history", async () => {
    next = result({
      relation: "unknown",
      manual_candidates: 1,
      status: "review",
      items: [row({ status: "pending", applied_amount: 0 })],
    });
    mount();
    await shoot();
    expect(
      screen.getByRole("button", { name: "同じ購入・未登録分だけ追加" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "この項目だけ確認して保存" }),
    ).toBeNull();
    next = result();
    fireEvent.click(
      screen.getByRole("button", { name: "同じ購入・未登録分だけ追加" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.path.endsWith("/resolve"))).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByText(/この確認が終わるまで/)).toBeNull(),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    next = result({
      status: "undone",
      version: 3,
      items: [row({ status: "undone", amount: 0, applied_amount: 0 })],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "今回の登録を取り消す" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((p) => p.textContent?.includes("取り消し済み")),
      ).toBe(true),
    );
    expect(calls.filter((c) => c.path.endsWith("/undo"))).toHaveLength(1);
  });
  it("allows correcting just the registered item and refreshes changed data afterwards", async () => {
    mount();
    await shoot();
    fireEvent.click(screen.getByRole("button", { name: "登録内容を修正" }));
    const form = screen
      .getByRole("heading", { name: "登録内容の修正" })
      .closest("form")!;
    fireEvent.change(within(form).getByLabelText("実際の量（g）"), {
      target: { value: "250" },
    });
    next = result({
      version: 3,
      items: [row({ amount: 250, applied_amount: 250 })],
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "この項目だけ確認して保存" }),
    );
    await waitFor(() =>
      expect(screen.getByText(/木綿豆腐：\+250g/)).toBeTruthy(),
    );
    const body = calls.find((c) => c.path.endsWith("/correct"))!.body as Record<
      string,
      unknown
    >;
    expect(body.items).toEqual([
      { id: "row-1", ingredientId: "tofu", amount: 250 },
    ]);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
