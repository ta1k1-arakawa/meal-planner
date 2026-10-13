// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  cleanup,
  act,
} from "@testing-library/react";
import { App } from "../src/App";
import type {
  Plan,
  Recipe,
  Cycle,
  Settings,
  MealLog,
} from "../worker/contracts";

const recipes: Recipe[] = Array.from({ length: 30 }, (_, n) => ({
  id: "recipe-" + n,
  title: "料理" + n,
  total_minutes: 20,
  equipment_json: '["フライパン"]',
  instructions_json: '["材料を切って火を通す"]',
  preference_weight: 0,
  kcal: 950 + n,
  protein: 40,
  items: [
    {
      ingredientId: "rice",
      name: "ご飯",
      amount: 350,
      unit: "g",
      inventory_exempt: false,
      kcal_per_100: 156,
      protein_per_100: 2.5,
      source: "test",
      food_code: "test",
      state: "cooked",
    },
  ],
}));
const settings: Settings = {
  version: 0,
  dailyKcal: 2800,
  dailyProtein: 110,
  dinnerKcal: 950,
  dinnerProtein: 40,
  maxMinutes: 30,
  shoppingDays: [2, 6],
  equipment: ["フライパン"],
  allergies: [],
  excludedIngredients: [],
};
let plans: Plan[], logs: MealLog[], cycle: Cycle | null, date: string;
let conflict: boolean, delay: Promise<void> | undefined;
let refreshDelay: Promise<void> | undefined;
let calls: { path: string; body: Record<string, unknown> | undefined }[];
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
beforeEach(() => {
  date = "2026-10-13";
  logs = [];
  conflict = false;
  delay = undefined;
  refreshDelay = undefined;
  calls = [];
  plans = [
    {
      id: "past",
      local_date: "2026-10-12",
      status: "planned",
      version: 0,
      recipe: recipes[0],
    },
    {
      id: "today",
      local_date: date,
      status: "planned",
      version: 0,
      recipe: recipes[1],
    },
    {
      id: "future",
      local_date: "2026-10-14",
      status: "planned",
      version: 0,
      recipe: recipes[2],
    },
  ];
  cycle = {
    id: "run_test",
    kind: "run",
    starts_on: date,
    ends_on: "2026-10-16",
    shopping_on: date,
    status: "review",
    version: 0,
    obsolete: 0,
    shopping_days_json: "[2,6]",
    items: [
      {
        ingredient_id: "rice",
        name: "ご飯",
        requested_amount: 350,
        proposed_amount: 350,
        actual_amount: null,
        unit: "g",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input).replace("/api", "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });
      if (path === "/inventory")
        return response([
          { id: "rice", name: "ご飯", quantity: 0, version: 0, unit: "g" },
        ]);
      if (path === "/plans") return response(plans);
      if (path === "/meal-logs") return response(logs);
      if (path === "/settings") return response(settings);
      if (path === "/ingredients")
        return response([
          { id: "rice", name: "ご飯", unit: "g", inventory_exempt: 0 },
        ]);
      if (path === "/recipes") return response(recipes);
      if (path === "/today")
        return response({
          date,
          plan: plans.find((p) => p.local_date === date),
          nutrition: {
            confirmed: { kcal: 0, protein: 0 },
            projected: { kcal: 950, protein: 40 },
            unknown: [],
            presets: [],
          },
        });
      if (path === "/shopping/current") {
        if (refreshDelay) await refreshDelay;
        return response(cycle);
      }
      if (path.endsWith("/candidates")) {
        const values = recipes
          .slice(3)
          .filter((r) => !body.exclude.includes(r.id));
        return response({
          planId: "today",
          version: body.version,
          hasMore: values.length > 5,
          candidates: values.slice(0, 5).map((recipe) => ({
            recipe,
            missing: [
              { ingredientId: "rice", name: "ご飯", amount: 350, unit: "g" },
            ],
          })),
        });
      }
      if (path.endsWith("/regenerate")) {
        if (delay) await delay;
        if (conflict) {
          conflict = false;
          plans[1] = { ...plans[1], version: 4 };
          return response(
            { error: { code: "CONFLICT", message: "献立が変更されました" } },
            409,
          );
        }
        plans[1] = {
          ...plans[1],
          recipe: recipes.find((r) => r.id === body.recipeId)!,
          version: plans[1].version + 1,
        };
        if (cycle)
          cycle = {
            ...cycle,
            version: cycle.version + 1,
            items: [{ ...cycle.items[0], proposed_amount: 700 }],
          };
        return response({ ok: true });
      }
      if (path === "/shopping/today") return response(cycle);
      return response({ error: { message: "unexpected " + path } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function start() {
  render(<App />);
  await screen.findByRole("heading", { name: "今夜の夕食" });
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "別の料理に変更" }));
  return screen.findByRole("region", { name: "別の料理の候補選択" });
}

describe("mobile daily flows", () => {
  it("hides past plans, separates 30 recipes, removes History and both confusing checks", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "献立" }));
    expect(screen.queryByRole("heading", { name: "料理0" })).toBeNull();
    expect(screen.getByRole("heading", { name: "料理1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "料理2" })).toBeTruthy();
    expect(screen.queryByText("レシピ一覧（30件）")).toBeNull();
    expect(screen.queryByRole("button", { name: "記録" })).toBeNull();
    expect(
      screen.queryByLabelText("買い物日以外も買い足しを許可する"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "レシピ" }));
    expect(screen.getByText("レシピ一覧（30件）")).toBeTruthy();
    expect(screen.getAllByText("材料を切って火を通す")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    expect(
      screen.queryByLabelText("古い未確定の買い物リストを整理して再計算する"),
    ).toBeNull();
    expect(calls.some((c) => c.path === "/meal-logs")).toBe(true);
  });
  it("opens candidates next to the title and changes plan + shopping display without browser reload or scroll reset", async () => {
    const scroll = vi.spyOn(window, "scrollTo");
    await start();
    const picker = await open();
    const card = picker.parentElement!.closest("article")!;
    expect(picker.closest(".feedback")).toBeNull();
    expect(picker.parentElement?.id).toBe("candidates-today");
    expect(within(card).getByRole("heading", { name: "料理1" })).toBeTruthy();
    expect(
      within(picker).getAllByRole("button", { name: "この料理に変更して確定" }),
    ).toHaveLength(5);
    fireEvent.click(
      within(picker).getAllByRole("button", {
        name: "この料理に変更して確定",
      })[2],
    );
    await screen.findByRole("heading", { name: "料理5" });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "別の料理の候補選択" }),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "買い物" }));
    expect(screen.getByText(/ご飯 · 必要な買い足し 700/)).toBeTruthy();
    expect(scroll).not.toHaveBeenCalled();
  });
  it("pages candidates without refreshing, and closes back to the change button", async () => {
    await start();
    const picker = await open();
    fireEvent.click(
      within(picker).getByRole("button", {
        name: "表示済みを除いて次の候補を見る",
      }),
    );
    await screen.findByRole("heading", { name: "料理8" });
    expect(screen.queryByRole("heading", { name: "料理3" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "変更せず閉じる" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "別の料理に変更" }),
      ),
    );
    expect(calls.filter((c) => c.path.endsWith("/regenerate"))).toHaveLength(0);
  });
  it("prevents a double submit and refreshes stale candidates on 409", async () => {
    await start();
    let resolve!: () => void;
    delay = new Promise<void>((r) => {
      resolve = r;
    });
    conflict = true;
    const picker = await open();
    const button = within(picker).getAllByRole("button", {
      name: "この料理に変更して確定",
    })[0];
    act(() => {
      button.click();
      button.click();
    });
    expect(calls.filter((c) => c.path.endsWith("/regenerate"))).toHaveLength(1);
    expect(screen.getByText("処理中…")).toBeTruthy();
    resolve();
    await screen.findByText(
      "最新の状態を取得しました。候補を確認して選び直してください",
    );
    expect(
      calls.filter((c) => c.path.endsWith("/candidates")).at(-1)?.body?.version,
    ).toBe(4);
  });
  it("buys today in one action without a confirm dialog or weekday checkbox", async () => {
    const confirm = vi.spyOn(window, "confirm");
    await start();
    fireEvent.click(screen.getByRole("button", { name: "買い物" }));
    fireEvent.click(screen.getByRole("button", { name: "今日買う食材を表示" }));
    await screen.findByText("今日買う食材を更新しました");
    expect(calls.filter((c) => c.path === "/shopping/today")).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("refreshes on phone focus and Tokyo day change, while leaving edited shopping amounts alone", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "献立" }));
    date = "2026-10-14";
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "料理1" })).toBeNull(),
    );
    expect(screen.getByRole("heading", { name: "料理2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "買い物" }));
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "123" } });
    const count = calls.length;
    fireEvent(window, new Event("focus"));
    expect(calls).toHaveLength(count);
    expect((input as HTMLInputElement).value).toBe("123");
  });
  it("retains the completed dinner snapshot without exposing a History tab", async () => {
    plans[1] = { ...plans[1], status: "completed" };
    logs = [
      {
        id: "log",
        plan_id: "today",
        completed_at: "2026-10-13T12:00:00Z",
        recipe_snapshot: JSON.stringify({
          ...recipes[1],
          title: "保存された料理",
        }),
        total_kcal: 900,
        total_protein_g: 39,
      },
    ];
    await start();
    expect(
      screen.getByRole("heading", { name: "保存された料理" }),
    ).toBeTruthy();
    expect(screen.getByText("食べた")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "記録" })).toBeNull();
  });
});

it("preserves purchase quantities edited while a background read is already in flight", async () => {
  await start();
  fireEvent.click(screen.getByRole("button", { name: "買い物" }));
  let resolve!: () => void;
  refreshDelay = new Promise<void>((r) => {
    resolve = r;
  });
  fireEvent(window, new Event("focus"));
  const input = screen.getByRole("spinbutton") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "123" } });
  cycle = {
    ...cycle!,
    version: 1,
    items: [{ ...cycle!.items[0], proposed_amount: 700 }],
  };
  await act(async () => {
    resolve();
    await Promise.resolve();
  });
  expect(input.value).toBe("123");
});
