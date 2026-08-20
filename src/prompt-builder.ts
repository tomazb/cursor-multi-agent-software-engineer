import { readFile } from "node:fs/promises";
import type { RoleId, RunRecord } from "./domain.ts";
import type { RunStore } from "./store.ts";

const TEMPLATE_BY_ROLE: Record<RoleId, string> = {
  brainstormer: "brainstorm.md",
  designer: "design.md",
  builder: "build.md",
  verifier: "verify.md",
  prResolver: "pr-resolve.md",
};

async function readTemplate(fileName: string): Promise<string> {
  return readFile(new URL(`../prompts/${fileName}`, import.meta.url), "utf8");
}

const PROMPT_PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function renderPromptTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(PROMPT_PLACEHOLDER, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Unknown prompt placeholder ${token}`);
    }
    return values[key]!;
  });
}

export async function buildRolePrompt(
  role: RoleId,
  run: RunRecord,
  store: RunStore,
  extra: Record<string, string> = {},
): Promise<string> {
  const template = await readTemplate(TEMPLATE_BY_ROLE[role]);
  const brainstorm = (await store.readArtifact(run, "02-brainstorm.md")) ?? "Not available.";
  const design = (await store.readArtifact(run, "03-specification-and-design.md")) ?? "Not available.";
  const builderReport = (await store.readArtifact(run, "04-builder-report.md")) ?? "Not available.";
  const qualityReport = (await store.readArtifact(run, "05-quality-report.md")) ?? "Not available.";
  const verificationReport =
    (await store.readArtifact(run, "06-verification-report.md")) ?? "Not available.";
  const verifierDefects =
    (await store.readArtifact(run, "10-verifier-defects.md")) ?? "No explicit defect list.";
  const comment = (await store.readArtifact(run, "07-review-comment.md")) ?? "Not available.";
  const classification =
    (await store.readArtifact(run, "08-comment-classification.md")) ?? "Not available.";

  return renderPromptTemplate(template, {
    RUN_ID: run.id,
    TITLE: run.title,
    REQUEST: run.request,
    BRAINSTORM: brainstorm,
    DESIGN: design,
    BUILDER_REPORT: builderReport,
    QUALITY_REPORT: qualityReport,
    VERIFICATION_REPORT: verificationReport,
    VERIFIER_DEFECTS: verifierDefects,
    COMMENT: comment,
    CLASSIFICATION: classification,
    ...extra,
  });
}

export async function buildCommentClassifierPrompt(
  run: RunRecord,
  store: RunStore,
  comment: string,
): Promise<string> {
  const template = await readTemplate("pr-comment-classify.md");
  const design = (await store.readArtifact(run, "03-specification-and-design.md")) ?? "Not available.";
  return renderPromptTemplate(template, {
    RUN_ID: run.id,
    TITLE: run.title,
    REQUEST: run.request,
    DESIGN: design,
    COMMENT: comment,
  });
}
