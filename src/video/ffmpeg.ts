import { spawn } from 'node:child_process';
import { FFmpegError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

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
      if (code === 0) {
        resolve();
      } else {
        reject(new FFmpegError(`FFmpeg exited with code ${code}:\n${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new FFmpegError(`FFmpeg not found or failed to spawn: ${err.message}`));
    });
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
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(parseFloat(stdout.trim()));
      } else {
        reject(new FFmpegError('Failed to get video duration'));
      }
    });

    proc.on('error', (err) => {
      reject(new FFmpegError(`ffprobe not found: ${err.message}`));
    });
  });
}
