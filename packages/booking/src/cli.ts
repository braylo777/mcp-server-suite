#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { ConfigError, bootServer } from "@braylo/mcp-core";

import { openBooking } from "./app.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  bootServer({
    name: "braylo-booking",
    version: "0.1.0",
    defaultPort: 7483,
    open: (ctx) => openBooking(ctx),
  }).catch((error: unknown) => {
    const message = error instanceof ConfigError || error instanceof Error ? error.message : "startup failed";
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "error", server: "braylo-booking", msg: "startup_failed", message })}\n`,
    );
    process.exit(1);
  });
}
