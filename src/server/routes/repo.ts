import { existsSync } from "fs";
import path from "path";
import { homedir } from "os";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../../db";
import { repoCreateSchema, repoUpdateSchema } from "../validators";
import { getOpenTackReposDir } from "../../paths";

export function registerRepoRoutes(app: FastifyInstance) {
  // Create repo
  app.post("/api/repos", async (req, reply) => {
    const input = repoCreateSchema.parse(req.body);
    const id = crypto.randomUUID();

    // Auto-discover path if not provided
    let localPath = input.localPath;
    let defaultBranch = input.defaultBranch;
    if (!localPath) {
      try {
        const result = Bun.spawnSync(["find", homedir(), "-maxdepth", "5", "-type", "d", "-name", input.name, "-exec", "test", "-d", "{}/.git", ";", "-print"]);
        const found = result.stdout.toString().trim().split("\n")[0];
        if (found) {
          localPath = found;
          app.log.info({ name: input.name, localPath }, "Auto-discovered repo path");
        } else {
          return reply.status(400).send({
            error: "PATH_NOT_FOUND",
            message: `Could not find a git repo named "${input.name}". Specify the path manually.`,
          });
        }
      } catch {
        return reply.status(400).send({
          error: "DISCOVERY_FAILED",
          message: `Could not auto-discover repo path for "${input.name}". Specify the path manually.`,
        });
      }
    }

    // Verify path exists and is a git repo
    const gitCheck = Bun.spawnSync(["git", "-C", localPath, "rev-parse", "--git-dir"]);
    if (gitCheck.exitCode !== 0) {
      return reply.status(400).send({
        error: "NOT_A_GIT_REPO",
        message: `"${localPath}" is not a valid git repository.`,
      });
    }

    // Auto-detect default branch if not explicitly provided (beyond the default "main")
    if (!defaultBranch || defaultBranch === "main") {
      const symbolic = Bun.spawnSync(["git", "-C", localPath, "symbolic-ref", "--short", "HEAD"]);
      const branch = symbolic.exitCode === 0
        ? symbolic.stdout.toString().trim()
        : Bun.spawnSync(["git", "-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
      if (branch && branch !== "HEAD") defaultBranch = branch;
    }

    const repoRow = {
      id,
      name: input.name,
      localPath,
      defaultBranch,
      envVars: JSON.stringify(input.envVars),
      createdAt: Date.now(),
      lastUsedAt: null,
    };

    await db.insert(schema.repos).values(repoRow);
    return { ...repoRow, envVars: input.envVars };
  });

  // List repos
  app.get("/api/repos", async () => {
    const rows = await db.select().from(schema.repos).orderBy(schema.repos.name);
    return rows.map(deserializeRepo);
  });

  // Get repo
  app.get("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(schema.repos).where(eq(schema.repos.id, id));
    if (!row) return reply.status(404).send({ error: "NOT_FOUND", message: "Repo not found" });
    return deserializeRepo(row);
  });

  // Update repo
  app.put("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = repoUpdateSchema.parse(req.body);

    const existing = await db.select().from(schema.repos).where(eq(schema.repos.id, id));
    if (!existing.length) return reply.status(404).send({ error: "NOT_FOUND", message: "Repo not found" });

    const update: Record<string, unknown> = {};
    if (input.name !== undefined) update.name = input.name;
    if (input.localPath !== undefined) update.localPath = input.localPath;
    if (input.defaultBranch !== undefined) update.defaultBranch = input.defaultBranch;
    if (input.envVars !== undefined) update.envVars = JSON.stringify(input.envVars);

    await db.update(schema.repos).set(update).where(eq(schema.repos.id, id));
    const [row] = await db.select().from(schema.repos).where(eq(schema.repos.id, id));
    return deserializeRepo(row!);
  });

  // Delete repo
  app.delete("/api/repos/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    await db.delete(schema.repos).where(eq(schema.repos.id, id));
    return reply.status(204).send();
  });

  // Clone repo from a git URL (GitHub, etc.)
  app.post("/api/repos/clone", async (req, reply) => {
    const { gitUrl } = z
      .object({ gitUrl: z.string().min(1, "Git URL is required") })
      .parse(req.body);

    const repoName = extractRepoName(gitUrl);
    if (!repoName) {
      return reply.status(400).send({
        error: "INVALID_URL",
        message: `Could not extract repo name from "${gitUrl}". Use a GitHub URL like git@github.com:user/repo.git or https://github.com/user/repo.git`,
      });
    }

    const reposDir = process.env.OPENTACK_DB_PATH
      ? path.join(path.dirname(process.env.OPENTACK_DB_PATH), "repos")
      : getOpenTackReposDir();
    const cloneDest = path.join(reposDir, repoName);

    // Check if already exists
    if (existsSync(cloneDest)) {
      return reply.status(409).send({
        error: "ALREADY_CLONED",
        message: `Repo already cloned at ${cloneDest}. Remove it first or add it manually.`,
      });
    }

    // Clone
    try {
      app.log.info({ gitUrl, cloneDest }, "Cloning repo");
      const clone = Bun.spawnSync(["git", "clone", "--depth", "1", gitUrl, cloneDest]);
      if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr || "";

      // Detect private-repo / auth errors and give actionable advice
      const isPrivateRepo =
        stderr.includes("Repository not found") ||
        stderr.includes("Permission denied") ||
        stderr.includes("Authentication failed") ||
        stderr.includes("could not read Username") ||
        stderr.includes("not permitted");

      let hint = stderr.slice(0, 300);
      if (isPrivateRepo) {
        const isSsh = gitUrl.startsWith("git@");
        if (isSsh) {
          hint +=
            "\n\nThis looks like a private repo. Make sure your SSH key is added to GitHub:\n" +
            "  1. Check: ssh -T git@github.com\n" +
            "  2. List keys: ssh-add -l\n" +
            "  3. Add key to agent: ssh-add ~/.ssh/id_ed25519\n" +
            "  4. Add key to GitHub: https://github.com/settings/keys\n" +
            "\nOr use an HTTPS URL with a personal access token:\n" +
            "  https://<username>:<token>@github.com/user/repo.git";
        } else {
          hint +=
            "\n\nThis looks like a private repo. For HTTPS, use a personal access token:\n" +
            "  https://<username>:<token>@github.com/user/repo.git\n" +
            "\nCreate a token at: https://github.com/settings/tokens\n" +
            "Then re-run with the token embedded in the URL.";
        }
      }

      return reply.status(400).send({
        error: "CLONE_FAILED",
        message: hint,
      });
    }

    // Auto-detect default branch
    let defaultBranch = "main";
    const symbolic = Bun.spawnSync(["git", "-C", cloneDest, "symbolic-ref", "--short", "HEAD"]);
    const branch = symbolic.exitCode === 0
      ? symbolic.stdout.toString().trim()
      : Bun.spawnSync(["git", "-C", cloneDest, "rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
    if (branch && branch !== "HEAD") defaultBranch = branch;

    const id = crypto.randomUUID();
    const repoRow = {
      id,
      name: repoName,
      localPath: cloneDest,
      defaultBranch,
      envVars: "{}",
      createdAt: Date.now(),
      lastUsedAt: null,
    };

    await db.insert(schema.repos).values(repoRow);
    app.log.info({ id, name: repoName, cloneDest }, "Repo cloned and added");

    return { ...repoRow, envVars: {} };
  });
}

/**
 * Extract repo name from common git URL formats:
 *   git@github.com:user/repo.git   → repo
 *   https://github.com/user/repo   → repo
 *   https://github.com/user/repo.git → repo
 */
function extractRepoName(gitUrl: string): string | null {
  // SSH: git@github.com:user/repo.git
  let m = gitUrl.match(/:([^\/]+)\.git$/);
  if (m) return m[1];
  // SSH without .git: git@github.com:user/repo
  m = gitUrl.match(/:([^\/]+)$/);
  if (m) return m[1];
  // HTTPS: https://github.com/user/repo.git
  m = gitUrl.match(/\/([^\/]+?)\.git$/);
  if (m) return m[1];
  // HTTPS without .git: https://github.com/user/repo
  m = gitUrl.match(/\/([^\/]+?)$/);
  if (m) return m[1];
  return null;
}

function deserializeRepo(row: typeof schema.repos.$inferSelect) {
  return {
    ...row,
    envVars: JSON.parse(row.envVars),
  };
}
