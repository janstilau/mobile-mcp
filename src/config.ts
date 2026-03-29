import fs from "node:fs";
import path from "node:path";

export interface MobileMcpConfig {
	logging?: {
		enabled?: boolean;
		level?: "trace" | "debug" | "info" | "warn" | "error";
		format?: "text" | "json";
		outputs?: {
			file?: boolean;
			stderr?: boolean;
		};
		truncate?: {
			enabled?: boolean;
			maxChars?: number;
		};
		categories?: {
			commands?: boolean;
			http?: boolean;
			mcp?: boolean;
			mcpRaw?: boolean;
			data?: boolean;
			callsite?: boolean;
		};
		split?: {
			mode?: "time" | "trace" | "time+trace";
		};
		files?: {
			dir?: string;
			prefix?: string;
			rotateMinutes?: number;
			retainGlobalFiles?: number;
			retainTraceFiles?: number;
		};
	};
}

export const getDefaultConfigDir = (): string => {
	// Compiled output lives in lib/, so this resolves to repo root + /mobile-mcp
	return path.resolve(__dirname, "..", "mobile-mcp");
};

export const getDefaultConfigPath = (): string => {
	return path.join(getDefaultConfigDir(), "config.json");
};

export const loadMobileMcpConfig = (): MobileMcpConfig | null => {
	const configPath = process.env.MOBILE_MCP_CONFIG_PATH || getDefaultConfigPath();
	try {
		if (!fs.existsSync(configPath)) {
			return null;
		}
		const raw = fs.readFileSync(configPath, "utf8");
		return JSON.parse(raw) as MobileMcpConfig;
	} catch {
		return null;
	}
};
