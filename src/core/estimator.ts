import fs from "node:fs/promises";

export const EXACT_COUNT_THRESHOLD = 1 * 1024 * 1024;
export const SAMPLE_SIZE = 8192;

export function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

export async function estimatePatchSize(
  filePath: string,
  fileSize: number,
  readLimit: number,
): Promise<number> {
  if (fileSize < EXACT_COUNT_THRESHOLD) {
    const text =
      typeof Bun !== "undefined" && Bun?.file
        ? await Bun.file(filePath).text()
        : await fs.readFile(filePath, "utf8");
    const totalLines = countNewlines(text) || 1;
    const patchRatio = Math.min(1, readLimit / totalLines);
    return Math.round(patchRatio * fileSize);
  }

  let sample = "";
  if (typeof Bun !== "undefined" && Bun?.file) {
    sample = await Bun.file(filePath).slice(0, SAMPLE_SIZE).text();
  } else {
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(SAMPLE_SIZE);
      const { bytesRead } = await handle.read(buffer, 0, SAMPLE_SIZE, 0);
      sample = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  const sampleNewlines = countNewlines(sample);

  if (sampleNewlines === 0) {
    return fileSize;
  }

  const avgBytesPerLine = SAMPLE_SIZE / sampleNewlines;
  const estimatedTotalLines = fileSize / avgBytesPerLine;
  const patchRatio = Math.min(1, readLimit / estimatedTotalLines);
  return Math.round(patchRatio * fileSize);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function extractOutputText(output: unknown): string {
  return extractOutputTextInner(output, new WeakSet<object>());
}

function extractOutputTextInner(output: unknown, seen: WeakSet<object>): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return extractFromString(output, seen);
  if (typeof output === "number" || typeof output === "boolean") return String(output);
  if (output instanceof Error) return output.message;
  if (typeof output === "object") {
    if (seen.has(output)) return "";
    seen.add(output);
    try {
      if (Array.isArray(output)) {
        return output
          .map((item) => extractOutputTextInner(item, seen))
          .filter((text) => text.length > 0)
          .join("\n");
      }
      const record = output as Record<string, unknown>;
      if (record.output !== undefined) {
        return typeof record.output === "string"
          ? record.output
          : extractOutputTextInner(record.output, seen);
      }
      return safeStringify(output);
    } finally {
      seen.delete(output);
    }
  }
  return String(output);
}

export function estimateToolOutputTokens(output: unknown): number {
  return estimateTokens(extractOutputText(output));
}

export function estimateArgsTokens(args: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (serialized === undefined || serialized === "{}") return 0;
  return estimateTokens(serialized);
}

function extractFromString(text: string, seen: WeakSet<object>): string {
  if (text.length === 0) return "";
  const first = text[0];
  if (first !== "{" && first !== "[" && first !== '"') return text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
    if (parsed === null || typeof parsed !== "object") return text;
    return extractOutputTextInner(parsed, seen);
  } catch {
    return text;
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, current) => {
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) return "[Circular]";
          seen.add(current);
        }
        return current;
      }) ?? ""
    );
  } catch {
    return String(value);
  }
}
