#!/usr/bin/env node
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, getAgentVersion } from "./server";
import { error, info, shouldLogData, shouldLogMcp, shouldLogMcpRaw } from "./logger";
import express from "express";
import { program } from "commander";

const instrumentTransport = (transport: any) => {
	if (!shouldLogMcp() && !shouldLogMcpRaw()) {return;}

	const prevOnMessage = transport.onmessage?.bind(transport);
	transport.onmessage = (message: any) => {
		const method = message?.method;
		const id = message?.id;
		const intent = method ? `收到 MCP 请求: ${method}` : (id !== undefined ? `收到 MCP 响应: id=${id}` : "收到 MCP 消息");
		info("mcp.in", {
			intent,
			cmd: method ? `mcp ${method}` : (id !== undefined ? `mcp response ${id}` : "mcp message"),
			mcpMethod: method,
			mcpId: id,
			payload: (shouldLogMcpRaw() && shouldLogData())
				? message
				: { jsonrpc: message?.jsonrpc, method, id },
		});
		prevOnMessage?.(message);
	};

	const prevSend = transport.send?.bind(transport);
	if (prevSend) {
		transport.send = async (message: any) => {
			const method = message?.method;
			const id = message?.id;
			const intent = method ? `发送 MCP 通知: ${method}` : (id !== undefined ? `发送 MCP 响应: id=${id}` : "发送 MCP 消息");
			info("mcp.out", {
				intent,
				cmd: method ? `mcp ${method}` : (id !== undefined ? `mcp response ${id}` : "mcp message"),
				mcpMethod: method,
				mcpId: id,
				payload: (shouldLogMcpRaw() && shouldLogData())
					? message
					: { jsonrpc: message?.jsonrpc, method, id },
			});
			return await prevSend(message);
		};
	}
};

const startSseServer = async (port: number) => {
	const app = express();
	const server = createMcpServer();

	let transport: SSEServerTransport | null = null;

	app.post("/mcp", (req, res) => {
		if (transport) {
			transport.handlePostMessage(req, res);
		}
	});

	app.get("/mcp", (req, res) => {
		if (transport) {
			transport.close();
		}

		transport = new SSEServerTransport("/mcp", res);
		instrumentTransport(transport);
		server.connect(transport);
	});

	app.listen(port, () => {
		info("server.listen", { intent: "启动 SSE MCP 服务", port, url: `http://localhost:${port}/mcp` });
	});
};

const startStdioServer = async () => {
	try {
		const transport = new StdioServerTransport();

		const server = createMcpServer();
		await server.connect(transport);
		instrumentTransport(transport);

		info("server.listen", { intent: "启动 stdio MCP 服务" });
	} catch (err: any) {
		console.error("Fatal error in main():", err);
		error("Fatal error in main(): " + JSON.stringify(err.stack));
		process.exit(1);
	}
};

const main = async () => {
	program
		.version(getAgentVersion())
		.option("--port <port>", "Start SSE server on this port")
		.option("--stdio", "Start stdio server (default)")
		.parse(process.argv);

	const options = program.opts();

	if (options.port) {
		await startSseServer(+options.port);
	} else {
		await startStdioServer();
	}
};

main().then();
