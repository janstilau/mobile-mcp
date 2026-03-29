import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { getDefaultConfigPath, loadMobileMcpConfig } from "./config";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

export interface LogContext {
	traceId?: string;
	tool?: string;
	device?: string;
	client?: string;
}

type SplitMode = "time" | "trace" | "time+trace";

interface LoggerConfig {
	enabled: boolean;
	level: LogLevel;
	format: LogFormat;
	outputFile: boolean;
	outputStderr: boolean;
	logFile?: string;
	logDir: string;
	logPrefix: string;
	splitMode: SplitMode;
	rotateMinutes: number;
	retainGlobalFiles: number;
	retainTraceFiles: number;
	truncate: boolean;
	maxChars: number;
	enableCommands: boolean;
	enableHttp: boolean;
	enableMcp: boolean;
	enableData: boolean;
	enableMcpRaw: boolean;
	enableCallsite: boolean;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

const parseBool = (value: string | undefined): boolean | undefined => {
	if (value === undefined) {return undefined;}
	if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {return true;}
	if (["0", "false", "no", "off"].includes(value.toLowerCase())) {return false;}
	return undefined;
};

const parseSplitMode = (value: string | undefined): SplitMode | undefined => {
	if (!value) {return undefined;}
	const lower = value.toLowerCase();
	if (lower === "time" || lower === "trace" || lower === "time+trace") {return lower as SplitMode;}
	return undefined;
};

const parseNumber = (value: string | undefined): number | undefined => {
	if (!value) {return undefined;}
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
};

const parseLevel = (value: string | undefined): LogLevel | undefined => {
	if (!value) {return undefined;}
	const lower = value.toLowerCase();
	if (lower === "trace" || lower === "debug" || lower === "info" || lower === "warn" || lower === "error") {return lower;}
	return undefined;
};

const parseFormat = (value: string | undefined): LogFormat | undefined => {
	if (!value) {return undefined;}
	const lower = value.toLowerCase();
	if (lower === "text" || lower === "json") {return lower;}
	return undefined;
};

const buildConfig = (): LoggerConfig => {
	const debugAll = parseBool(process.env.MOBILE_MCP_DEBUG) ?? false;
	const fileConfig = loadMobileMcpConfig();
	const configPath = process.env.MOBILE_MCP_CONFIG_PATH || getDefaultConfigPath();
	const configDir = path.dirname(configPath);
	const logging = fileConfig?.logging;

	const enabled = parseBool(process.env.MOBILE_MCP_LOG_ENABLED) ?? logging?.enabled ?? false;

	const level = debugAll
		? "trace"
		: (parseLevel(process.env.MOBILE_MCP_LOG_LEVEL) ?? parseLevel(process.env.LOG_LEVEL) ?? logging?.level ?? "info");
	const format = parseFormat(process.env.MOBILE_MCP_LOG_FORMAT) ?? parseFormat(process.env.LOG_FORMAT) ?? logging?.format ?? "text";

	const outputFile = parseBool(process.env.MOBILE_MCP_LOG_TO_FILE) ?? logging?.outputs?.file ?? false;
	const outputStderr = parseBool(process.env.MOBILE_MCP_LOG_TO_STDERR) ?? logging?.outputs?.stderr ?? true;

	const logFile = process.env.MOBILE_MCP_LOG_FILE ?? process.env.LOG_FILE;
	const logDirRaw = process.env.MOBILE_MCP_LOG_DIR ?? logging?.files?.dir ?? "logs";
	const logDir = path.isAbsolute(logDirRaw) ? logDirRaw : path.resolve(configDir, logDirRaw);
	const logPrefix = logging?.files?.prefix ?? "mobile-mcp";
	const splitMode = parseSplitMode(process.env.MOBILE_MCP_LOG_SPLIT_MODE) ?? logging?.split?.mode ?? "time";
	const rotateMinutes = Math.max(1, parseNumber(process.env.MOBILE_MCP_LOG_ROTATE_MINUTES) ?? logging?.files?.rotateMinutes ?? 10);
	const retainGlobalFiles = Math.max(1, parseNumber(process.env.MOBILE_MCP_LOG_RETAIN_GLOBAL) ?? logging?.files?.retainGlobalFiles ?? 6);
	const retainTraceFiles = Math.max(1, parseNumber(process.env.MOBILE_MCP_LOG_RETAIN_TRACE) ?? logging?.files?.retainTraceFiles ?? 200);

	const truncate = parseBool(process.env.MOBILE_MCP_LOG_TRUNCATE) ?? logging?.truncate?.enabled ?? true;
	const maxCharsRaw = process.env.MOBILE_MCP_LOG_MAX_CHARS;
	const defaultMax = debugAll ? 50000 : 20000;
	const maxChars = maxCharsRaw
		? Math.max(256, Number.parseInt(maxCharsRaw, 10) || defaultMax)
		: Math.max(256, logging?.truncate?.maxChars ?? defaultMax);

	const enableCommands = parseBool(process.env.MOBILE_MCP_LOG_COMMANDS) ?? logging?.categories?.commands ?? debugAll ?? false;
	const enableHttp = parseBool(process.env.MOBILE_MCP_LOG_HTTP) ?? logging?.categories?.http ?? debugAll ?? false;
	const enableMcp = parseBool(process.env.MOBILE_MCP_LOG_MCP) ?? logging?.categories?.mcp ?? debugAll ?? false;
	const enableData = parseBool(process.env.MOBILE_MCP_LOG_DATA) ?? logging?.categories?.data ?? debugAll ?? false;
	const enableMcpRaw = parseBool(process.env.MOBILE_MCP_LOG_MCP_RAW) ?? logging?.categories?.mcpRaw ?? debugAll ?? false;
	const enableCallsite = parseBool(process.env.MOBILE_MCP_LOG_CALLSITE) ?? logging?.categories?.callsite ?? debugAll ?? false;

	return {
		enabled: debugAll ? true : enabled,
		level,
		format,
		outputFile: debugAll ? true : outputFile,
		outputStderr: debugAll ? true : outputStderr,
		logFile,
		logDir,
		logPrefix,
		splitMode,
		rotateMinutes,
		retainGlobalFiles,
		retainTraceFiles,
		truncate,
		maxChars,
		enableCommands,
		enableHttp,
		enableMcp,
		enableData,
		enableMcpRaw,
		enableCallsite,
	};
};

const CONFIG: LoggerConfig = buildConfig();

const LEVEL_ORDER: Record<LogLevel, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
};

