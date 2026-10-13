import { Router, type IRouter } from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import healthRouter from "./health";
import storageRouter from "./storage";
import { getIdentity } from "../lib/identity";

const router: IRouter = Router();
const identitiesByRequest = new WeakMap<object, { userId: string; email: string; name: string }>();

router.use(healthRouter);
router.use(storageRouter);

const fastApiProxy = createProxyMiddleware({
  target: "http://127.0.0.1:8091",
  changeOrigin: true,
  on: {
    proxyReq(proxyReq, req) {
      proxyReq.removeHeader("x-msb-user-id");
      proxyReq.removeHeader("x-msb-user-email");
      proxyReq.removeHeader("x-msb-user-name");
      const identity = identitiesByRequest.get(req);
      if (!identity) return;
      proxyReq.setHeader("x-msb-user-id", identity.userId);
      if (identity.email) proxyReq.setHeader("x-msb-user-email", encodeURIComponent(identity.email));
      if (identity.name) proxyReq.setHeader("x-msb-user-name", encodeURIComponent(identity.name));
      // Rewriting the parsed body writes to the outgoing request and commits
      // headers. All identity headers must be set before this call.
      fixRequestBody(proxyReq, req);
    },
    error(_error, _req, res) {
      if ("writeHead" in res && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Service de rapports indisponible" }));
      }
    },
  },
});

router.use(async (req, res, next) => {
  if (req.path.startsWith("/internal/")) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  let identity: Awaited<ReturnType<typeof getIdentity>>;
  try {
    identity = await getIdentity(req);
  } catch (err) {
    req.log.error({ err }, "Unable to verify account identity");
    res.status(503).json({ error: "Vérification du compte indisponible. Réessayez." });
    return;
  }
  if (!identity) {
    req.log.warn("Authenticated API request rejected");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  identitiesByRequest.set(req, identity);
  fastApiProxy(req, res, next);
});

export default router;
