/**
 * Utility to strip and format server/model out-of-band streaming markers
 * so raw control tokens do not land in Obsidian .canvas node text.
 */

const CONTROL_MARKERS_RE = /⟦(?:SWITCH:[^⟧]*|NOTICE:[^⟧]*|TRUNCATED|THINKING)⟧/g;

const ASK_FULL_RE = /⟦ASK⟧([\s\S]*?)⟦\/ASK⟧/g;
const ASK_OPEN_RE = /⟦ASK⟧([\s\S]*)$/;

const ARTIFACT_OPEN_RE = /⟦ARTIFACT(?::([^⟧]*))?⟧[ \t]*\r?\n?/g;
const ARTIFACT_CLOSE = "⟦/ARTIFACT⟧";

/**
 * Extracts the main question from an ASK payload (stripping options delimited by ||).
 */
function cleanAskContent(raw: string): string {
  const parts = raw.split("||");
  return parts[0]?.trim() ?? "";
}

/**
 * Strips server streaming control markers (⟦SWITCH:...⟧, ⟦NOTICE:...⟧, ⟦TRUNCATED⟧, ⟦THINKING⟧),
 * collapses ⟦ASK⟧ tags to just their question text, and cleans up ⟦ARTIFACT⟧ headers/closers.
 */
export function stripServerMarkers(text: string): string {
  if (!text) return "";

  // 1. Remove control markers
  let cleaned = text.replace(CONTROL_MARKERS_RE, "");

  // 2. Process closed ⟦ASK⟧...⟦/ASK⟧ tags
  cleaned = cleaned.replace(ASK_FULL_RE, (_, body: string) => {
    const q = cleanAskContent(body);
    return q ? `\n\n${q}` : "";
  });

  // 3. Process unclosed ⟦ASK⟧... tag (e.g. partial stream or missing closer)
  const askOpenMatch = ASK_OPEN_RE.exec(cleaned);
  if (askOpenMatch) {
    const q = cleanAskContent(askOpenMatch[1]);
    cleaned = cleaned.slice(0, askOpenMatch.index) + (q ? `\n\n${q}` : "");
  }

  // 4. Process ⟦ARTIFACT:params⟧...⟦/ARTIFACT⟧ tags
  ARTIFACT_OPEN_RE.lastIndex = 0;
  let artifactMatch: RegExpExecArray | null;
  while ((artifactMatch = ARTIFACT_OPEN_RE.exec(cleaned)) !== null) {
    const paramsStr = artifactMatch[1] ?? "";
    let title = "";

    // Parse title parameter if present
    const titleMatch = /title=([^;⟧]*)/i.exec(paramsStr);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
    }

    const replacement = title ? `### ${title}\n\n` : "";
    cleaned = cleaned.replace(artifactMatch[0], replacement);
    ARTIFACT_OPEN_RE.lastIndex = 0; // reset index after mutation
  }

  // Remove closing artifact tag ⟦/ARTIFACT⟧
  cleaned = cleaned.replace(new RegExp(ARTIFACT_CLOSE, "g"), "");

  // Normalize excessive blank lines created by marker removal
  return cleaned.replace(/\n{3,}/g, "\n\n");
}
