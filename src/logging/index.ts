/**
 * Structured JSON logging. Every pipeline log line carries ingestion_job_id and
 * stage (locked decision: this is the observability path; no Agents SDK tracing).
 */
export interface LogContext {
  ingestion_job_id?: string;
  stage?: string;
  knowledge_base_id?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
}

function emit(level: string, msg: string, ctx: LogContext): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...ctx })}\n`);
}

export function createLogger(base: LogContext = {}): Logger {
  return {
    info: (msg, ctx) => emit("info", msg, { ...base, ...ctx }),
    warn: (msg, ctx) => emit("warn", msg, { ...base, ...ctx }),
    error: (msg, ctx) => emit("error", msg, { ...base, ...ctx }),
    child: (ctx) => createLogger({ ...base, ...ctx }),
  };
}

export const logger = createLogger();
