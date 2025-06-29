import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import session from "express-session";
import { storage } from "./storage";

// Setup the Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Setup session middleware with storage.sessionStore
app.use(
  session({
    secret: process.env.SESSION_SECRET || "keyboard_cat_fallback_secret",
    resave: false,
    saveUninitialized: true, // Required for OAuth flow to work properly
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24, // 24 hours
      sameSite: "none", // Allow cookies to be sent in cross-site requests
    },
    store: storage.sessionStore,
    name: "facebook_oauth_session", // Explicit session name
  }),
);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  // Add timeout and connection handling middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Set request timeout to prevent hanging connections
    req.setTimeout(15000, () => {
      console.log(`Request timeout for ${req.method} ${req.path}`);
      if (!res.headersSent) {
        res.status(408).json({ error: 'Request timeout' });
      }
    });
    
    // Handle connection aborts gracefully
    req.on('aborted', () => {
      console.log(`Request aborted for ${req.method} ${req.path}`);
    });
    
    next();
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Don't throw the error, just log it and respond
    console.error(`Server error: ${message}`, err);
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const port = process.env.PORT || 5000;
  server.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
