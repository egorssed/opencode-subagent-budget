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
