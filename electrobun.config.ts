import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "OpenTack",
    identifier: "com.opentack.app",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    // Copy Vite build output so it's served at views://mainview/
    copy: {
      "dist/client": "views/mainview",
      // DB migration files — referenced via ../../drizzle from app/bun/index.js
      "drizzle": "drizzle",
    },
    mac: {
      icons: "assets/icon.icns",
    },
    win: {
      icons: "assets/icon.ico",
    },
    linux: {
      icons: "assets/icon.png",
    },
  },
  release: {
    baseUrl: "https://releases.opentack.dev/",
  },
} satisfies ElectrobunConfig
