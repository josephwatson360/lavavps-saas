// ─────────────────────────────────────────────────────────────────────────────
// Structured Logger — Lambda Layer Utility
//
// All Lambda functions use this logger. It outputs JSON that CloudWatch
// can parse and filter with metric filters.
//
// IMPORTANT: Never log field VALUES that could contain sensitive data:
//   - API keys, tokens, passwords
//   - System prompt content
//   - Channel credentials
//   - Customer PII
//
// Log field NAMES (e.g. which field failed validation) are fine.
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level:     LogLevel;
  source:    string;         // Lambda function name (e.g. 'configRenderer')
  event?:    string;         // Structured event name (e.g. 'CONFIG_VALIDATION_FAILED')
  tenant_id?: string;
  agent_id?:  string;
  message:    string;
  [key: string]: unknown;   // Additional structured fields
}

export class Logger {
  private readonly source: string;
  private readonly context: Record<string, string>;

  constructor(source: string, context: Record<string, string> = {}) {
    this.source  = source;
    this.context = context;
  }

  /** Create a child logger with additional fixed context fields */
  child(extraContext: Record<string, string>): Logger {
    return new Logger(this.source, { ...this.context, ...extraContext });
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log('DEBUG', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log('INFO', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log('WARN', message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log('ERROR', message, extra);
  }

  /** Log a config validation failure — field names and error types only, never values */
  configValidationFailed(params: {
    tenant_id:               string;
    agent_id:                string;
    config_version_attempted: number;
    prior_valid_version?:    number;
    validation_errors:       Array<{ field: string; error: string; allowed?: unknown }>;
  }): void {
    this.log('ERROR', 'Config validation failed — EFS not written, running agent unchanged', {
      event:                   'CONFIG_VALIDATION_FAILED',
      tenant_id:               params.tenant_id,
      agent_id:                params.agent_id,
      config_version_attempted: params.config_version_attempted,
      prior_valid_version:     params.prior_valid_version,
      agent_status:            'UNCHANGED',
      validation_errors:       params.validation_errors,
    });
  }

  private log(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      source:    this.source,
      message,
      ...this.context,
      ...extra,
    };

    // Use console.log for all levels — CloudWatch ingests stdout
    // Lambda runtime routes console.error to stderr, but CW captures both
    if (level === 'ERROR') {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }
}

/** Factory — creates a logger scoped to the calling Lambda function */
export function createLogger(source: string): Logger {
  return new Logger(source);
}
