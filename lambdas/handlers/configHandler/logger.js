"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
exports.createLogger = createLogger;
class Logger {
    constructor(source, context = {}) {
        this.source = source;
        this.context = context;
    }
    /** Create a child logger with additional fixed context fields */
    child(extraContext) {
        return new Logger(this.source, { ...this.context, ...extraContext });
    }
    debug(message, extra) {
        this.log('DEBUG', message, extra);
    }
    info(message, extra) {
        this.log('INFO', message, extra);
    }
    warn(message, extra) {
        this.log('WARN', message, extra);
    }
    error(message, extra) {
        this.log('ERROR', message, extra);
    }
    /** Log a config validation failure — field names and error types only, never values */
    configValidationFailed(params) {
        this.log('ERROR', 'Config validation failed — EFS not written, running agent unchanged', {
            event: 'CONFIG_VALIDATION_FAILED',
            tenant_id: params.tenant_id,
            agent_id: params.agent_id,
            config_version_attempted: params.config_version_attempted,
            prior_valid_version: params.prior_valid_version,
            agent_status: 'UNCHANGED',
            validation_errors: params.validation_errors,
        });
    }
    log(level, message, extra = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            source: this.source,
            message,
            ...this.context,
            ...extra,
        };
        // Use console.log for all levels — CloudWatch ingests stdout
        // Lambda runtime routes console.error to stderr, but CW captures both
        if (level === 'ERROR') {
            console.error(JSON.stringify(entry));
        }
        else {
            console.log(JSON.stringify(entry));
        }
    }
}
exports.Logger = Logger;
/** Factory — creates a logger scoped to the calling Lambda function */
function createLogger(source) {
    return new Logger(source);
}
