#!/usr/bin/env bun
/**
 * Cross-platform dev:hot — watches the client build and launches electrobun
 * once the client bundle is ready. Replaces the Unix shell syntax version.
 */
import { existsSync } from "fs";

const vite = Bun.spawn(["bun", "run", "build:client", "--watch"], {
  stdio: ["inherit", "inherit", "inherit"],
});

// Poll for the built index.html (vite build output)
while (!existsSync("dist/client/index.html")) {
  await Bun.sleep(200);
}

const electrobun = Bun.spawn(["bun", "x", "electrobun", "dev"], {
  stdio: ["inherit", "inherit", "inherit"],
});

await electrobun.exited;
vite.kill();
