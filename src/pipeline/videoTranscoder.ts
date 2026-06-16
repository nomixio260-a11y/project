/**
 * fluent-ffmpeg による動画の高効率コーデック（AV1/VP9/H.264）再エンコード。
 *
 * 方針: 低ビットレート化による「劣化」ではなく、高効率コーデックで
 * 「同じ見た目をより少ないデータで」送り、ブラウザがネイティブにデコードして
 * 元画質に近い再生を行う。出力はストリームとしてそのままレスポンスへパイプし、
 * 全変換完了を待たずに再生を開始できるようにする。
 *
 * 入力は一旦一時ファイルに書き出す（MP4はmoovアトムが末尾にあることが多く、
 * 非シーク可能なstdinパイプでは変換に失敗するため）。
 * 同時変換数はセマフォで制限し、CPU枯渇を防ぐ。
 */
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { config } from "../config.js";
import type { VideoCodec } from "../types.js";

export interface TranscodeResult {
  stream: NodeJS.ReadableStream;
  contentType: string;
}

interface CodecProfile {
  videoCodec: string;
  audioCodec: string;
  contentType: string;
  format: string;
  outputOptions: string[];
}

/**
 * コーデック別のエンコード設定。CRFは「視覚的にほぼ同等」を狙う値。解像度は維持。
 * - AV1: SVT-AV1（高速・高圧縮）、WebMで配信
 * - VP9: libvpx-vp9、WebMで配信（対応ブラウザが広い）
 * - H.264: libx264、fragmented mp4（ストリーミング配信可能）
 */
function codecProfile(codec: VideoCodec): CodecProfile {
  switch (codec) {
    case "av1":
      return {
        videoCodec: "libsvtav1",
        audioCodec: "libopus",
        contentType: "video/webm",
        format: "webm",
        outputOptions: ["-crf", "35", "-preset", "8", "-b:v", "0", "-g", "240", "-pix_fmt", "yuv420p"],
      };
    case "vp9":
      return {
        videoCodec: "libvpx-vp9",
        audioCodec: "libopus",
        contentType: "video/webm",
        format: "webm",
        outputOptions: ["-crf", "33", "-b:v", "0", "-deadline", "realtime", "-cpu-used", "5", "-row-mt", "1"],
      };
    case "h264":
    default:
      return {
        videoCodec: "libx264",
        audioCodec: "aac",
        contentType: "video/mp4",
        format: "mp4",
        outputOptions: [
          "-crf",
          "28",
          "-preset",
          "veryfast",
          "-movflags",
          "frag_keyframe+empty_moov+default_base_moof",
          "-pix_fmt",
          "yuv420p",
        ],
      };
  }
}

// --- 同時実行数を制限する簡易セマフォ ---
let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (active < config.maxConcurrentTranscodes) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function releaseSlot(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * 入力動画バッファを指定コーデックへ再エンコードし、ストリームを返す。
 * ストリームは即座に返り、変換はバックグラウンドで進行する。
 */
export async function transcodeVideo(
  input: Buffer,
  codec: VideoCodec,
): Promise<TranscodeResult> {
  await acquireSlot();

  const profile = codecProfile(codec);
  const output = new PassThrough();
  const tmpFile = path.join(tmpdir(), `dsp-in-${randomUUID()}`);

  let released = false;
  const cleanup = async () => {
    if (released) return;
    released = true;
    releaseSlot();
    try {
      await fs.unlink(tmpFile);
    } catch {
      // 既に消えていれば無視
    }
  };

  try {
    await fs.writeFile(tmpFile, input);
  } catch (err) {
    await cleanup();
    throw err;
  }

  const command = ffmpeg(tmpFile)
    .videoCodec(profile.videoCodec)
    .audioCodec(profile.audioCodec)
    .outputOptions(profile.outputOptions)
    .format(profile.format)
    .on("error", (err: Error) => {
      output.destroy(err);
      void cleanup();
    })
    .on("end", () => {
      void cleanup();
    });

  command.pipe(output, { end: true });

  return { stream: output, contentType: profile.contentType };
}
