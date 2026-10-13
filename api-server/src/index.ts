import app from "./app";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";
import { waitForHealthyService } from "./lib/service-readiness";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const fastApiPort = Number(process.env.MSB_FASTAPI_PORT ?? 8091);
const fastApi = spawn(
  "python",
  [
    "-m",
    "uvicorn",
    "main:app",
    "--app-dir",
    fileURLToPath(new URL("../python_api", import.meta.url)),
    "--host",
    "127.0.0.1",
    "--port",
    String(fastApiPort),
  ],
  { stdio: "inherit", env: process.env },
);

function stopFastApi(child: ChildProcess): void {
  if (!child.killed) child.kill("SIGTERM");
}

let fastApiSpawnError: Error | undefined;

fastApi.on("error", (err) => {
  fastApiSpawnError = err;
  logger.error({ err }, "Unable to start FastAPI");
});
fastApi.on("exit", (code, signal) => {
  if (code !== 0 && code !== null) {
    logger.error({ code, signal }, "FastAPI stopped unexpectedly");
  }
});

process.on("SIGTERM", () => stopFastApi(fastApi));
process.on("SIGINT", () => stopFastApi(fastApi));

waitForHealthyService({
  url: `http://127.0.0.1:${fastApiPort}/healthz`,
  serviceName: "FastAPI",
  assertRunning: () => {
    if (fastApiSpawnError) throw fastApiSpawnError;
    if (fastApi.exitCode !== null || fastApi.signalCode !== null) {
      throw new Error(`FastAPI stopped during startup (${fastApi.exitCode ?? fastApi.signalCode})`);
    }
  },
})
  .then(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        stopFastApi(fastApi);
        process.exit(1);
      }
      logger.info({ port, fastApiPort }, "API gateway and FastAPI are ready");
    });
  })
  .catch((err: unknown) => {
    logger.error({ err }, "FastAPI startup failed");
    stopFastApi(fastApi);
    process.exit(1);
  });
