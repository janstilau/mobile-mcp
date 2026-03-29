import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess, type ExecFileSyncOptions, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { debug, error, shouldLogCommands, shouldLogData, warn, logValue } from "./logger";

export interface CommandMeta {
	label?: string;
	intent?: string;
}

const argsToString = (command: string, args: string[]): string => {
	const escaped = args.map(a => (a.includes(" ") ? JSON.stringify(a) : a));
	return [command, ...escaped].join(" ");
};

const bufferDigest = (buffer: Buffer): { sha256: string; bytes: number } => {
	const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
	return { sha256, bytes: buffer.length };
};

export const execText = (command: string, args: string[], options?: ExecFileSyncOptions, meta?: CommandMeta): string => {
	const start = Date.now();
	const cmdLine = argsToString(command, args);
	const intent = meta?.intent;

	if (shouldLogCommands()) {
		debug("command.start", { intent, label: meta?.label, cmd: cmdLine, cwd: options?.cwd });
	}

	try {
		const stdout = execFileSync(command, args, { ...options, encoding: "utf8" }).toString();
		const durationMs = Date.now() - start;

		if (shouldLogCommands()) {
			const dataFields = shouldLogData() ? { stdout: logValue(stdout) } : { stdoutBytes: Buffer.byteLength(stdout, "utf8") };
			debug("command.ok", { intent, label: meta?.label, cmd: cmdLine, durationMs, ...dataFields });
		}

		return stdout;
	} catch (err: any) {
		const durationMs = Date.now() - start;
		const stdout = err?.stdout ? err.stdout.toString() : "";
		const stderr = err?.stderr ? err.stderr.toString() : "";
		const code = err?.status ?? err?.code;

		if (shouldLogCommands()) {
			const dataFields = shouldLogData()
				? { stdout: logValue(stdout), stderr: logValue(stderr) }
				: { stdoutBytes: Buffer.byteLength(stdout, "utf8"), stderrBytes: Buffer.byteLength(stderr, "utf8") };
			error("command.err", { intent, label: meta?.label, cmd: cmdLine, durationMs, code, ...dataFields });
		}

		throw err;
	}
};

export const execBuffer = (command: string, args: string[], options?: ExecFileSyncOptions, meta?: CommandMeta): Buffer => {
	const start = Date.now();
	const cmdLine = argsToString(command, args);
	const intent = meta?.intent;

	if (shouldLogCommands()) {
		debug("command.start", { intent, label: meta?.label, cmd: cmdLine, cwd: options?.cwd });
	}

	try {
		const stdout = execFileSync(command, args, { ...options, encoding: "buffer" }) as Buffer;
		const durationMs = Date.now() - start;

		if (shouldLogCommands()) {
			const digest = bufferDigest(stdout);
			debug("command.ok", { intent, label: meta?.label, cmd: cmdLine, durationMs, ...digest });
		}

		return stdout;
	} catch (err: any) {
		const durationMs = Date.now() - start;
		const stdout: Buffer | undefined = Buffer.isBuffer(err?.stdout) ? err.stdout : (err?.stdout ? Buffer.from(err.stdout) : undefined);
		const stderr: Buffer | undefined = Buffer.isBuffer(err?.stderr) ? err.stderr : (err?.stderr ? Buffer.from(err.stderr) : undefined);
		const code = err?.status ?? err?.code;

		if (shouldLogCommands()) {
			const payload: Record<string, unknown> = { intent, label: meta?.label, cmd: cmdLine, durationMs, code };
			if (stdout) {Object.assign(payload, { stdout: shouldLogData() ? logValue(stdout.toString("base64")) : bufferDigest(stdout) });}
			if (stderr) {Object.assign(payload, { stderr: shouldLogData() ? logValue(stderr.toString("utf8")) : { bytes: stderr.length } });}
			error("command.err", payload);
		}

		throw err;
	}
};

export const spawnLogged = (command: string, args: string[], options?: SpawnOptions, meta?: CommandMeta): ChildProcess => {
	const cmdLine = argsToString(command, args);
	const intent = meta?.intent;
	if (shouldLogCommands()) {
		debug("command.spawn", { intent, label: meta?.label, cmd: cmdLine, cwd: options?.cwd });
	}

	const child = spawn(command, args, (options ?? {}) as SpawnOptions) as unknown as ChildProcess;

	if (shouldLogCommands()) {
		child.on("spawn", () => debug("command.spawned", { intent, label: meta?.label, cmd: cmdLine, pid: child.pid }));
		child.on("error", (e: any) => error("command.error", { intent, label: meta?.label, cmd: cmdLine, error: e?.message ?? String(e) }));
		child.on("exit", (code: number | null, signal: NodeJS.Signals | null) =>
			debug("command.exit", { intent, label: meta?.label, cmd: cmdLine, pid: child.pid, code, signal })
		);
	}

	return child;
};

export const spawnSyncLogged = (command: string, args: string[], options?: SpawnSyncOptions, meta?: CommandMeta): ReturnType<typeof spawnSync> => {
	const start = Date.now();
	const cmdLine = argsToString(command, args);
	const intent = meta?.intent;

	if (shouldLogCommands()) {
		debug("command.start", { intent, label: meta?.label, cmd: cmdLine, cwd: options?.cwd });
	}

	const result = spawnSync(command, args, options);
	const durationMs = Date.now() - start;

	if (shouldLogCommands()) {
		const status = result.status;
		const stderr = result.stderr ? (Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr)) : "";
		const stdout = result.stdout ? (Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout)) : "";
		const fields: Record<string, unknown> = { intent, label: meta?.label, cmd: cmdLine, durationMs, status };
		if (shouldLogData()) {
			Object.assign(fields, { stdout: logValue(stdout), stderr: logValue(stderr) });
		} else {
			Object.assign(fields, { stdoutBytes: Buffer.byteLength(stdout, "utf8"), stderrBytes: Buffer.byteLength(stderr, "utf8") });
		}

		if (status === 0 || status === null) {
			debug("command.ok", fields);
		} else {
			warn("command.err", fields);
		}
	}

	return result;
};
