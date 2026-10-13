/** Decode and re-encode locally: strip EXIF/GPS, reduce transfer/cost, preserve readable text. */
export async function compressPhoto(file: File): Promise<File> {
  if (file.size > 20 * 1024 * 1024 || !file.type.startsWith("image/"))
    throw new Error("写真を20MB以内で選んでください");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      2048 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("写真を変換できません");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const quality of [0.9, 0.8, 0.7]) {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
      if (blob && blob.size <= 1500 * 1024) break;
    }
    if (!blob || blob.size > 1500 * 1024)
      throw new Error("写真が大きすぎます。範囲を狭めて撮り直してください");
    return new File([blob], "purchase.jpg", { type: "image/jpeg" });
  } catch (e) {
    throw new Error(
      e instanceof Error && e.message.includes("写真")
        ? e.message
        : "この写真は読み込めません。JPEG/PNGで選び直すか手動入力を使ってください",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
