import { defineConfig } from "drizzle-kit";
import { homedir } from "os";
import path from "path";

const DB_PATH = path.join(homedir(), ".opentack", "db.sqlite");

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: DB_PATH,
  },
});
