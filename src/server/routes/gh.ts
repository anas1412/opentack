import type { FastifyInstance } from "fastify";
import { testGhConnection, autoInstallGh, findGh } from "../../shared/gh-runner";

const GH_CLIENT_ID = "178c6fc778ccc68e1d6a";

/**
 * Poll GitHub's token endpoint and handle the result (token → gh inject → verify).
 */
async function pollAndInject(deviceCode: string, reply: any) {
  // Try curl first (more reliable for this endpoint)
  const curlResult = Bun.spawnSync([
    "curl", "-s", "-X", "POST",
    "https://github.com/login/oauth/access_token",
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json",
    "-d", JSON.stringify({
      client_id: GH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    "--stderr", process.platform === "win32" ? "NUL" : "/dev/null",
  ]);

  let data: any;
  if (curlResult.exitCode === 0) {
    data = JSON.parse(curlResult.stdout.toString());
  } else {
    // Fallback to fetch
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    data = await res.json();
  }

  if (data.access_token) {
    const injectProc = Bun.spawn(["gh", "auth", "login", "--with-token"], { stdin: "pipe", stderr: "pipe" });
    injectProc.stdin.write(data.access_token + "\n");
    injectProc.stdin.end();
    const exitCode = await injectProc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(injectProc.stderr).text();
      return reply.status(500).send({ status: "error", error: `Token injection failed: ${stderr}` });
    }
    const userResult = await testGhConnection();
    if (userResult.ok && userResult.user) {
      return { status: "success", user: userResult.user };
    }
    return { status: "error", error: "Token injected but verification failed" };
  }

  if (data.error === "authorization_pending" || data.error === "slow_down") return { status: "pending" };
  if (data.error === "expired_token" || data.error === "access_denied") {
    return { status: "expired", error: data.error_description || data.error };
  }
  return { status: "error", error: data.error_description || data.error || "Unknown error" };
}

export function registerGhRoutes(app: FastifyInstance) {
  // Test gh + token authentication
  app.post("/api/gh/test", async () => {
    const result = await testGhConnection();
    return result;
  });

  // Auto-install gh CLI
  app.post("/api/gh/install", async (req, reply) => {
    const existing = await findGh("gh");
    if (existing) {
      return { success: true, path: existing };
    }
    try {
      const path = await autoInstallGh();
      return { success: true, path };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error during installation";
      return reply.status(500).send({ success: false, error: "INSTALL_FAILED", message });
    }
  });

  // Logout from gh CLI
  app.post("/api/gh/logout", async () => {
    const result = Bun.spawnSync(["gh", "auth", "logout", "-h", "github.com"]);
    if (result.exitCode === 0) return { ok: true };
    const stderr = result.stderr.toString().trim();
    if (stderr.includes("not logged in")) return { ok: true };
    return { ok: false, error: stderr || "Logout failed" };
  });

  // Start OAuth device flow (sign in with GitHub)
  // Returns processId (= device_code), userCode, verificationUri
  app.post("/api/gh/auth/login", async (req, reply) => {
    try {
      const res = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: GH_CLIENT_ID, scope: "repo,read:org,workflow" }),
      });
      if (!res.ok) {
        const text = await res.text();
        return reply.status(500).send({ error: "AUTH_START_FAILED", message: `GitHub device code request failed: ${res.status} ${text}` });
      }
      const data = await res.json();
      // Use device_code as processId (stateless — REST maps directly)
      return { processId: data.device_code, userCode: data.user_code, verificationUri: data.verification_uri };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.status(500).send({ error: "AUTH_START_FAILED", message });
    }
  });

  // Poll for device auth result
  app.post("/api/gh/auth/login-poll/:processId", async (req, reply) => {
    const { processId } = req.params as { processId: string };
    if (!processId) {
      return reply.status(400).send({ error: "MISSING_PROCESS_ID", message: "processId is required" });
    }
    return pollAndInject(processId, reply);
  });
}
