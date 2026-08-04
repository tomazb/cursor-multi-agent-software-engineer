#!/usr/bin/env node
import { runCli } from "./cli-runner.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";

runCli().catch((error) => {
  console.error(
    sanitizeDiagnostic(
      error instanceof Error ? error.message : String(error),
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
    ).text,
  );
  process.exitCode = 1;
});
