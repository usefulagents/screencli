import { spawn, type ChildProcess } from 'node:child_process';
import { FFmpegError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// A spawned ffmpeg/ffprobe that wedges (malformed input, a stalled filter, a
// not-cleanly-finalized raw video) would otherwise hang the CLI forever — the
// process never emits `close`, so the promise never settles, and the recording
// strands in `uploading` with no verdict. These timeouts kill the process so
// the promise rejects and the caller's try/catch + /confirm fallback can run.
// Override via env for ops tuning.
const FFMPEG_TIMEOUT_MS = Number(process.env['SCREENCLI_FFMPEG_TIMEOUT_MS']) || 120_000;
const FFPROBE_TIMEOUT_MS = Number(process.env['SCREENCLI_FFPROBE_TIMEOUT_MS']) || 30_000;

/**
 * Arm a watchdog that SIGKILLs a stuck process and rejects. Returns a function
 * to disarm it — call from both the `close` and `error` handlers.
 */
function armKillTimer(
  proc: ChildProcess,
  label: string,
  ms: number,
  reject: (err: Error) => void,
): () => void {
  const timer = setTimeout(() => {
    logger.error(`${label} exceeded ${ms}ms — killing process.`);
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    reject(new FFmpegError(`${label} timed out after ${ms}ms`));
  }, ms);
  return () => clearTimeout(timer);
}

export interface FFmpegOptions {
  input: string;
  /** Additional inputs (e.g. background image). */
  extraInputs?: string[];
  output: string;
  filterComplex?: string;
  outputArgs?: string[];
  onProgress?: (percent: number) => void;
}

export async function runFFmpeg(options: FFmpegOptions): Promise<void> {
  const args: string[] = [
    '-y',
    '-i', options.input,
  ];

  if (options.extraInputs) {
    for (const extra of options.extraInputs) {
      args.push('-i', extra);
    }
  }

  if (options.filterComplex) {
    args.push('-filter_complex', options.filterComplex);
  }

  if (options.outputArgs) {
    args.push(...options.outputArgs);
  }

  args.push(options.output);

  logger.debug(`ffmpeg ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const disarm = armKillTimer(proc, 'FFmpeg', FFMPEG_TIMEOUT_MS, reject);

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;

      // Parse progress from ffmpeg output
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (timeMatch && options.onProgress) {
        const seconds =
          parseInt(timeMatch[1]!) * 3600 +
          parseInt(timeMatch[2]!) * 60 +
          parseInt(timeMatch[3]!) +
          parseInt(timeMatch[4]!) / 100;
        options.onProgress(seconds);
      }
    });

    proc.on('close', (code) => {
      disarm();
      if (code === 0) {
        resolve();
      } else {
        reject(new FFmpegError(`FFmpeg exited with code ${code}:\n${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      disarm();
      reject(new FFmpegError(`FFmpeg not found or failed to spawn: ${err.message}`));
    });
  });
}

/**
 * Run ffmpeg with raw args. Useful for invocations that don't fit the
 * single-input shape (e.g. `lavfi` sources, multi-pass mask generation).
 */
export async function runFFmpegRaw(args: string[]): Promise<void> {
  logger.debug(`ffmpeg ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const disarm = armKillTimer(proc, 'FFmpeg', FFMPEG_TIMEOUT_MS, reject);
    proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      disarm();
      if (code === 0) resolve();
      else reject(new FFmpegError(`FFmpeg exited with code ${code}:\n${stderr.slice(-500)}`));
    });
    proc.on('error', (err) => { disarm(); reject(new FFmpegError(`FFmpeg not found or failed to spawn: ${err.message}`)); });
  });
}

export async function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);

    let stdout = '';
    const disarm = armKillTimer(proc, 'ffprobe', FFPROBE_TIMEOUT_MS, reject);
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      disarm();
      if (code === 0) {
        resolve(parseFloat(stdout.trim()));
      } else {
        reject(new FFmpegError('Failed to get video duration'));
      }
    });

    proc.on('error', (err) => {
      disarm();
      reject(new FFmpegError(`ffprobe not found: ${err.message}`));
    });
  });
}
