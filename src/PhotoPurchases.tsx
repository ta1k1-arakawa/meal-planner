import { useEffect, useRef, useState } from "react";
import type { Ingredient } from "../worker/contracts";
import type { PhotoPurchase, PhotoItem } from "../worker/photo-contracts";
import { compressPhoto } from "./photo-camera";
class PhotoError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const multipart = body instanceof FormData;
  const response = await fetch("/api/photo-imports" + path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined || multipart
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      body === undefined ? undefined : multipart ? body : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new PhotoError(
      (data as { error?: { message?: string } }).error?.message ??
        "接続できません。手動入力を使えます",
      response.status,
    );
  return data as T;
}
const failureMessages: Record<string, string> = {
  PHOTO_UNREADABLE:
    "食品を読み取れませんでした。レシート・商品ラベルを明るい場所で撮り直してください。",
  PHOTO_AI_INVALID:
    "安全に読み取れませんでした。撮り直すか手動入力を使ってください。",
  PHOTO_AI_UNAVAILABLE:
    "解析に失敗しました。撮り直すか手動入力を使ってください。",
};
export function PhotoPurchases({
  ingredients,
  disabled,
  onWorking,
  onChanged,
}: {
  ingredients: Ingredient[];
  disabled: boolean;
  onWorking: (value: boolean) => void;
  onChanged: () => Promise<unknown>;
}) {
  const [history, setHistory] = useState<PhotoPurchase[]>([]),
    [purchase, setPurchase] = useState<PhotoPurchase | null>(null),
    [files, setFiles] = useState<File[]>([]),
    [multi, setMulti] = useState(false),
    [targetPurchase, setTargetPurchase] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [correcting, setCorrecting] = useState(false),
    [notice, setNotice] = useState("");
  const camera = useRef<HTMLInputElement>(null),
    library = useRef<HTMLInputElement>(null),
    multiCamera = useRef<HTMLInputElement>(null);
  const lock = useRef(false),
    selectionEpoch = useRef(0),
    uploadKey = useRef(crypto.randomUUID()),
    editKey = useRef<{ payload: string; key: string } | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  function remember(p: PhotoPurchase) {
    setPurchase(p);
    setHistory((h) => [p, ...h.filter((i) => i.id !== p.id)].slice(0, 20));
    setCorrecting(false);
  }
  useEffect(() => {
    let live = true;
    const epoch = selectionEpoch.current;
    request<PhotoPurchase[]>("")
      .then((h) => {
        if (live && epoch === selectionEpoch.current) {
          setHistory(h);
          setPurchase(h[0] ?? null);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (purchase?.status !== "processing") return;
    let live = true;
    const timer = window.setInterval(() => {
      request<PhotoPurchase>("/" + purchase.id)
        .then((p) => {
          if (live) {
            remember(p);
            if (p.status !== "processing") {
              if (p.status !== "failed") {
                setFiles([]);
                setTargetPurchase(null);
              }
              void changed.current().catch(() => {});
            }
          }
        })
        .catch(() => {});
    }, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [purchase?.id, purchase?.status]);
  async function perform(action: () => Promise<PhotoPurchase>) {
    if (lock.current || disabled) return;
    lock.current = true;
    selectionEpoch.current++;
    setWorking(true);
    onWorking(true);
    setError("");
    setNotice("");
    try {
      const p = await action();
      remember(p);
      setNotice(
        p.enriched
          ? "追加写真から保留項目を更新しました。登録済みの量は重ねて加算していません。"
          : p.enriched === false
            ? "追加写真でも保留項目を確実に補完できませんでした。手動で確認できます。"
            : p.duplicate
              ? "同じ写真・レシートの登録履歴です。在庫は再追加していません。"
              : "",
      );
      await changed.current();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "処理できませんでした。手動入力を使えます",
      );
      if (e instanceof PhotoError && e.status === 409 && purchase) {
        try {
          remember(await request<PhotoPurchase>("/" + purchase.id));
          await changed.current();
        } catch {
          /* Safe retry stays explicit. */
        }
      }
    } finally {
      lock.current = false;
      setWorking(false);
      onWorking(false);
    }
  }
  async function upload(images: File[], retry = false) {
    if (retry) uploadKey.current = crypto.randomUUID();
    const form = new FormData();
    form.append("idempotencyKey", uploadKey.current);
    if (targetPurchase) form.append("purchaseId", targetPurchase);
    images.forEach((f) => form.append("images", f));
    await perform(async () => {
      const result = await request<PhotoPurchase>("", form);
      if (!["failed", "processing"].includes(result.status)) {
        setFiles([]);
        setTargetPurchase(null);
      }
      return result;
    });
  }
  async function select(selected: FileList | null, accumulate: boolean) {
    if (!selected?.length || lock.current || working || disabled) return;
    setError("");
    if ((accumulate ? files.length : 0) + selected.length > 4) {
      setError("写真は4枚までです");
      return;
    }
    lock.current = true;
    setWorking(true);
    onWorking(true);
    selectionEpoch.current++;
    let next: File[] | null = null;
    try {
      const added = await Promise.all(Array.from(selected).map(compressPhoto));
      next = accumulate ? [...files, ...added] : added;
      setFiles(next);
      uploadKey.current = crypto.randomUUID();
    } catch (e) {
      setError(e instanceof Error ? e.message : "写真を選び直してください");
    } finally {
      lock.current = false;
      setWorking(false);
      onWorking(false);
    }
    if (!accumulate && next) await upload(next);
  }
  function edit(path: string, value: unknown) {
    const payload = JSON.stringify({ id: purchase?.id, path, value });
    if (editKey.current?.payload !== payload)
      editKey.current = { payload, key: crypto.randomUUID() };
    const body = { ...(value as object), idempotencyKey: editKey.current.key };
    return perform(() =>
      request<PhotoPurchase>("/" + purchase!.id + "/" + path, body),
    );
  }
  const pending = purchase?.items.filter((i) => i.status === "pending") ?? [];
  const added = purchase?.items.filter((i) => i.applied_amount > 0) ?? [];
  const manual = ingredients.filter((i) => !i.inventory_exempt);
  return (
    <section className="card photo-purchases" aria-labelledby="photo-title">
      <h3 id="photo-title">購入品を写真で登録</h3>
      <p className="muted">
        レシートと商品ラベルが読めるように撮影。確かな項目は自動で在庫に追加し、不明な項目だけ確認します。
      </p>
      <input
        ref={camera}
        aria-label="購入品をカメラで撮影"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void select(e.target.files, false);
          e.target.value = "";
        }}
      />
      <input
        ref={library}
        aria-label="購入品の写真を選択"
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void select(e.target.files, multi);
          e.target.value = "";
        }}
      />
      <input
        ref={multiCamera}
        aria-label="追加の購入品を撮影"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void select(e.target.files, true);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled || working}
        onClick={() => {
          setMulti(false);
          setTargetPurchase(null);
          camera.current?.click();
        }}
      >
        📷 購入品を撮影して在庫に追加
      </button>
      <div className="photo-actions">
        <button
          type="button"
          className="secondary"
          disabled={disabled || working}
          onClick={() => {
            if (!multi) setTargetPurchase(null);
            library.current?.click();
          }}
        >
          写真から選ぶ
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled || working}
          onClick={() => {
            setMulti(true);
            setTargetPurchase(null);
            setFiles([]);
          }}
        >
          複数枚で撮る
        </button>
      </div>
      {multi && (
        <div className="notice">
          <p>
            {targetPurchase
              ? "保留項目を補完します。同じ購入のレシートと商品ラベルを新たに撮影してください（最大4枚）。"
              : "レシートと購入品を分けて撮影できます（最大4枚）。"}
            選択済み：
            {files.length}枚
          </p>
          <div className="photo-actions">
            <button
              type="button"
              disabled={disabled || working || files.length >= 4}
              onClick={() => multiCamera.current?.click()}
            >
              写真を追加
            </button>
            <button
              type="button"
              disabled={disabled || working || !files.length}
              onClick={() => {
                setMulti(false);
                void upload(files);
              }}
            >
              まとめて解析して登録
            </button>
            <button
              type="button"
              className="secondary"
              disabled={working}
              onClick={() => {
                setMulti(false);
                setTargetPurchase(null);
                setFiles([]);
              }}
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
      <details>
        <summary>写真の扱い・手動入力</summary>
        <p>
          写真はGemini APIへ送信します。Paid
          Tier向け設定を使用します。会員番号・カード番号・住所は撮影前に隠してください。このアプリは写真やレシート全文を保存しません。解析ができない場合は下の買い物リスト、または「在庫」タブから入力できます。
        </p>
      </details>
      {working && (
        <p role="status">
          解析・登録中です。通信が切れた場合は履歴から状態を確認してください。
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!working && error && files.length > 0 && (
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => void upload(files)}
        >
          再送して登録結果を確認
        </button>
      )}
      {history.length > 1 && (
        <label>
          写真登録の履歴
          <select
            value={purchase?.id ?? ""}
            disabled={working}
            onChange={(e) => {
              setPurchase(history.find((p) => p.id === e.target.value) ?? null);
              setCorrecting(false);
              setFiles([]);
              setTargetPurchase(null);
              selectionEpoch.current++;
              setNotice("");
            }}
          >
            {history.map((p) => (
              <option value={p.id} key={p.id}>
                {new Date(p.created_at).toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                })}{" "}
                · {p.items.length}件 ·{" "}
                {p.status === "undone"
                  ? "取消済み"
                  : p.status === "failed"
                    ? "解析失敗"
                    : "登録結果"}
              </option>
            ))}
          </select>
        </label>
      )}
      {purchase && (
        <div className="photo-result">
          {purchase.status === "processing" ? (
            <>
              <p role="status">
                {purchase.lease_until < new Date().toISOString()
                  ? "解析の待機期限が過ぎました。再撮影または元の写真を選び直すと再解析できます。"
                  : "解析中です。結果は自動で更新します。"}
              </p>
              {purchase.lease_until < new Date().toISOString() &&
                files.length > 0 && (
                  <button
                    type="button"
                    disabled={disabled || working}
                    onClick={() => void upload(files, true)}
                  >
                    同じ写真でもう一度解析
                  </button>
                )}
            </>
          ) : purchase.status === "failed" ? (
            <>
              <p role="alert">
                {failureMessages[purchase.error_code ?? ""] ??
                  "解析できませんでした。手動入力を使えます。"}
              </p>
              {files.length > 0 && (
                <button
                  type="button"
                  disabled={disabled || working}
                  onClick={() => void upload(files, true)}
                >
                  同じ写真でもう一度解析
                </button>
              )}
            </>
          ) : (
            <>
              <p role="status">
                検出 {purchase.items.length}件 · 在庫に追加 {added.length}件 ·
                あとで確認 {pending.length}件
                {purchase.status === "undone" ? " · 取り消し済み" : ""}
              </p>
              {added.length > 0 && (
                <ul>
                  {added.map((i) => (
                    <li key={i.id}>
                      {ingredients.find((g) => g.id === i.ingredient_id)
                        ?.name ?? i.label}
                      ：+{i.applied_amount}
                      {ingredients.find((g) => g.id === i.ingredient_id)?.unit}
                      {JSON.parse(i.evidence_json).basis ===
                      "configured_conversion"
                        ? i.reason === "ユーザーが確認・訂正"
                          ? "（手動訂正）"
                          : "（設定係数で換算・概算）"
                        : ""}
                    </li>
                  ))}
                </ul>
              )}
              {purchase.status === "review" && pending.length > 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled || working}
                  onClick={() => {
                    setTargetPurchase(purchase.id);
                    setMulti(true);
                    setFiles([]);
                  }}
                >
                  写真を追加して保留項目を解析
                </button>
              )}
              {purchase.relation === "unknown" &&
                purchase.status !== "undone" && (
                  <div className="notice">
                    <p>
                      {purchase.possible_duplicate_id
                        ? "同じ買い物か区別できない写真登録があります。同じ買い物ですか？"
                        : "同じ日に、この食品を手動で購入確定した履歴があります。同じ買い物ですか？"}{" "}
                      この確認が終わるまで追加しません。
                    </p>
                    <div className="photo-actions">
                      <button
                        disabled={disabled || working}
                        onClick={() =>
                          void edit("resolve", {
                            version: purchase.version,
                            relation: "recorded",
                            items: [],
                          })
                        }
                      >
                        登録済みなので追加しない
                      </button>
                      {!purchase.possible_duplicate_id &&
                        purchase.manual_candidates === 1 && (
                          <button
                            disabled={disabled || working}
                            onClick={() =>
                              void edit("resolve", {
                                version: purchase.version,
                                relation: "same",
                                items: [],
                              })
                            }
                          >
                            同じ購入・未登録分だけ追加
                          </button>
                        )}
                      <button
                        className="secondary"
                        disabled={disabled || working}
                        onClick={() =>
                          void edit("resolve", {
                            version: purchase.version,
                            relation: "new",
                            items: [],
                          })
                        }
                      >
                        別の買い物として追加
                      </button>
                    </div>
                  </div>
                )}
              {purchase.status !== "undone" &&
                purchase.relation !== "unknown" &&
                pending.length > 0 && (
                  <PhotoRows
                    key={purchase.id + ":" + purchase.version + ":pending"}
                    items={pending}
                    ingredients={manual}
                    disabled={disabled || working}
                    title="あとで確認"
                    submit={(items) =>
                      void edit("resolve", { version: purchase.version, items })
                    }
                  />
                )}
              <details>
                <summary>読み取り結果をすべて見る</summary>
                <ul>
                  {purchase.items.map((i) => (
                    <li key={i.id}>
                      {i.label} ·{" "}
                      {i.status === "pending"
                        ? "保留"
                        : i.status === "ignored"
                          ? "登録対象外"
                          : i.status === "undone"
                            ? "取り消し済み"
                            : "確認済み"}{" "}
                      · 確信度 {Math.round(i.confidence * 100)}% · {i.reason}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  確信度はAIの自己評価です。読み漏れや誤認識を保証する数値ではありません。
                </p>
              </details>
              {purchase.status !== "undone" && (
                <>
                  <div className="photo-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || working}
                      onClick={() => setCorrecting((v) => !v)}
                    >
                      登録内容を修正
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || working}
                      onClick={() => {
                        if (
                          window.confirm(
                            "今回の写真登録による在庫追加を取り消します。すでに使った食材が不足する場合は取り消せません。続けますか？",
                          )
                        )
                          void edit("undo", { version: purchase.version });
                      }}
                    >
                      今回の登録を取り消す
                    </button>
                  </div>
                  {correcting && (
                    <PhotoRows
                      key={purchase.id + ":" + purchase.version + ":correct"}
                      items={purchase.items}
                      ingredients={manual}
                      disabled={disabled || working}
                      title="登録内容の修正"
                      submit={(items) =>
                        void edit("correct", {
                          version: purchase.version,
                          items,
                        })
                      }
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
type RowEdit = { id: string; ingredientId: string | null; amount: number };
function PhotoRows({
  items,
  ingredients,
  disabled,
  title,
  submit,
}: {
  items: PhotoItem[];
  ingredients: Ingredient[];
  disabled: boolean;
  title: string;
  submit: (rows: RowEdit[]) => void;
}) {
  const [values, setValues] = useState<
    Record<string, { ingredientId: string; amount: string }>
  >(() =>
    Object.fromEntries(
      items.map((i) => [
        i.id,
        {
          ingredientId: i.ingredient_id ?? "",
          amount: i.ingredient_id && i.amount !== null ? String(i.amount) : "",
        },
      ]),
    ),
  );
  const [message, setMessage] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const rows: RowEdit[] = [];
        for (const item of items) {
          const value = values[item.id];
          if (
            !value.ingredientId ||
            (item.status === "pending" &&
              value.amount === "" &&
              value.ingredientId !== "ignore")
          )
            continue;
          if (value.ingredientId === "ignore") {
            rows.push({ id: item.id, ingredientId: null, amount: 0 });
            continue;
          }
          const amount = Number(value.amount);
          if (
            value.amount === "" ||
            !Number.isInteger(amount) ||
            amount < 0 ||
            amount > 1000000
          ) {
            setMessage("選んだ食品の実際の分量を整数で入力してください");
            return;
          }
          rows.push({ id: item.id, ingredientId: value.ingredientId, amount });
        }
        if (!rows.length) {
          setMessage(
            "確認する項目を入力するか「登録しない」を選んでください。未入力の項目は保留のまま残します。",
          );
          return;
        }
        setMessage("");
        submit(rows);
      }}
    >
      <h4>{title}</h4>
      <p className="muted">
        辞書にない食品は「登録しない」。生米を炊飯済みご飯として選ばないでください。重量は実際のg/mlで入力します。
      </p>
      {items.map((item) => {
        const value = values[item.id];
        const ingredient = ingredients.find((i) => i.id === value.ingredientId);
        return (
          <div className="photo-row" key={item.id}>
            <p>
              {item.label}：{item.reason}
            </p>
            <label>
              登録先
              <select
                disabled={disabled}
                value={value.ingredientId}
                onChange={(e) =>
                  setValues({
                    ...values,
                    [item.id]: { ingredientId: e.target.value, amount: "" },
                  })
                }
              >
                <option value="">あとで確認</option>
                <option value="ignore">登録しない</option>
                {ingredients.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}（
                    {i.state === "raw"
                      ? "生"
                      : i.state === "cooked"
                        ? "調理済み"
                        : "製品"}
                    ）
                  </option>
                ))}
              </select>
            </label>
            {ingredient && (
              <label>
                実際の量（{ingredient.unit}）
                <input
                  disabled={disabled}
                  type="number"
                  min="0"
                  max="1000000"
                  step="1"
                  value={value.amount}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      [item.id]: { ...value, amount: e.target.value },
                    })
                  }
                />
              </label>
            )}
          </div>
        );
      })}
      {message && <p role="alert">{message}</p>}
      <button disabled={disabled}>この項目だけ確認して保存</button>
    </form>
  );
}
