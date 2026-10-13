import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// Some publishing probes hit the artifact's base path (/api). Both aliases
// stay public, and are only reachable after the Python backend is ready.
router.get(["/", "/healthz"], (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
