/**
 * Trace context middleware (issue #123).
 *
 * Continues the caller's W3C trace (`traceparent` / `tracestate` request
 * headers) or starts a new one, runs the rest of the request inside it, and
 * echoes the server span back as a `traceparent` response header so a client
 * or support engineer can quote it.
 *
 * Mount it before every other middleware so their log lines carry the ids.
 */
import type { NextFunction, Request, Response } from "express";
import {
  contextFromHeaders,
  formatTraceparent,
  runWithTraceContext,
} from "../tracing/trace-context.js";

export function traceContext() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = contextFromHeaders(
      req.header("traceparent"),
      req.header("tracestate"),
    );
    res.setHeader("traceparent", formatTraceparent(ctx));
    runWithTraceContext(ctx, () => next());
  };
}

export default traceContext;
