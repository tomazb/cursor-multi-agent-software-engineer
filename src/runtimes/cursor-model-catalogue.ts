const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const MODEL_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._+-]{2,80}$/;
const METADATA_ID_PATTERN =
  /^(?:alias|metadata|context|build|status|provider|timeout|tokens?|default|recommended)(?:[-_].*)?$/i;
const ROW_PREFIX_PATTERN = /^(?:[>*•·▪▸❯✔✓☑]|[-+])\s+/;
const KNOWN_BADGE_PATTERN = /^\s+\(default\)/i;

export interface MalformedCatalogueRow {
  lineNumber: number;
  line: string;
  candidate: string;
}

export interface ParsedModelCatalogue {
  ids: Set<string>;
  malformedRows: MalformedCatalogueRow[];
}

type ParsedCatalogueRow =
  | { kind: "id"; id: string }
  | { kind: "malformed"; candidate: string }
  | { kind: "ignored" };

/**
 * Parse exact executable model IDs from Cursor `agent models` text output.
 *
 * Recognized rows contain an ID by itself or after a known selection prefix,
 * optionally followed by `(default)`, a spaced dash description, a tab-separated
 * column, or an aligned column separated by at least two spaces. Single-space
 * prose after an ID-shaped token is malformed and never contributes an ID.
 */
export function parseModelCatalogue(catalogueText: string): ParsedModelCatalogue {
  const ids = new Set<string>();
  const malformedRows: MalformedCatalogueRow[] = [];
  const stripped = catalogueText.replace(ANSI_ESCAPE_PATTERN, "");

  for (const [index, line] of stripped.split(/\r?\n/).entries()) {
    const parsed = parseCatalogueRow(line);
    if (parsed.kind === "id") {
      ids.add(parsed.id);
    } else if (parsed.kind === "malformed") {
      malformedRows.push({
        lineNumber: index + 1,
        line: line.trim(),
        candidate: parsed.candidate,
      });
    }
  }

  return { ids, malformedRows };
}

export function parseModelCatalogueIds(catalogueText: string): Set<string> {
  return parseModelCatalogue(catalogueText).ids;
}

function parseCatalogueRow(line: string): ParsedCatalogueRow {
  let trimmed = line.trim();
  if (!trimmed) return { kind: "ignored" };

  // Headings and key/value metadata (alias:, metadata:, Available models:, …).
  if (/^[A-Za-z][\w ./-]*:\s*$/.test(trimmed)) return { kind: "ignored" };
  if (/^[A-Za-z][\w-]*\s*:/.test(trimmed)) return { kind: "ignored" };

  // Standalone annotations and Markdown headings are not catalogue rows.
  if (/^\(.*\)$/.test(trimmed)) return { kind: "ignored" };
  if (/^#+/.test(trimmed)) return { kind: "ignored" };

  trimmed = trimmed.replace(ROW_PREFIX_PATTERN, "");
  if (!trimmed) return { kind: "ignored" };

  const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9._+-]{2,80})(.*)$/);
  if (!match) return { kind: "ignored" };

  const id = match[1]!.toLowerCase();
  if (!MODEL_ID_PATTERN.test(id)) return { kind: "ignored" };
  if (!/[0-9]/.test(id)) return { kind: "ignored" };
  if (METADATA_ID_PATTERN.test(id)) return { kind: "ignored" };

  let remainder = match[2]!;
  while (KNOWN_BADGE_PATTERN.test(remainder)) {
    remainder = remainder.replace(KNOWN_BADGE_PATTERN, "");
  }

  if (remainder.length === 0) return { kind: "id", id };
  if (/^\s+[-–—]\s+\S.*$/.test(remainder)) return { kind: "id", id };
  if (/^\t+\S.*$/.test(remainder)) return { kind: "id", id };
  if (/^ {2,}\S.*$/.test(remainder)) return { kind: "id", id };

  return { kind: "malformed", candidate: id };
}
