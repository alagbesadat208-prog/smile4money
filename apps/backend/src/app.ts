import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import matchRouter from './routes/matches.js';
import validateGameRouter from './routes/validate-game.js';
import oracleRouter from './routes/oracle.js';
import { errorToHttpStatus } from './errors/errorToHttpStatus.js';
import { requestLogging } from './middleware/request-logging.js';
import { traceContext } from './middleware/trace-context.js';

/**
 * Parse the ALLOWED_ORIGINS environment variable into an array of origin strings.
 * Accepts a comma-separated list, e.g. "https://app.example.com,https://staging.example.com".
 * Falls back to the frontend URL in production or localhost in development.
 */
function getAllowedOrigins(): string[] {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  }
  if (process.env.FRONTEND_URL) {
    return [process.env.FRONTEND_URL];
  }
  // Development fallback — not used when ALLOWED_ORIGINS is set in production
  return ['http://localhost:5173'];
}

export const app = express();

// #123 — first, so every later middleware and log line runs inside the
// request's W3C trace context.
app.use(traceContext());

app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = getAllowedOrigins();
      // Allow server-to-server requests (no Origin header) and listed origins
      if (!origin || allowed.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' is not allowed`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'traceparent', 'tracestate'],
    exposedHeaders: ['traceparent'],
    credentials: true,
  })
);

app.use(express.json());
// #1722 — logs method/path/status/duration at INFO (no body ever); request
// bodies are only logged at DEBUG, and only after sensitive-field redaction.
app.use(requestLogging());
app.use('/health', healthRouter);
app.use('/api/matches', matchRouter);
app.use('/api/validate-game', validateGameRouter);
app.use('/api/oracle', oracleRouter);

// Fallback for any error a route handler doesn't catch itself, so every
// route ends up with the same JSON error shape and the same centralized
// status-code mapping (#47) rather than Express's default HTML error page.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = errorToHttpStatus(err);
  const message = err instanceof Error ? err.message : 'Unknown error';
  res.status(status).json({ error: message });
});

export default app;
