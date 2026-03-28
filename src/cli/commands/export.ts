import { Command } from 'commander';
import { resolve } from 'node:path';
import { presetOption, noZoomOption, noHighlightOption, noCursorOption, backgroundOption, noBackgroundOption, paddingOption, cornerRadiusOption, noShadowOption } from '../options.js';
import * as output from '../output.js';
import { readMetadata } from '../../recording/metadata.js';
import { metadataPath, exportsDir, composedVideoPath } from '../../utils/paths.js';
import { readFileSync, existsSync } from 'node:fs';
import { runExport } from '../../export/exporter.js';
import { capture } from '../../utils/telemetry.js';
import type { RecordingEvent } from '../../recording/types.js';

export const exportCommand = new Command('export')
  .description('Export a recording with platform-specific presets')
  .argument('<recording-dir>', 'Path to recording directory')
  .addOption(presetOption)
  .addOption(noZoomOption)
  .addOption(noHighlightOption)
  .addOption(noCursorOption)
  .addOption(backgroundOption)
  .addOption(noBackgroundOption)
  .addOption(paddingOption)
  .addOption(cornerRadiusOption)
  .addOption(noShadowOption)
  .option('-o, --output <path>', 'Output file path')
  .action(async (recordingDirPath: string, opts: Record<string, any>) => {
    const recDir = resolve(recordingDirPath);
    const metaPath = metadataPath(recDir);

    if (!existsSync(metaPath)) {
      output.error(`No metadata.json found in ${recDir}`);
      process.exit(1);
    }

    const metadata = readMetadata(metaPath);
    output.header('screencli export');
    output.info(`Recording: ${metadata.id}`);
    output.info(`Preset: ${opts.preset}`);

    // Load events
    const events: RecordingEvent[] = JSON.parse(readFileSync(metadata.event_log_path, 'utf-8'));

    // Determine source video
    const sourceVideo = existsSync(composedVideoPath(recDir))
      ? composedVideoPath(recDir)
      : metadata.raw_video_path;

    if (!existsSync(sourceVideo)) {
      output.error(`No video file found in ${recDir}`);
      process.exit(1);
    }

    const outDir = exportsDir(recDir);
    const spinner = output.createSpinner(`Exporting ${opts.preset}...`);
    spinner.start();

    try {
      const bg = (opts.noBackground || opts.background === 'none') ? undefined : opts.background;
      const background = bg
        ? {
            gradient: bg,
            padding: parseInt(opts.padding, 10),
            cornerRadius: parseInt(opts.cornerRadius, 10),
            shadow: opts.shadow !== false,
          }
        : undefined;

      const outputPath = await runExport({
        sourceVideo,
        events,
        metadata,
        presetName: opts.preset,
        outputDir: outDir,
        outputPath: opts.output,
        zoom: opts.zoom !== false,
        highlight: opts.highlight !== false,
        cursor: opts.cursor !== false,
        background,
      });
      spinner.succeed(`Exported: ${outputPath}`);
      capture('video_exported', {
        recording_id: metadata.id,
        preset: opts.preset,
        source: 'cli_export',
      });
    } catch (err) {
      spinner.fail(`Export failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    console.log('');
  });
