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

const LEVEL_LABELS: Record<LogLevel, string> = {
	trace: "追踪",
	debug: "调试",
	info: "信息",
	warn: "警告",
	error: "错误",
};

const EVENT_LABELS: Record<string, string> = {
	"command.start": "命令开始",
	"command.ok": "命令完成",
	"command.err": "命令失败",
	"command.spawn": "启动子进程",
	"command.spawned": "子进程已启动",
	"command.exit": "子进程已退出",
	"command.error": "子进程异常",
	"http.start": "HTTP 请求开始",
	"http.ok": "HTTP 请求完成",
	"http.err": "HTTP 请求失败",
	"tool.start": "工具开始执行",
	"tool.ok": "工具执行完成",
	"tool.actionable_error": "工具可处理错误",
	"tool.exception": "工具异常",
	"mcp.in": "MCP 入站消息",
	"mcp.out": "MCP 出站消息",
	"server.listen": "服务已启动",
};

const JSON_FIELD_LABELS: Record<string, string> = {
	ts: "时间",
	level: "级别",
	event: "事件",
	intent: "意图",
	cmd: "命令行",
	label: "标签",
	traceId: "追踪ID",
	tool: "工具",
	device: "设备",
	client: "客户端",
	callsite: "调用位置",
	cwd: "工作目录",
	durationMs: "耗时_ms",
	stdout: "标准输出",
	stderr: "错误输出",
	stdoutBytes: "标准输出字节数",
	stderrBytes: "错误输出字节数",
	requestBody: "请求",
	responseBody: "回复",
	reply: "回复",
	httpMethod: "请求方法",
	httpUrl: "请求地址",
	httpStatus: "HTTP状态码",
	code: "退出码",
	status: "状态",
	error: "错误",
	message: "消息",
	stack: "堆栈",
	pid: "进程ID",
	signal: "信号",
	payload: "载荷",
	port: "端口",
	url: "地址",
	mcpMethod: "MCP方法",
	mcpId: "MCP请求ID",
	mcpRequestId: "MCP原始请求ID",
	title: "标题",
	description: "描述",
	args: "参数",
	resultBytes: "结果字节数",
	bytes: "字节数",
	sha256: "SHA256",
	details: "详情",
};

const JSON_FIELD_ORDER = [
	"时间",
	"级别",
	"意图",
	"命令行",
	"事件",
	"请求方法",
	"请求地址",
	"HTTP状态码",
	"回复",
	"耗时_ms",
	"错误",
	"消息",
	"状态",
	"退出码",
	"标签",
	"工具",
	"设备",
	"客户端",
	"追踪ID",
	"工作目录",
	"MCP方法",
	"MCP请求ID",
	"MCP原始请求ID",
	"端口",
	"地址",
	"标题",
	"描述",
	"参数",
	"载荷",
	"结果字节数",
	"标准输出",
	"错误输出",
	"标准输出字节数",
	"错误输出字节数",
	"字节数",
	"SHA256",
	"进程ID",
	"信号",
	"调用位置",
	"堆栈",
	"详情",
];

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

const translateJsonFieldName = (key: string): string => {
	return JSON_FIELD_LABELS[key] ?? key;
};

const translateJsonValue = (key: string, value: unknown): unknown => {
	if (key === "level" && typeof value === "string") {
		return LEVEL_LABELS[value as LogLevel] ?? value;
	}
	if (key === "event" && typeof value === "string") {
		return EVENT_LABELS[value] ?? value;
	}
	if (Array.isArray(value)) {
		return value.map(item => translateJsonValue(key, item));
	}
	if (value && typeof value === "object") {
		return translateJsonObject(value as Record<string, unknown>);
	}
	return value;
};

const translateJsonObject = (value: Record<string, unknown>): Record<string, unknown> => {
	const translated: Record<string, unknown> = {};
	for (const [key, fieldValue] of Object.entries(value)) {
		if (fieldValue === undefined) {continue;}
		translated[translateJsonFieldName(key)] = translateJsonValue(key, fieldValue);
	}
	return translated;
};

const orderJsonObject = (value: Record<string, unknown>): Record<string, unknown> => {
	const ordered: Record<string, unknown> = {};
	for (const key of JSON_FIELD_ORDER) {
		if (Object.prototype.hasOwnProperty.call(value, key)) {
			ordered[key] = value[key];
		}
	}
	for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))) {
		if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
			ordered[key] = value[key];
		}
	}
	return ordered;
};

const orderJsonObjectDeep = (value: unknown, isRoot = false): unknown => {
	if (Array.isArray(value)) {
		return value.map(v => orderJsonObjectDeep(v, false));
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = isRoot
			? Object.keys(obj)
			: Object.keys(obj).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));

		const ordered: Record<string, unknown> = {};
		for (const key of keys) {
			ordered[key] = orderJsonObjectDeep(obj[key], false);
		}
		return ordered;
	}
	return value;
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
		const {
			intent,
			cmd,
			stdout,
			stderr,
			stdoutBytes,
			stderrBytes,
			httpMethod,
			httpUrl,
			httpStatus,
			durationMs,
			requestBody,
			responseBody,
			reply: explicitReply,
			payload: payloadObj,
			resultBytes,
			bytes,
			sha256,
			...rest
		} = (fields ?? {}) as Record<string, unknown>;

		const commandLine = (typeof cmd === "string" && cmd)
			? cmd
			: (typeof httpMethod === "string" && typeof httpUrl === "string" ? `HTTP ${httpMethod} ${httpUrl}` : undefined);

		const replyFromCommand = (() => {
			if (stdout === undefined && stderr === undefined) {return undefined;}
			const r: Record<string, unknown> = {};
			if (stdout !== undefined) {r.stdout = stdout;}
			if (stderr !== undefined) {r.stderr = stderr;}
			return r;
		})();

		const replyFromBytes = (() => {
			if (stdoutBytes === undefined && stderrBytes === undefined && resultBytes === undefined && bytes === undefined && sha256 === undefined) {return undefined;}
			const r: Record<string, unknown> = {};
			if (stdoutBytes !== undefined) {r.stdoutBytes = stdoutBytes;}
			if (stderrBytes !== undefined) {r.stderrBytes = stderrBytes;}
			if (resultBytes !== undefined) {r.resultBytes = resultBytes;}
			if (bytes !== undefined) {r.bytes = bytes;}
			if (sha256 !== undefined) {r.sha256 = sha256;}
			return r;
		})();

		const reply = responseBody ?? explicitReply ?? replyFromCommand ?? replyFromBytes;
		const resolvedIntent = (typeof intent === "string" && intent)
			? intent
			: (typeof commandLine === "string" && commandLine ? "执行命令" : undefined);

		const details: Record<string, unknown> = {
			requestBody,
			responseBody,
			stdout,
			stderr,
			stdoutBytes,
			stderrBytes,
			payload: payloadObj,
			resultBytes,
			bytes,
			sha256,
			...rest,
		};

		const payload: Record<string, unknown> = {
			ts,
			level,
			intent: resolvedIntent,
			cmd: commandLine,
			event: message,
			reply,
			httpMethod,
			httpUrl,
			httpStatus,
			durationMs,
			traceId: ctx.traceId,
			tool: ctx.tool,
			device: ctx.device,
			client: ctx.client,
			details: Object.keys(details).some(k => details[k] !== undefined) ? details : undefined,
			...(callsite ? { callsite } : {}),
		};
		const translatedPayload = orderJsonObject(translateJsonObject(payload));
		const deepOrdered = orderJsonObjectDeep(translatedPayload, true) as Record<string, unknown>;
		writeLine(JSON.stringify(deepOrdered));
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
