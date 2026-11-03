/** Read only a small complete JSON error; a slow/large body cannot delay recovery. */
export const readErrorCode = async (response: Response): Promise<number | undefined> => {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collect = async () => {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_024) return undefined;
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!payload || typeof payload !== "object" || !("code" in payload)) return undefined;
      return typeof payload.code === "number" && Number.isSafeInteger(payload.code) ? payload.code : undefined;
    } catch { return undefined; }
  };
  try {
    return await Promise.race([
      collect(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000); })
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
};
