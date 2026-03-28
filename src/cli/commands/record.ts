import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { v4 as uuidv4 } from 'uuid';
import { resolve } from 'node:path';
import {
  promptOption,
  outputOption,
  viewportOption,
  modelOption,
  headlessOption,
  slowMoOption,
  maxStepsOption,
  loginOption,
  authOption,
  backgroundOption,
  noBackgroundOption,
  paddingOption,
  cornerRadiusOption,
  noShadowOption,
  localOption,
  unlistedOption,
  parseViewport,
} from '../options.js';
import * as output from '../output.js';
import { loadConfig, isConfigured } from '../../utils/config.js';
import { runInit } from './init.js';
import { recordingDir, eventsPath, metadataPath } from '../../utils/paths.js';
import { launchSession } from '../../browser/session.js';
import { runLoginFlow, loadAuthState, saveAuthState, hasAuthState } from '../../browser/auth.js';
import { EventLog } from '../../recording/event-log.js';
import { writeMetadata } from '../../recording/metadata.js';
import { deriveChapters } from '../../recording/chapters.js';
import { runAgentLoop } from '../../agent/loop.js';
import { composeVideo, generateThumbnail } from '../../video/compose.js';
import type { BackgroundOptions } from '../../video/background.js';
import { logger, setLogLevel } from '../../utils/logger.js';
import { isLoggedIn, apiRequest, validateToken, saveCloudConfig, loadCloudConfig } from '../../cloud/client.js';
import { uploadRecording } from '../../cloud/upload.js';
import { BACKGROUND_PRESETS, randomPreset } from '../../video/background.js';

