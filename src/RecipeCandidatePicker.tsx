import type { Plan, RecipeCandidates } from "../worker/contracts";

export function RecipeCandidatePicker({
  plan,
  page,
  busy,
  select,
  next,
  cancel,
}: {
  plan: Plan;
  page: RecipeCandidates;
  busy: boolean;
  select: (id: string) => void;
  next: () => void;
  cancel: () => void;
}) {
  return (
    <section className="card review" aria-label="別の料理の候補選択">
      <h2>{plan.local_date}の料理を選ぶ</h2>
      <p>現在：{plan.recipe.title}。選んで確定するまで献立は変わりません。</p>
      <p className="muted">
        現在の料理と、この日に変更して外した料理は除外しています。食材不足は先の献立の予約量を反映した概算です。
      </p>
      {page.candidates.map(({ recipe, missing }) => (
        <article key={recipe.id} className="card">
          <h3>{recipe.title}</h3>
          <p>
            約{recipe.kcal} kcal · たんぱく質 {recipe.protein} g ·{" "}
            {recipe.total_minutes}分
          </p>
          <p>
            食材不足：
            {missing.length
              ? missing.map((i) => `${i.name} ${i.amount}${i.unit}`).join("、")
              : "なし"}
          </p>
          <details>
            <summary>使う食材と調味料</summary>
            <ul>
              {recipe.items.map((item) => (
                <li key={item.ingredientId}>
                  {item.name} {item.amount}
                  {item.unit}
                  {item.inventory_exempt ? "（常備調味料）" : ""}
                </li>
              ))}
            </ul>
          </details>
          <button disabled={busy} onClick={() => select(recipe.id)}>
            この料理に変更して確定
          </button>
        </article>
      ))}
      {!page.candidates.length && (
        <p role="status">
          条件を満たす別の候補はありません。在庫や設備などの条件を確認してください。
        </p>
      )}
      <div className="actions">
        <button
          className="secondary"
          disabled={busy || !page.hasMore}
          onClick={next}
        >
          表示済みを除いて次の候補を見る
        </button>
        <button className="secondary" disabled={busy} onClick={cancel}>
          変更せず閉じる
        </button>
      </div>
      <p className="muted">
        {page.hasMore
          ? "次の候補は、現在までに表示した料理を除いて入れ替わります。"
          : "追加の候補はありません。"}
      </p>
    </section>
  );
}
