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
  jsonOption,
  ciOption,
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
import { isLoggedIn, apiRequest, validateToken, saveCloudConfig } from '../../cloud/client.js';
import { uploadRecording } from '../../cloud/upload.js';
import { BACKGROUND_PRESETS, randomPreset } from '../../video/background.js';
import { capture, shutdown as telemetryShutdown } from '../../utils/telemetry.js';

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

/**
 * The single JSON object CI parses. Emitted on stdout in --json mode.
 * Kept stable on purpose — the GitHub Action and any other CI plumbing depend
 * on these field names. Add new fields, don't rename existing ones.
 */
export interface FinalResult {
  verdict: 'pass' | 'fail' | 'inconclusive';
  reason?: string;
  share_url?: string;
  recording_id?: string;
  step_count?: number;
  duration_ms?: number;
  tokens_input?: number;
  tokens_output?: number;
  summary?: string;
}

/** In --json mode, print one JSON object to stdout. Otherwise print human lines. */
function emitFinalResult(jsonMode: boolean, result: FinalResult): void {
  if (jsonMode) {
    // Single line JSON so CI tools can `tail -1 | jq` reliably even if logs
    // came out interleaved with this. (FFmpeg etc. write to stderr already.)
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  output.header('Result');
  output.stats('Verdict', result.verdict.toUpperCase());
  if (result.reason) output.stats('Reason', result.reason);
  if (result.share_url) output.stats('Share URL', result.share_url);
  if (result.recording_id) output.stats('Recording ID', result.recording_id);
  if (result.step_count !== undefined) output.stats('Steps', result.step_count);
  if (result.duration_ms !== undefined) output.stats('Duration', `${(result.duration_ms / 1000).toFixed(1)}s`);
}

/** Map verdict to exit code. pass/done=0, fail=1, inconclusive=2, infra error=3. */
function verdictExitCode(verdict: 'pass' | 'fail' | 'inconclusive' | undefined): number {
  if (verdict === 'fail') return 1;
  if (verdict === 'inconclusive') return 2;
  return 0; // pass or no verdict (recording mode)
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
  .addOption(jsonOption)
  .addOption(ciOption)
  .option('-v, --verbose', 'Verbose logging')
  .action(async (urlArg: string | undefined, opts: Record<string, any>) => {
    if (opts.verbose) setLogLevel('debug');

    // CI mode: triggered by --ci, --json, or CI=true env (so it Just Works in GitHub Actions).
    // Implications: no interactive stdin prompts, no init wizard, no TUI/spinners. Plain logs.
    const ciMode = Boolean(opts.ci || opts.json || process.env['CI']);
    const jsonMode = Boolean(opts.json);

    // SCREENCLI_TOKEN env var is the CI-friendly equivalent of `screencli login`.
    // When set, save it as the cloud token before any cloud calls go out.
    const envToken = process.env['SCREENCLI_TOKEN'];
    if (envToken) {
      try {
        saveCloudConfig({ token: envToken });
      } catch { /* non-fatal \u2014 falls back to file-based auth */ }
    }

    // Auto-run init on first use \u2014 but skip in CI mode (no TTY to walk a wizard)
    if (!isConfigured() && !ciMode) {
      capture('cli_installed');
      output.info('First time? Let\u2019s get you set up.\n');
      const ok = await runInit();
      if (!ok) {
        output.error('Setup incomplete. Run `screencli init` to try again.');
        process.exit(1);
      }
    } else if (!isConfigured() && ciMode && !envToken && !process.env['ANTHROPIC_API_KEY']) {
      emitFinalResult(jsonMode, {
        verdict: 'inconclusive',
        reason: 'No SCREENCLI_TOKEN or ANTHROPIC_API_KEY set. CI runs need one of these.',
      });
      process.exit(3);
    }

    // ── Interactive prompts for missing params ──
    let url = urlArg ?? '';
    if (!url) {
      if (ciMode) {
        emitFinalResult(jsonMode, { verdict: 'inconclusive', reason: 'URL is required in CI mode.' });
        process.exit(3);
      }
      url = await ask('  URL to record: ');
      if (!url) {
        output.error('URL is required.');
        process.exit(1);
      }
    }

    if (!opts.prompt) {
      if (ciMode) {
        emitFinalResult(jsonMode, { verdict: 'inconclusive', reason: 'Prompt (-p) is required in CI mode.' });
        process.exit(3);
      }
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
    // SCREENCLI_RECORDING_ID is set by the cloud Sandbox dispatcher so the
    // pre-created recording row in D1 lines up with the upload at the end.
    const id = process.env['SCREENCLI_RECORDING_ID'] ?? uuidv4();
    const recDir = recordingDir(resolve(opts.output), id);
    const startTime = Date.now();

    // ── TUI or fallback ──
    // CI mode forces plain output regardless of TTY (Actions terminals report TTY but the TUI is wrong for logs)
    const isTTY = Boolean(process.stdout.isTTY) && !ciMode;
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

    capture('recording_started', {
      url,
      model: opts.model,
      headless: opts.headless !== false,
      viewport: `${viewport.width}x${viewport.height}`,
    });

    // Run agent loop
    const eventLog = new EventLog(eventsPath(recDir));

    bus?.emitPhase('recording');
    if (!bus) {
      console.log('');
      output.header('Agent Actions');
    }

    // Orchestrator-driven runs need a verdict in the PR comment. When the
    // dispatcher sets SCREENCLI_EXPECT_RUN_ID, force the agent into verdict
    // mode — `done` is removed from the toolset so it must call pass/fail.
    const requireVerdict = !!process.env['SCREENCLI_EXPECT_RUN_ID'];

    // SCREENCLI_AUTH_INSTRUCTIONS is set by the orchestrator when the repo
    // has authInstructions configured. The credentials are already
    // substituted server-side; this is the resolved string the agent
    // performs before the main task.
    const authInstructions = process.env['SCREENCLI_AUTH_INSTRUCTIONS']?.trim() || undefined;

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
        requireVerdict,
        authInstructions,
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
    // A hung/failed finalize must not abort the run — without a verdict the
    // recording strands in `uploading`. Swallow the error so the upload +
    // /confirm fallback below still fires; we just lose the composed video.
    let rawVideoPath: string | undefined;
    try {
      rawVideoPath = await session.close();
      if (!bus) closeSpinner?.succeed('Video finalized');
    } catch (err) {
      if (!bus) closeSpinner?.warn(`Video finalize failed: ${err instanceof Error ? err.message : err}`);
      logger.warn(`session.close() failed — proceeding to upload without composed video: ${err}`);
    }

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
          // ── CI context (all optional, set by the GitHub Action / webhook dispatcher) ──
          // Pass through whatever the agent loop returned. Plain `done` (no
          // verdict) still means a successful recording-mode run → pass.
          // maxSteps fallthrough is now `inconclusive` (set inside loop.ts),
          // so that propagates honestly here.
          verdict: result.verdict ?? 'pass',
          reason: result.reason ?? result.summary,
          name: process.env['SCREENCLI_TEST_NAME'],
          expect_run_id: process.env['SCREENCLI_EXPECT_RUN_ID'],
          pr_number: process.env['SCREENCLI_PR_NUMBER'] ? Number(process.env['SCREENCLI_PR_NUMBER']) : undefined,
          commit_sha: process.env['SCREENCLI_COMMIT_SHA'],
          repo_full_name: process.env['SCREENCLI_REPO'],
          installation_id: process.env['SCREENCLI_INSTALLATION_ID'] ? Number(process.env['SCREENCLI_INSTALLATION_ID']) : undefined,
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

        // Best-effort fallback: even if uploadRecording threw, try to flip
        // the recording row from `uploading` → `ready` (or carry the verdict)
        // via a direct /confirm POST. Without this, expect-run-driven
        // recordings strand the parent run in `running` forever because
        // recomputeAndMaybeFinalize only fires from /confirm.
        try {
          await apiRequest(`/api/recordings/${id}/confirm`, {
            method: 'POST',
            body: JSON.stringify({
              duration_ms: eventLog.getDurationMs(),
              tokens_input: result.stats.input_tokens,
              tokens_output: result.stats.output_tokens,
              verdict: result.verdict ?? 'inconclusive',
              reason: result.reason ?? `Upload failed after agent completed: ${err instanceof Error ? err.message : String(err)}`,
              name: process.env['SCREENCLI_TEST_NAME'],
              expect_run_id: process.env['SCREENCLI_EXPECT_RUN_ID'],
              pr_number: process.env['SCREENCLI_PR_NUMBER'] ? Number(process.env['SCREENCLI_PR_NUMBER']) : undefined,
              commit_sha: process.env['SCREENCLI_COMMIT_SHA'],
              repo_full_name: process.env['SCREENCLI_REPO'],
              installation_id: process.env['SCREENCLI_INSTALLATION_ID'] ? Number(process.env['SCREENCLI_INSTALLATION_ID']) : undefined,
            }),
          });
        } catch { /* nothing more we can do from here */ }
      }
    }

    capture('recording_completed', {
      recording_id: id,
      url,
      duration_ms: eventLog.getDurationMs(),
      total_actions: result.stats.total_actions,
      tokens_input: result.stats.input_tokens,
      tokens_output: result.stats.output_tokens,
      uploaded: !!shareUrl,
    });

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
      return;
    }

    // Plain / CI mode: emit a final result. In --json mode this is a single
    // JSON line on stdout; otherwise it's a human-readable block. Either way
    // the exit code reflects the verdict (pass=0, fail=1, inconclusive=2, infra=3).
    const finalVerdict = result.verdict ?? 'pass'; // recording mode (done) = pass
    emitFinalResult(jsonMode, {
      verdict: finalVerdict,
      reason: result.reason ?? result.summary,
      share_url: shareUrl,
      recording_id: id,
      step_count: result.stats.total_actions,
      duration_ms: eventLog.getDurationMs(),
      tokens_input: result.stats.input_tokens,
      tokens_output: result.stats.output_tokens,
      summary: result.summary,
    });

    if (!jsonMode) {
      // Keep the human-friendly extras (chapters, output dir, credits) outside the
      // structured Result block above.
      console.log('');
      output.stats('Output', recDir);
      output.stats('Chapters', chapters.length);
      if (creditsRemaining !== undefined) {
        output.stats('Credits remaining', creditsRemaining);
      }
      console.log('');
    }

    await telemetryShutdown();
    process.exit(verdictExitCode(result.verdict));
  });