const BACKGROUND_CHOICES = BACKGROUND_PRESETS;

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const recordCommand = new Command('record')
  .description('Record an AI-driven browser demo')
  .argument('[url]', 'Starting URL')
  .addOption(promptOption)
  .addOption(outputOption)
  .addOption(viewportOption)
  .addOption(modelOption)
  .addOption(headlessOption)
  .addOption(slowMoOption)
  .addOption(maxStepsOption)
  .addOption(loginOption)
  .addOption(authOption)
  .addOption(backgroundOption)
  .addOption(noBackgroundOption)
  .addOption(paddingOption)
  .addOption(cornerRadiusOption)
  .addOption(noShadowOption)
  .addOption(localOption)
  .addOption(unlistedOption)
  .option('-v, --verbose', 'Verbose logging')
  .action(async (urlArg: string | undefined, opts: Record<string, any>) => {
    if (opts.verbose) setLogLevel('debug');

    // Auto-run init on first use
    if (!isConfigured()) {
      output.info('First time? Let\u2019s get you set up.\n');
      const ok = await runInit();
      if (!ok) {
        output.error('Setup incomplete. Run `screencli init` to try again.');
        process.exit(1);
      }
    }

    // ── Interactive prompts for missing params ──
    let url = urlArg ?? '';
    if (!url) {
      url = await ask('  URL to record: ');
      if (!url) {
        output.error('URL is required.');
        process.exit(1);
      }
    }

    if (!opts.prompt) {
      opts.prompt = await ask('  What should the agent do? ');
      if (!opts.prompt) {
        output.error('Prompt is required.');
        process.exit(1);
      }
    }

    // Resolve background: --no-background or --background none disables it
    // Otherwise pick a random preset if not specified
    if (opts.noBackground || opts.background === 'none') {
      opts.background = undefined;
    } else if (!opts.background) {
      opts.background = randomPreset();
    }

    // Validate cloud token early, before any expensive work
    if (isLoggedIn() && !process.env['ANTHROPIC_API_KEY']) {
      const validated = await validateToken();
      if (!validated) {
        output.error('Not authenticated. Please run: npx screencli login');
        process.exit(1);
      }
    }

    const config = loadConfig();
    const viewport = parseViewport(opts.viewport);
    const id = uuidv4();
    const recDir = recordingDir(resolve(opts.output), id);
    const startTime = Date.now();

    // ── TUI or fallback ──
    const isTTY = Boolean(process.stdout.isTTY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let bus: any;
    let tuiExit: Promise<void> | undefined;

    if (isTTY) {
      try {
        // Dynamic import so Ink/React are only loaded in TTY mode
        const tuiPath = '../../tui/index.js';
        const tui = await import(/* webpackIgnore: true */ tuiPath);
        bus = new tui.RecordingEventBus();
        const instance = tui.runRecordingTUI({ bus, url, prompt: opts.prompt, id, startTime });
        tuiExit = instance.waitUntilExit();
      } catch {
        // Ink not available — fall back to simple output
      }
    }

    if (!bus) {
      output.header('screencli record');
      output.info(`Recording ID: ${id}`);
      output.info(`URL: ${url}`);
      output.info(`Prompt: ${opts.prompt}`);
      output.info(`Viewport: ${viewport.width}x${viewport.height}`);
      output.info(`Model: ${opts.model}`);
      output.info(`Output: ${recDir}`);
      console.log('');
    }

    // ── Auth: login handoff or saved state ──
    let storageState: object | undefined;

    const needsLogin = opts.login || (opts.auth && !hasAuthState(opts.auth));
    if (needsLogin) {
      output.info('Opening browser for manual login...');
      output.info('Log in, then press Enter here to hand off to the AI agent.');
      console.log('');
      storageState = await runLoginFlow(url, viewport) as object;
      if (opts.auth) {
        saveAuthState(opts.auth, storageState);
        output.success(`Auth state saved as "${opts.auth}"`);
      }
      output.success('Login complete — starting recording.');
      console.log('');
    } else if (opts.auth) {
      const loaded = loadAuthState(opts.auth);
      if (loaded) {
        storageState = loaded;
        if (!bus) output.success(`Loaded saved auth: "${opts.auth}"`);
      }
    }

    // Launch browser (recording starts here — login is excluded)
    bus?.emitPhase('launching', 'Launching browser...');
    let spinner: ReturnType<typeof output.createSpinner> | undefined;
    if (!bus) {
      spinner = output.createSpinner('Launching browser...');
      spinner.start();
    }
    const session = await launchSession({
      viewport,
      headless: opts.headless !== false,
      slowMo: parseInt(opts.slowMo, 10),
      recordDir: recDir,
      storageState,
    });
    if (!bus) spinner?.succeed('Browser launched');

    // Run agent loop
    const eventLog = new EventLog(eventsPath(recDir));

    bus?.emitPhase('recording');
    if (!bus) {
      console.log('');
      output.header('Agent Actions');
    }

    let result;
    try {
      result = await runAgentLoop({
        apiKey: config.anthropicApiKey,
        model: opts.model,
        recording_id: id,
        url,
        prompt: opts.prompt,
        page: session.page,
        eventLog,
        recordingDir: recDir,
        actionDelayMs: config.actionDelayMs,
        maxSteps: parseInt(opts.maxSteps, 10),
        onAction: (step, toolName, description) => {
          if (bus) {
            bus.emitAction({ step, toolName, description, timestamp: Date.now() });
          } else {
            output.actionLog(step, toolName, description);
          }
        },
      });
    } catch (err) {
      if (bus) {
        bus.emitError(`Agent error: ${err}`);
        if (tuiExit) await tuiExit;
      } else {
        output.error(`Agent error: ${err}`);
      }
      eventLog.flush();
      await session.close();
      process.exit(1);
    }

    // Close browser to finalize video
    bus?.emitPhase('composing', 'Finalizing video...');
    let closeSpinner: ReturnType<typeof output.createSpinner> | undefined;
    if (!bus) {
      console.log('');
      closeSpinner = output.createSpinner('Finalizing video...');
      closeSpinner.start();
    }
    const rawVideoPath = await session.close();
    if (!bus) closeSpinner?.succeed('Video finalized');

    // Flush event log
    eventLog.flush();

    // Write metadata
    const events = eventLog.getEvents();
    const chapters = deriveChapters(events);
    writeMetadata(metadataPath(recDir), {
      id,
      created_at: new Date().toISOString(),
      url,
      prompt: opts.prompt,
      model: opts.model,
      viewport,
      duration_ms: eventLog.getDurationMs(),
      raw_video_path: rawVideoPath ?? '',
      event_log_path: eventsPath(recDir),
      chapters,
      agent_stats: result.stats,
    });

    // Post-process video
    if (rawVideoPath) {
      bus?.emitPhase('composing', 'Composing video with effects...');
      let composeSpinner: ReturnType<typeof output.createSpinner> | undefined;
      if (!bus) {
        console.log('');
        composeSpinner = output.createSpinner('Composing video with effects...');
        composeSpinner.start();
      }
      try {
        const background: BackgroundOptions | undefined = opts.background
          ? {
              gradient: opts.background,
              padding: parseInt(opts.padding, 10),
              cornerRadius: parseInt(opts.cornerRadius, 10),
              shadow: opts.shadow !== false,
            }
          : undefined;

        await composeVideo({
          rawVideoPath,
          events,
          outputPath: resolve(recDir, 'composed.mp4'),
          viewport,
          zoom: true,
          highlight: false,
          cursor: true,
          background,
        });
        if (!bus) composeSpinner?.succeed('Video composed');

        // Generate thumbnail from composed video
        try {
          await generateThumbnail(
            resolve(recDir, 'composed.mp4'),
            resolve(recDir, 'thumbnail.jpg'),
          );
        } catch {
          // Non-fatal — upload proceeds without thumbnail
        }
      } catch (err) {
        if (!bus) composeSpinner?.warn(`Video composition skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Cloud upload
    let shareUrl: string | undefined;
    let creditsUsed: number | undefined;
    let creditsRemaining: number | undefined;
    if (!opts.local && isLoggedIn()) {
      bus?.emitPhase('uploading', 'Uploading to cloud...');
      let uploadSpinner: ReturnType<typeof output.createSpinner> | undefined;
      if (!bus) {
        console.log('');
        uploadSpinner = output.createSpinner('Uploading to cloud...');
        uploadSpinner.start();
      }
      try {
        const uploadResult = await uploadRecording(recDir, {
          id,
          url,
          prompt: opts.prompt,
          model: opts.model,
          viewport_w: viewport.width,
          viewport_h: viewport.height,
          duration_ms: eventLog.getDurationMs(),
          tokens_input: result.stats.input_tokens,
          tokens_output: result.stats.output_tokens,
          visibility: opts.unlisted ? 'unlisted' : 'public',
        });
        shareUrl = uploadResult.url;
        if (!bus) uploadSpinner?.succeed(`Uploaded: ${shareUrl}`);

        // Get credits remaining
        try {
          const meRes = await apiRequest('/api/me');
          if (meRes.ok) {
            const me = await meRes.json() as { credits?: number };
            if (me.credits !== undefined) {
              const steps = result.stats.total_actions;
              creditsUsed = Math.ceil(steps / 10);
              creditsRemaining = me.credits;
              if (!bus) {
                output.info(`${creditsUsed} credit${creditsUsed !== 1 ? 's' : ''} used (${steps} steps) \u00b7 ${creditsRemaining} remaining`);
              }
            }
          }
        } catch { /* ignore */ }
      } catch (err) {
        if (!bus) uploadSpinner?.warn(`Cloud upload skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── Done ──
    if (bus) {
      bus.emitDone({
        summary: result.summary,
        stats: result.stats,
        shareUrl,
        recDir,
        durationMs: eventLog.getDurationMs(),
        chapterCount: chapters.length,
        creditsUsed,
        creditsRemaining,
      });
      if (tuiExit) await tuiExit;
    } else {
      console.log('');
      output.header('Recording Complete');
      output.stats('Summary', result.summary);
      output.stats('Actions', result.stats.total_actions);
      output.stats('Tokens (in/out)', `${result.stats.input_tokens} / ${result.stats.output_tokens}`);
      output.stats('Duration', `${(eventLog.getDurationMs() / 1000).toFixed(1)}s`);
      output.stats('Chapters', chapters.length);
      output.stats('Output', recDir);
      if (shareUrl) {
        output.stats('Share URL', shareUrl);
      }
      console.log('');
      process.exit(0);
    }
  });
