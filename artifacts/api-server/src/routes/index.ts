import { Router, type IRouter } from "express";
import { getAuth } from "@clerk/express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import healthRouter from "./health";
import storageRouter from "./storage";
import { verifiedIdentity } from "../lib/verifiedIdentity";

const router: IRouter = Router();
const identitiesByRequest = new WeakMap<object, { email: string; name: string }>();

router.use(healthRouter);
router.use(storageRouter);

const fastApiProxy = createProxyMiddleware({
  target: "http://127.0.0.1:8091",
  changeOrigin: true,
  on: {
    proxyReq(proxyReq, req) {
      proxyReq.removeHeader("x-msb-user-email");
      proxyReq.removeHeader("x-msb-user-name");
      const auth = getAuth(req as never);
      if (!auth.userId) return;
      proxyReq.setHeader("x-msb-user-id", auth.userId);
      const identity = identitiesByRequest.get(req);
      if (identity?.email) proxyReq.setHeader("x-msb-user-email", encodeURIComponent(identity.email));
      if (identity?.name) proxyReq.setHeader("x-msb-user-name", encodeURIComponent(identity.name));
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
  const userId = getAuth(req).userId;
  if (!userId) {
    req.log.warn(
      {
        authReason: res.getHeader("x-clerk-auth-reason"),
        hasSessionCookie: /(?:^|;\s*)__session(?:_[^=;]+)?=/.test(req.headers.cookie ?? ""),
        hasDevBrowserCookie: /(?:^|;\s*)__clerk_db_jwt(?:_[^=;]+)?=/.test(req.headers.cookie ?? ""),
      },
      "Authenticated API request rejected",
    );
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    identitiesByRequest.set(req, await verifiedIdentity(userId));
  } catch (err) {
    req.log.error({ err }, "Unable to verify account identity");
    res.status(503).json({ error: "Vérification du compte indisponible. Réessayez." });
    return;
  }
  fastApiProxy(req, res, next);
});

export default router;
