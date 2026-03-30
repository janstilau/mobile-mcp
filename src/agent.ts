#!/usr/bin/env node
import "dotenv/config";
import OpenAI from "openai";
import { program } from "commander";
import fs from "node:fs";

import { Robot } from "./robot";
import { getRobotFromDevice, listAvailableDevices } from "./device-manager";
import { PNG } from "./png";
import { isScalingAvailable, Image } from "./image-utils";
import { trace } from "./logger";

interface AgentConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	device: string;
	task: string;
	maxSteps: number;
	systemPrompt?: string;
}

type ToolResult =
	| { type: "text"; text: string }
	| { type: "image"; text: string; imageBase64: string; mimeType: string };

const DEFAULT_SYSTEM_PROMPT = `You are a mobile app testing agent. You control a mobile device and perform automated testing tasks.

Testing guidelines:
1. Start by understanding what's on screen using list_elements_on_screen or take_screenshot.
2. Use list_elements_on_screen to find element coordinates before tapping.
3. After each action, verify the result by checking the screen.
4. Take screenshots when you need to visually verify the UI.
5. When typing text, first tap on the input field to focus it.
6. Report your findings clearly when done.

When you have completed the task or cannot proceed further, provide a clear test results summary.`;

const TOOLS: OpenAI.ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			name: "list_apps",
			description: "List all installed apps on the device",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "launch_app",
			description: "Launch an app on the device",
			parameters: {
				type: "object",
				properties: {
					packageName: { type: "string", description: "Package name (Android) or bundle ID (iOS)" },
				},
				required: ["packageName"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "terminate_app",
			description: "Stop and terminate an app on the device",
			parameters: {
				type: "object",
				properties: {
					packageName: { type: "string", description: "Package name or bundle ID of the app" },
				},
				required: ["packageName"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_screen_size",
			description: "Get the screen size of the device in pixels",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "tap",
			description: "Tap on the screen at given x,y coordinates",
			parameters: {
				type: "object",
				properties: {
					x: { type: "number", description: "The x coordinate in pixels" },
					y: { type: "number", description: "The y coordinate in pixels" },
				},
				required: ["x", "y"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "double_tap",
			description: "Double-tap on the screen at given x,y coordinates",
			parameters: {
				type: "object",
				properties: {
					x: { type: "number", description: "The x coordinate in pixels" },
					y: { type: "number", description: "The y coordinate in pixels" },
				},
				required: ["x", "y"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "long_press",
			description: "Long press on the screen at given x,y coordinates",
			parameters: {
				type: "object",
				properties: {
					x: { type: "number", description: "The x coordinate in pixels" },
					y: { type: "number", description: "The y coordinate in pixels" },
					duration: { type: "number", description: "Duration in milliseconds (default 500)" },
				},
				required: ["x", "y"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_elements_on_screen",
			description: "List all UI elements on screen with their coordinates, text, and accessibility labels. Use this to find tap targets.",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "press_button",
			description: "Press a hardware button on the device",
			parameters: {
				type: "object",
				properties: {
					button: {
						type: "string",
						enum: ["HOME", "BACK", "VOLUME_UP", "VOLUME_DOWN", "ENTER"],
						description: "The button to press. BACK is Android only.",
					},
				},
				required: ["button"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "open_url",
			description: "Open a URL in the device browser",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "The URL to open" },
				},
				required: ["url"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "swipe",
			description: "Swipe on the screen in a direction",
			parameters: {
				type: "object",
				properties: {
					direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction" },
					x: { type: "number", description: "Starting x coordinate (optional, defaults to center)" },
					y: { type: "number", description: "Starting y coordinate (optional, defaults to center)" },
					distance: { type: "number", description: "Swipe distance in pixels (optional)" },
				},
				required: ["direction"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "type_text",
			description: "Type text into the currently focused input field",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "The text to type" },
					submit: { type: "boolean", description: "Whether to press Enter after typing (default false)" },
				},
				required: ["text"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "take_screenshot",
			description: "Take a screenshot of the device screen. The image will be provided to you for visual analysis.",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "set_orientation",
			description: "Change the screen orientation",
			parameters: {
				type: "object",
				properties: {
					orientation: { type: "string", enum: ["portrait", "landscape"], description: "Desired orientation" },
				},
				required: ["orientation"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "get_orientation",
			description: "Get the current screen orientation",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			name: "install_app",
			description: "Install an app on the device from a file path",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Path to the app file (.apk for Android, .app/.ipa for iOS)" },
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "uninstall_app",
			description: "Uninstall an app from the device",
			parameters: {
				type: "object",
				properties: {
					bundleId: { type: "string", description: "Bundle ID or package name of the app" },
				},
				required: ["bundleId"],
			},
		},
	},
];

async function executeTool(robot: Robot, name: string, args: any): Promise<ToolResult> {
	switch (name) {
		case "list_apps": {
			const apps = await robot.listApps();
			return { type: "text", text: `Installed apps: ${apps.map(a => `${a.appName} (${a.packageName})`).join(", ")}` };
		}
		case "launch_app": {
			await robot.launchApp(args.packageName);
			return { type: "text", text: `Launched app ${args.packageName}` };
		}
		case "terminate_app": {
			await robot.terminateApp(args.packageName);
			return { type: "text", text: `Terminated app ${args.packageName}` };
		}
		case "get_screen_size": {
			const size = await robot.getScreenSize();
			return { type: "text", text: `Screen size: ${size.width}x${size.height} pixels (scale: ${size.scale})` };
		}
		case "tap": {
			await robot.tap(args.x, args.y);
			return { type: "text", text: `Tapped at (${args.x}, ${args.y})` };
		}
		case "double_tap": {
			await robot.doubleTap(args.x, args.y);
			return { type: "text", text: `Double-tapped at (${args.x}, ${args.y})` };
		}
		case "long_press": {
			const duration = args.duration ?? 500;
			await robot.longPress(args.x, args.y, duration);
			return { type: "text", text: `Long pressed at (${args.x}, ${args.y}) for ${duration}ms` };
		}
		case "list_elements_on_screen": {
			const elements = await robot.getElementsOnScreen();
			const result = elements.map(el => ({
				type: el.type,
				text: el.text,
				label: el.label,
				name: el.name,
				value: el.value,
				identifier: el.identifier,
				coordinates: { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height },
				...(el.focused ? { focused: true } : {}),
			}));
			return { type: "text", text: `Elements on screen: ${JSON.stringify(result)}` };
		}
		case "press_button": {
			await robot.pressButton(args.button);
			return { type: "text", text: `Pressed button: ${args.button}` };
		}
		case "open_url": {
			await robot.openUrl(args.url);
			return { type: "text", text: `Opened URL: ${args.url}` };
		}
		case "swipe": {
			if (args.x !== undefined && args.y !== undefined) {
				await robot.swipeFromCoordinate(args.x, args.y, args.direction, args.distance);
				return { type: "text", text: `Swiped ${args.direction} from (${args.x}, ${args.y})` };
			}
			await robot.swipe(args.direction);
			return { type: "text", text: `Swiped ${args.direction}` };
		}
		case "type_text": {
			await robot.sendKeys(args.text);
			if (args.submit) {
				await robot.pressButton("ENTER");
			}
			return { type: "text", text: `Typed: "${args.text}"${args.submit ? " and submitted" : ""}` };
		}
		case "take_screenshot": {
			let screenshot = await robot.getScreenshot();
			let mimeType = "image/png";

			const png = new PNG(screenshot);
			const pngSize = png.getDimensions();

			if (isScalingAvailable()) {
				const screenSize = await robot.getScreenSize();
				const img = Image.fromBuffer(screenshot);
				screenshot = img
					.resize(Math.floor(pngSize.width / screenSize.scale))
					.jpeg({ quality: 75 })
					.toBuffer();
				mimeType = "image/jpeg";
			}

			return {
				type: "image",
				text: `Screenshot taken (${pngSize.width}x${pngSize.height})`,
				imageBase64: screenshot.toString("base64"),
				mimeType,
			};
		}
		case "set_orientation": {
			await robot.setOrientation(args.orientation);
			return { type: "text", text: `Set orientation to ${args.orientation}` };
		}
		case "get_orientation": {
			const orientation = await robot.getOrientation();
			return { type: "text", text: `Current orientation: ${orientation}` };
		}
		case "install_app": {
			await robot.installApp(args.path);
			return { type: "text", text: `Installed app from ${args.path}` };
		}
		case "uninstall_app": {
			await robot.uninstallApp(args.bundleId);
			return { type: "text", text: `Uninstalled app ${args.bundleId}` };
		}
		default:
			return { type: "text", text: `Unknown tool: ${name}` };
	}
}

async function runAgent(config: AgentConfig): Promise<void> {
	const client = new OpenAI({
		baseURL: config.baseUrl,
		apiKey: config.apiKey,
	});

	console.log(`\nConnecting to device: ${config.device}`);
	const robot = getRobotFromDevice(config.device);
	console.log(`Device connected\n`);

	console.log(`Model: ${config.model}`);
	console.log(`Task: ${config.task}`);
	console.log(`Max steps: ${config.maxSteps}\n`);

	const messages: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
		{ role: "user", content: config.task },
	];

	for (let step = 1; step <= config.maxSteps; step++) {
		console.log(`--- Step ${step}/${config.maxSteps} ---`);

		const response = await client.chat.completions.create({
			model: config.model,
			messages,
			tools: TOOLS,
			temperature: 0,
		});

		const choice = response.choices[0];
		const message = choice.message;

		messages.push(message);

		if (message.content) {
			trace(`Assistant: ${message.content}`);
		}

		if (!message.tool_calls || message.tool_calls.length === 0) {
			console.log(`\nAgent completed:`);
			console.log(message.content || "(no response)");
			return;
		}

		const pendingScreenshots: { mimeType: string; data: string }[] = [];

		for (const toolCall of message.tool_calls) {
			if (toolCall.type !== "function") continue;
			const fnName = toolCall.function.name;
			let fnArgs: any = {};
			try {
				fnArgs = JSON.parse(toolCall.function.arguments);
			} catch (e) {
				// LLM may send empty or malformed args
			}

			console.log(`  [tool] ${fnName}(${JSON.stringify(fnArgs)})`);

			try {
				const result = await executeTool(robot, fnName, fnArgs);
				console.log(`       -> ${result.text}`);

				messages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					content: result.text,
				});

				if (result.type === "image") {
					pendingScreenshots.push({
						mimeType: result.mimeType,
						data: result.imageBase64,
					});
				}
			} catch (err: any) {
				const errorMsg = `Error: ${err.message}`;
				console.log(`       -> [ERROR] ${errorMsg}`);
				messages.push({
					role: "tool",
					tool_call_id: toolCall.id,
					content: errorMsg,
				});
			}
		}

		if (pendingScreenshots.length > 0) {
			messages.push({
				role: "user",
				content: pendingScreenshots.map(s => ({
					type: "image_url" as const,
					image_url: { url: `data:${s.mimeType};base64,${s.data}` },
				})),
			});
		}
	}

	console.log(`\nReached maximum steps (${config.maxSteps}). Agent stopped.`);
}

const main = async () => {
	program
		.name("mobile-mcp-agent")
		.description("Autonomous mobile testing agent powered by LLM")
		.option("--device <id>", "Device identifier")
		.option("--task <task>", "Test task description")
		.option("--task-file <path>", "Read task description from a file")
		.option("--max-steps <n>", "Maximum execution steps", "50")
		.option("--system-prompt <path>", "Path to a custom system prompt file")
		.option("--list-devices", "List available devices and exit")
		.parse(process.argv);

	const opts = program.opts();

	if (opts.listDevices) {
		try {
			const devices = listAvailableDevices();
			if (devices.length === 0) {
				console.log("No devices found.");
			} else {
				console.log("Available devices:\n");
				for (const d of devices) {
					console.log(`  ${d.id}\t${d.name}\t(${d.platform} ${d.type}, v${d.version})`);
				}
			}
		} catch (err: any) {
			console.error(`Failed to list devices: ${err.message}`);
		}
		return;
	}

	const baseUrl = process.env.LLM_BASE_URL;
	const apiKey = process.env.LLM_API_KEY;
	const model = process.env.LLM_MODEL;

	if (!baseUrl || !apiKey || !model) {
		console.error("Missing environment variables. Please create a .env file with:");
		console.error("  LLM_BASE_URL=https://api.openai.com/v1");
		console.error("  LLM_API_KEY=sk-xxx");
		console.error("  LLM_MODEL=gpt-4o");
		console.error("\nSee .env.example for reference.");
		process.exit(1);
	}

	if (!opts.device) {
		console.error("Error: --device is required. Use --list-devices to see available devices.");
		process.exit(1);
	}

	let task: string | undefined = opts.task;
	if (!task && opts.taskFile) {
		task = fs.readFileSync(opts.taskFile, "utf-8").trim();
	}
	if (!task) {
		console.error("Error: --task or --task-file is required.");
		process.exit(1);
	}

	let systemPrompt: string | undefined;
	if (opts.systemPrompt) {
		systemPrompt = fs.readFileSync(opts.systemPrompt, "utf-8");
	}

	await runAgent({
		baseUrl,
		apiKey,
		model,
		device: opts.device,
		task,
		maxSteps: parseInt(opts.maxSteps, 10),
		systemPrompt,
	});
};

main().catch(err => {
	console.error(`Fatal error: ${err.message}`);
	process.exit(1);
});
