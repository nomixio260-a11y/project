import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";
import { transcodeVideo } from "../src/pipeline/videoTranscoder.js";

let mp4Fixture: Buffer | null = null;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

beforeAll(() => {
  if (!hasFfmpeg) return;
  // testsrcから2秒の小さなMP4を生成してフィクスチャにする
  const out = path.join(tmpdir(), `dsp-fixture-${Date.now()}.mp4`);
  const r = spawnSync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=320x240:rate=15",
    "-pix_fmt",
    "yuv420p",
    out,
  ]);
  if (r.status === 0 && fs.existsSync(out)) {
    mp4Fixture = fs.readFileSync(out);
    fs.unlinkSync(out);
  }
});

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe.skipIf(!hasFfmpeg)("transcodeVideo", () => {
  it("transcodes to VP9/WebM and produces output", async () => {
    expect(mp4Fixture).toBeTruthy();
    const { stream, contentType } = await transcodeVideo(mp4Fixture!, "vp9");
    expect(contentType).toBe("video/webm");
    const out = await collect(stream);
    expect(out.length).toBeGreaterThan(0);
    // WebMのEBMLマジックバイト (0x1A45DFA3)
    expect(out.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  }, 60000);

  it("transcodes to H.264/MP4", async () => {
    const { stream, contentType } = await transcodeVideo(mp4Fixture!, "h264");
    expect(contentType).toBe("video/mp4");
    const out = await collect(stream);
    expect(out.length).toBeGreaterThan(0);
  }, 60000);
});
