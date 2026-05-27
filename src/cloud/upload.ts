import fs from "node:fs";
import path from "node:path";
import { apiRequest } from "./client.js";

interface UploadResult {
  id: string;
  url: string;
}

export async function uploadRecording(
  recordingDir: string,
  metadata: {
    id: string;
    url: string;
    prompt?: string;
    model?: string;
    viewport_w?: number;
    viewport_h?: number;
    duration_ms?: number;
    tokens_input?: number;
    tokens_output?: number;
    visibility?: string;
    // ── Optional verdict + CI context. Forwarded to /api/recordings server-side
    //    so the recording can be joined back to a PR / expect run.
    verdict?: 'pass' | 'fail' | 'inconclusive';
    reason?: string;
    name?: string;
    expect_run_id?: string;
    pr_number?: number;
    commit_sha?: string;
    repo_full_name?: string;
    installation_id?: number;
  }
): Promise<UploadResult> {
  // Create the recording entry on the server
  const createRes = await apiRequest("/api/recordings", {
    method: "POST",
    body: JSON.stringify(metadata),
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(`Failed to create recording: ${(err as { error: string }).error}`);
  }

  const { id, upload_urls } = await createRes.json() as { id: string; upload_urls: Record<string, string> };

  // Upload files
  const files: { type: string; localPath: string }[] = [
    { type: "video", localPath: path.join(recordingDir, "composed.mp4") },
    { type: "raw", localPath: path.join(recordingDir, "raw.webm") },
    { type: "events", localPath: path.join(recordingDir, "events.json") },
    { type: "thumbnail", localPath: path.join(recordingDir, "thumbnail.jpg") },
  ];

  // Upload files — defensive. Individual file failures (network blip,
  // missing local file, oversized body) must NOT prevent the confirm step
  // from running, because confirm is what:
  //   1. Flips the recording's status from `uploading` → `ready` in D1
  //   2. Carries the verdict to /api/recordings/:id/confirm
  //   3. Triggers `recomputeAndMaybeFinalize` on the parent expect_run
  // Stranding a recording in `uploading` blocks the entire expect_run from
  // finalizing — so we always reach confirm, with a best-effort body.
  let uploadFailures = 0;
  for (const file of files) {
    try {
      if (!fs.existsSync(file.localPath)) continue;
      const uploadPath = upload_urls[file.type];
      if (!uploadPath) continue;
      const data = fs.readFileSync(file.localPath);
      const uploadRes = await apiRequest(uploadPath, {
        method: "PUT",
        body: data,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!uploadRes.ok) {
        uploadFailures++;
        console.error(`  ⚠ Failed to upload ${file.type} (HTTP ${uploadRes.status})`);
      }
    } catch (err) {
      uploadFailures++;
      console.error(`  ⚠ Failed to upload ${file.type}:`, err instanceof Error ? err.message : err);
    }
  }

  // If we got here with NO files uploaded AND no verdict, downgrade to
  // inconclusive so the recording lands honestly rather than claiming success.
  let finalVerdict = metadata.verdict;
  let finalReason = metadata.reason;
  if (uploadFailures > 0 && finalVerdict === undefined) {
    finalVerdict = 'inconclusive';
    finalReason = `${uploadFailures} file upload(s) failed during recording finalization.`;
  }

  // Confirm — always fires, even when some/all file uploads failed.
  // The verdict + CI context land in D1 so the orchestrator can finalize.
  const confirmRes = await apiRequest(`/api/recordings/${id}/confirm`, {
    method: "POST",
    body: JSON.stringify({
      duration_ms: metadata.duration_ms,
      tokens_input: metadata.tokens_input,
      tokens_output: metadata.tokens_output,
      verdict: finalVerdict,
      reason: finalReason,
      name: metadata.name,
      expect_run_id: metadata.expect_run_id,
      pr_number: metadata.pr_number,
      commit_sha: metadata.commit_sha,
      repo_full_name: metadata.repo_full_name,
      installation_id: metadata.installation_id,
    }),
  });

  if (!confirmRes.ok) {
    throw new Error(`Failed to confirm upload: HTTP ${confirmRes.status}`);
  }

  const result = await confirmRes.json() as { url: string };
  return { id, url: result.url };
}