const shouldLogLevel = (level: LogLevel): boolean => {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[CONFIG.level];
};

const safeStringify = (value: unknown): string => {
	try {
		return JSON.stringify(value);
	} catch {
		try {
			return String(value);
		} catch {
			return "[unstringifiable]";
		}
	}
};

const truncateString = (value: string): { text: string; truncated: boolean } => {
	if (!CONFIG.truncate) {return { text: value, truncated: false };}
	if (value.length <= CONFIG.maxChars) {return { text: value, truncated: false };}
	return { text: value.slice(0, CONFIG.maxChars) + `…(truncated ${value.length - CONFIG.maxChars} chars)`, truncated: true };
};

const serializeValue = (value: unknown): { text: string; truncated: boolean } => {
	if (typeof value === "string") {return truncateString(value);}
	return truncateString(safeStringify(value));
};

const getCallsite = (): string | undefined => {
	if (!CONFIG.enableCallsite) {return undefined;}
	const stack = new Error().stack;
	if (!stack) {return undefined;}
	const lines = stack.split("\n").map(l => l.trim());
	for (const line of lines) {
		// Skip logger frames and Node internals
		if (line.includes("/logger.") || line.includes("node:") || line.includes("(node:")) {continue;}
		if (line.includes("/cmd.") || line.includes("/http.")) {
			// still allow cmd/http callsite if it points to real code
			continue;
		}
		if (line.startsWith("at ")) {
			return line.substring(3);
		}
	}
	return undefined;
};

const ensuredDirs = new Set<string>();
let fileWriteBroken = false;
let lastGlobalBucketStartMs: number | null = null;
let lastTracePruneMs = 0;

const pad2 = (n: number): string => String(n).padStart(2, "0");

const formatLocalStamp = (ms: number): string => {
	const d = new Date(ms);
	const yyyy = d.getFullYear();
	const mm = pad2(d.getMonth() + 1);
	const dd = pad2(d.getDate());
	const hh = pad2(d.getHours());
	const mi = pad2(d.getMinutes());
	return `${yyyy}${mm}${dd}-${hh}${mi}`;
};

const ensureDir = (dirPath: string) => {
	if (ensuredDirs.has(dirPath)) {return;}
	fs.mkdirSync(dirPath, { recursive: true });
	ensuredDirs.add(dirPath);
};

const sanitizeFilePart = (value: string): string => {
	return value
		.replace(/[^a-zA-Z0-9._-]+/g, "_")
		.slice(0, 80);
};

type FileSort = "name" | "mtime";

const listLogFiles = (dirPath: string, prefix: string, sortBy: FileSort): string[] => {
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		const files = entries
			.filter(e => e.isFile())
			.map(e => e.name)
			.filter(name => name.startsWith(prefix) && name.endsWith(".log"))
			.map(name => path.join(dirPath, name));
		if (sortBy === "name") {
			return files.sort();
		}
		return files.sort((a, b) => {
			try {
				return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
			} catch {
				return a.localeCompare(b);
			}
		});
	} catch {
		return [];
	}
};

const pruneOldFiles = (dirPath: string, prefix: string, retain: number, sortBy: FileSort) => {
	const files = listLogFiles(dirPath, prefix, sortBy);
	if (files.length <= retain) {return;}
	const toDelete = files.slice(0, files.length - retain);
	for (const filePath of toDelete) {
		try {
			fs.rmSync(filePath, { force: true });
		} catch {
			// ignore
		}
	}
};

