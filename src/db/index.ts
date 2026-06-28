import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import * as schema from "./schema";
import { getOpenTackDbPath } from "../paths";

const DB_PATH = getOpenTackDbPath();

// Ensure parent directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH, { create: true });
sqlite.exec("PRAGMA journal_mode=WAL;");
sqlite.exec("PRAGMA foreign_keys=ON;");

export const db = drizzle(sqlite, { schema });

export { schema };
