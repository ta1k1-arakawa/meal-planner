import { keySchema } from "./contracts";
import { DomainError } from "./planner";
import { digest } from "./photo-normalize";

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 1500 * 1024;
export interface PhotoImage {
  mime: "image/jpeg" | "image/png";
  bytes: ArrayBuffer;
  hash: string;
}
export function imageDimensions(
  bytes: ArrayBuffer,
  mime: string,
): [number, number] | null {
  const v = new DataView(bytes);
  if (mime === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (
      v.byteLength < 33 ||
      signature.some((n, i) => v.getUint8(i) !== n) ||
      v.getUint32(8) !== 13 ||
      v.getUint32(12) !== 0x49484452
    )
      return null;
    return [v.getUint32(16), v.getUint32(20)];
  }
  if (
    mime !== "image/jpeg" ||
    v.byteLength < 4 ||
    v.getUint16(0) !== 0xffd8 ||
    v.getUint16(v.byteLength - 2) !== 0xffd9
  )
    return null;
  let i = 2;
  while (i + 4 <= v.byteLength) {
    if (v.getUint8(i++) !== 0xff) return null;
    while (i < v.byteLength && v.getUint8(i) === 0xff) i++;
    if (i + 3 > v.byteLength) return null;
    const marker = v.getUint8(i++);
    if (marker === 0xda || marker === 0xd9) break;
    const length = v.getUint16(i);
    if (length < 2 || i + length > v.byteLength) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8)
      return [v.getUint16(i + 5), v.getUint16(i + 3)];
    i += length;
  }
  return null;
}
export async function parseUpload(request: Request) {
  if (!request.headers.get("Content-Type")?.startsWith("multipart/form-data"))
    throw new DomainError(
      "PHOTO_MULTIPART_REQUIRED",
      "写真を選び直してください",
      400,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new DomainError("PHOTO_REQUIRED", "写真を選んでください", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new DomainError(
        "PHOTO_TOO_LARGE",
        "写真は合計6MB以内にしてください",
        422,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let form: FormData;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: bytes,
    }).formData();
  } catch {
    throw new DomainError(
      "PHOTO_INVALID",
      "写真の送信形式を確認してください",
      422,
    );
  }
  if ([...form.keys()].some((k) => k !== "images" && k !== "idempotencyKey"))
    throw new DomainError(
      "PHOTO_INVALID",
      "写真の送信形式を確認してください",
      422,
    );
  if (form.getAll("idempotencyKey").length !== 1)
    throw new DomainError("PHOTO_INVALID", "再送キーが必要です", 422);
  const key = keySchema.parse(form.get("idempotencyKey"));
  const files = form.getAll("images");
  if (files.length < 1 || files.length > 4)
    throw new DomainError("PHOTO_COUNT", "写真は1〜4枚にしてください", 422);
  const images: PhotoImage[] = [];
  for (const file of files) {
    if (
      typeof file === "string" ||
      !["image/jpeg", "image/png"].includes(file.type) ||
      file.size > MAX_IMAGE_BYTES
    )
      throw new DomainError(
        "PHOTO_INVALID",
        "JPEG/PNGの写真を1枚1.5MB以内で送信してください",
        422,
      );
    const buffer = await file.arrayBuffer();
    const dimensions = imageDimensions(buffer, file.type);
    if (
      !dimensions ||
      dimensions.some((n) => n < 1 || n > 3072) ||
      dimensions[0] * dimensions[1] > 6000000
    )
      throw new DomainError(
        "PHOTO_INVALID",
        "有効なJPEG/PNG（長辺3072px以内）が必要です",
        422,
      );
    const hash = await digest(buffer);
    if (!images.some((i) => i.hash === hash))
      images.push({
        mime: file.type as PhotoImage["mime"],
        bytes: buffer,
        hash,
      });
  }
  return {
    key,
    images,
    payloadHash: await digest(JSON.stringify(images.map((i) => i.hash).sort())),
  };
}