const getGlobalLogPath = (nowMs: number): { filePath: string; bucketStartMs: number } => {
	const rotateMs = CONFIG.rotateMinutes * 60_000;
	const bucketStartMs = Math.floor(nowMs / rotateMs) * rotateMs;
	const stamp = formatLocalStamp(bucketStartMs);
	const fileName = `${CONFIG.logPrefix}-${stamp}.log`;
	return { filePath: path.join(CONFIG.logDir, fileName), bucketStartMs };
};

const getTraceLogPath = (traceId: string): string => {
	const safeTrace = sanitizeFilePart(traceId);
	const traceDir = path.join(CONFIG.logDir, "traces");
	const fileName = `${CONFIG.logPrefix}-trace-${safeTrace}.log`;
	return path.join(traceDir, fileName);
};

const writeToFile = (filePath: string, line: string) => {
	if (fileWriteBroken) {return;}
	try {
		ensureDir(path.dirname(filePath));
		fs.appendFileSync(filePath, line + "\n");
	} catch {
		fileWriteBroken = true;
	}
};

const writeLine = (line: string) => {
	if (!CONFIG.enabled) {return;}

	const ctx = getLogContext();
	const nowMs = Date.now();

	if (CONFIG.outputFile) {
		if (CONFIG.logFile) {
			writeToFile(CONFIG.logFile, line);
		} else {
			if (CONFIG.splitMode === "time" || CONFIG.splitMode === "time+trace") {
				const { filePath, bucketStartMs } = getGlobalLogPath(nowMs);
				writeToFile(filePath, line);

				if (lastGlobalBucketStartMs === null || bucketStartMs !== lastGlobalBucketStartMs) {
					lastGlobalBucketStartMs = bucketStartMs;
					pruneOldFiles(CONFIG.logDir, `${CONFIG.logPrefix}-`, CONFIG.retainGlobalFiles, "name");
				}
			}

			if ((CONFIG.splitMode === "trace" || CONFIG.splitMode === "time+trace") && ctx.traceId) {
				const tracePath = getTraceLogPath(ctx.traceId);
				writeToFile(tracePath, line);

				if (nowMs - lastTracePruneMs >= CONFIG.rotateMinutes * 60_000) {
					lastTracePruneMs = nowMs;
					pruneOldFiles(path.join(CONFIG.logDir, "traces"), `${CONFIG.logPrefix}-trace-`, CONFIG.retainTraceFiles, "mtime");
				}
			}
		}
	}

	if (CONFIG.outputStderr || fileWriteBroken) {
		console.error(line);
	}
};

export const withLogContext = async <T>(ctx: LogContext, fn: () => Promise<T> | T): Promise<T> => {
	const prev = contextStorage.getStore() ?? {};
	const merged: LogContext = { ...prev, ...ctx };
	return await contextStorage.run(merged, async () => await fn());
};

export const getLogContext = (): LogContext => {
	return contextStorage.getStore() ?? {};
};

export const getLoggerConfig = (): Readonly<LoggerConfig> => {
	return CONFIG;
};

export const log = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
	if (!CONFIG.enabled) {return;}
	if (!shouldLogLevel(level)) {return;}

	const ts = new Date().toISOString();
	const ctx = getLogContext();
	const callsite = getCallsite();

	if (CONFIG.format === "json") {
		const payload: Record<string, unknown> = {
			ts,
			level,
			msg: message,
			...ctx,
			...(callsite ? { callsite } : {}),
			...(fields ?? {}),
		};
		writeLine(safeStringify(payload));
		return;
	}

	const parts: string[] = [`[${ts}]`, level.toUpperCase()];
	if (ctx.traceId) {parts.push(`trace=${ctx.traceId}`);}
	if (ctx.tool) {parts.push(`tool=${ctx.tool}`);}
	if (ctx.device) {parts.push(`device=${ctx.device}`);}
	if (ctx.client) {parts.push(`client=${ctx.client}`);}
	if (callsite) {parts.push(`@${callsite}`);}

	let suffix = "";
	if (fields && Object.keys(fields).length > 0) {
		const encoded = serializeValue(fields);
		suffix = " " + encoded.text;
	}

	writeLine(parts.join(" ") + " " + message + suffix);
};

export const trace = (message: string, fields?: Record<string, unknown>) => log("trace", message, fields);
export const debug = (message: string, fields?: Record<string, unknown>) => log("debug", message, fields);
export const info = (message: string, fields?: Record<string, unknown>) => log("info", message, fields);
export const warn = (message: string, fields?: Record<string, unknown>) => log("warn", message, fields);
export const error = (message: string, fields?: Record<string, unknown>) => log("error", message, fields);

export const logValue = (value: unknown): string => {
	return serializeValue(value).text;
};

export const shouldLogCommands = (): boolean => CONFIG.enableCommands;
export const shouldLogHttp = (): boolean => CONFIG.enableHttp;
export const shouldLogMcp = (): boolean => CONFIG.enableMcp;
export const shouldLogData = (): boolean => CONFIG.enableData;
export const shouldLogMcpRaw = (): boolean => CONFIG.enableMcpRaw;
