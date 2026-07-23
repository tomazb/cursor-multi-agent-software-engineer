import type { AgentRuntime, MasweConfig } from "./domain.ts";
import { CursorCliRuntime } from "./runtimes/cursor-cli.ts";
import { CursorSdkRuntime } from "./runtimes/cursor-sdk.ts";
import { MockRuntime } from "./runtimes/mock.ts";

export function createRuntime(config: MasweConfig, cwd: string = process.cwd()): AgentRuntime {
  switch (config.runtime.kind) {
    case "mock":
      return new MockRuntime();
    case "cursor-cli":
      return new CursorCliRuntime(config, { cwd });
    case "cursor-sdk":
      return new CursorSdkRuntime();
  }
}
