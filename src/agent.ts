#!/usr/bin/env node
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";

// 优先加载项目根目录下的 .env，未找到时再尝试安装包同级目录
for (const envPath of [path.resolve(process.cwd(), ".env"), path.resolve(__dirname, "..", ".env")]) {
	if (!fs.existsSync(envPath)) {
		continue;
	}
	const parsed = dotenv.parse(fs.readFileSync(envPath));
	for (const [key, value] of Object.entries(parsed)) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
	break;
}

import OpenAI from "openai";
import { program } from "commander";

import { Robot } from "./robot";
import { getRobotFromDevice, listAvailableDevices } from "./device-manager";
import { PNG } from "./png";
import { isScalingAvailable, Image } from "./image-utils";
import { trace } from "./logger";

/**
 * Agent 配置接口
 * - baseUrl: LLM API 的基础 URL（如 https://api.openai.com/v1）
 * - apiKey: 访问 LLM 的密钥
 * - model: 使用的模型名称（如 gpt-4o）
 * - device: 目标设备标识符
 * - task: 要执行的测试任务描述
 * - maxSteps: 最大执行步数，防止无限循环
 * - systemPrompt: 可选的自定义系统提示词
 */
interface AgentConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
	device: string;
	task: string;
	maxSteps: number;
	systemPrompt?: string;
}

/**
 * 工具执行结果的联合类型
 * - text 类型：纯文本结果
 * - image 类型：包含文字描述和 Base64 编码图像数据的截图结果
 */
type ToolResult =
	| { type: "text"; text: string }
	| { type: "image"; text: string; imageBase64: string; mimeType: string };

function extractTaggedNumber(raw: string, key: string): number | null {
	const pattern = new RegExp(`<arg_key>\\s*${key}\\s*</arg_key>\\s*<arg_value>\\s*(-?\\d+(?:\\.\\d+)?)`, "i");
	const match = raw.match(pattern);
	if (!match) {
		return null;
	}
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

function extractFirstNumber(raw: string): number | null {
	const match = raw.match(/-?\d+(?:\.\d+)?/);
	if (!match) {
		return null;
	}
	const value = Number(match[0]);
	return Number.isFinite(value) ? value : null;
}

function coerceNumericArg(rawValue: unknown, key: string, allArgs: Record<string, unknown>): number | null {
	if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
		return rawValue;
	}

	if (typeof rawValue === "string") {
		const tagged = extractTaggedNumber(rawValue, key);
		if (tagged !== null) {
			return tagged;
		}
		const first = extractFirstNumber(rawValue);
		if (first !== null) {
			return first;
		}
	}

	if (rawValue !== undefined && rawValue !== null) {
		const coerced = Number(rawValue);
		if (Number.isFinite(coerced)) {
			return coerced;
		}
	}

	const serializedArgs = JSON.stringify(allArgs ?? {});
	const taggedFromPayload = extractTaggedNumber(serializedArgs, key);
	return taggedFromPayload !== null ? taggedFromPayload : null;
}

function requiredCoordinateArgs(args: Record<string, unknown>, toolName: string): { x: number; y: number } {
	const x = coerceNumericArg(args.x, "x", args);
	const y = coerceNumericArg(args.y, "y", args);
	if (x === null || y === null) {
		throw new Error(`Invalid ${toolName} coordinates: ${JSON.stringify(args)}. Use numeric x/y or call list_elements_on_screen first.`);
	}
	return { x, y };
}

const DEFAULT_SYSTEM_PROMPT = `You are a mobile app end-to-end testing agent. You execute test tasks on a real device and report structured findings based strictly on observed screen evidence.

## Role
Single-layer test agent: you plan, execute, observe, and judge — all in one loop.
You do NOT fix bugs. You do NOT guess what should happen. You only report what you see.

## Tool Usage Policy
- Prefer listing screen elements (accessibility tree) over taking screenshots for locating elements — it is faster and more reliable.
- Before any coordinate tap/long-press/double-tap, call list_elements_on_screen first and derive the element center from that output (unless coordinates were explicitly provided by the user).
- Use screenshots only when you need to visually verify UI rendering (layout, images, visual glitches).
- Always observe the screen after each action to verify the result before proceeding.

## Execution Rules
0. Start by observing the current screen state before taking any action.
1. One atomic action per step (one tap, one type, one swipe, one press — never combined).
2. After every action, observe the screen to verify the outcome before the next action.
3. Always focus an input field with a tap before typing.
4. If an element is not visible, scroll to find it. If still not found after one scroll, do not guess — report as BLOCK.
5. If an action produces no visible change, retry once. If still no change, stop and report.
6. If the screen is not on the expected page, navigate back first, confirm via observation, then continue.
7. Maximum retries per step: 1. Never loop indefinitely.

## Output Format
When the task is complete or cannot proceed further, output the final report below and do not call any more tools.

RESULT: <pass|fail|blocked>
STEPS_EXECUTED: <number>
BUGS:
  - [optional, repeat per bug] type=<CRASH|LOGIC|UI|PERF|BLOCK>; step=<step description>; expected=<what should happen>; actual=<what was observed on screen>; evidence=<exact visible text or element state>
SUMMARY: <one sentence — what was accomplished or why it stopped. Based only on observed screen state. No inference.>

Rules for RESULT:
- pass: all steps completed and all expected results were observed on screen.
- fail: at least one step's expected result did not match what was observed.
- blocked: could not proceed due to missing element, app crash, or unrecoverable state.

Rules for BUGS:
- Only report bugs grounded in observed screen evidence.
- Do not infer bugs from absence of information.
- If no bugs found, omit the BUGS section entirely.

Rules for SUMMARY:
- One sentence only.
- No subjective words like "successfully", "properly", "correctly" unless directly supported by visible evidence.`;

/**
 * 提供给 LLM 的工具（函数）定义列表
 * 每个工具对应设备上的一种操作能力，LLM 可以在对话中调用这些工具控制设备。
 * 工具遵循 OpenAI Function Calling 规范。
 */
const TOOLS: OpenAI.ChatCompletionTool[] = [
	{
		type: "function",
		function: {
			// 列出设备上所有已安装的应用
			name: "list_apps",
			description: "List all installed apps on the device",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			// 根据包名/Bundle ID 启动指定应用
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
			// 停止并终止指定应用进程
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
			// 获取设备屏幕分辨率（像素宽高及缩放比例）
			name: "get_screen_size",
			description: "Get the screen size of the device in pixels",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			// 在屏幕指定坐标处执行单次点击
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
			// 在屏幕指定坐标处执行双击操作
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
			// 在屏幕指定坐标处执行长按操作，可自定义持续时长（默认 500ms）
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
			// 获取当前屏幕上所有 UI 元素及其坐标、文本、无障碍标签等信息
			// 这是确定点击目标坐标的首选方式
			name: "list_elements_on_screen",
			description: "List all UI elements on screen with their coordinates, text, and accessibility labels. Use this to find tap targets.",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			// 模拟按下设备硬件按键：HOME、BACK（仅 Android）、音量键、回车键
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
			// 在设备默认浏览器中打开指定 URL
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
			// 在屏幕上执行滑动/滚动操作
			// 可指定起始坐标和滑动距离，不指定则从屏幕中心开始
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
			// 向当前聚焦的输入框输入文本，可选是否在输入后按回车提交
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
			// 截取设备屏幕截图，图像会以 Base64 格式返回给 LLM 进行视觉分析
			name: "take_screenshot",
			description: "Take a screenshot of the device screen. The image will be provided to you for visual analysis.",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			// 切换屏幕方向（竖屏/横屏）
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
			// 获取当前屏幕方向
			name: "get_orientation",
			description: "Get the current screen orientation",
			parameters: { type: "object", properties: {} },
		},
	},
	{
		type: "function",
		function: {
			// 从本地路径安装应用（Android 支持 .apk，iOS 支持 .app/.ipa）
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
			// 从设备上卸载指定应用
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

/**
 * 执行单个工具调用并返回结果
 * @param robot - 设备控制机器人实例
 * @param name - 工具名称
 * @param args - 工具参数（由 LLM 生成）
 * @returns ToolResult，包含文本描述，截图工具额外返回 Base64 图像数据
 */
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
			const normalizedArgs = (args && typeof args === "object") ? args as Record<string, unknown> : {};
			const { x, y } = requiredCoordinateArgs(normalizedArgs, "tap");
			await robot.tap(x, y);
			return { type: "text", text: `Tapped at (${x}, ${y})` };
		}
		case "double_tap": {
			const normalizedArgs = (args && typeof args === "object") ? args as Record<string, unknown> : {};
			const { x, y } = requiredCoordinateArgs(normalizedArgs, "double_tap");
			await robot.doubleTap(x, y);
			return { type: "text", text: `Double-tapped at (${x}, ${y})` };
		}
		case "long_press": {
			const normalizedArgs = (args && typeof args === "object") ? args as Record<string, unknown> : {};
			const { x, y } = requiredCoordinateArgs(normalizedArgs, "long_press");
			// 未提供 duration 时使用默认值 500ms
			const duration = coerceNumericArg(normalizedArgs.duration, "duration", normalizedArgs) ?? 500;
			await robot.longPress(x, y, duration);
			return { type: "text", text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
		}
		case "list_elements_on_screen": {
			const elements = await robot.getElementsOnScreen();
			// 将元素信息精简为 LLM 易于理解的格式，仅保留关键字段
			const result = elements.map(el => ({
				type: el.type,
				text: el.text,
				label: el.label,
				name: el.name,
				value: el.value,
				identifier: el.identifier,
				coordinates: { x: el.rect.x, y: el.rect.y, width: el.rect.width, height: el.rect.height },
				// 仅当元素处于聚焦状态时才包含 focused 字段，减少冗余信息
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
			const normalizedArgs = (args && typeof args === "object") ? args as Record<string, unknown> : {};
			// 如果提供了起始坐标，则从指定位置开始滑动；否则从屏幕中心滑动
			if (normalizedArgs.x !== undefined || normalizedArgs.y !== undefined) {
				const { x, y } = requiredCoordinateArgs(normalizedArgs, "swipe");
				const distance = coerceNumericArg(normalizedArgs.distance, "distance", normalizedArgs) ?? undefined;
				await robot.swipeFromCoordinate(x, y, args.direction, distance);
				return { type: "text", text: `Swiped ${args.direction} from (${x}, ${y})` };
			}
			await robot.swipe(args.direction);
			return { type: "text", text: `Swiped ${args.direction}` };
		}
		case "type_text": {
			await robot.sendKeys(args.text);
			// 如果设置了 submit 标志，则在输入后自动按回车键提交
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

			// 若系统支持图像缩放（sharp 库可用），则按设备像素比缩小截图并转为 JPEG
			// 目的：减小传输给 LLM 的图像体积，降低 token 消耗
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

/**
 * 将 TOOLS 数组转换为可读的文本描述，供文本模式下的系统提示词使用。
 * 因为部分模型不支持 OpenAI Function Calling，需要在提示词中手动描述工具。
 * @returns 格式化的工具说明字符串，每个工具包含名称、描述及参数列表
 */
function buildToolDescriptionsForPrompt(): string {
	return TOOLS.map(t => {
		const fn = (t as any).function;
		const params = fn.parameters as any;
		const paramList = params?.properties
			? Object.entries(params.properties).map(([name, schema]: [string, any]) => {
				const req = params.required?.includes(name) ? " (required)" : " (optional)";
				return `    - ${name}: ${schema.description || schema.type}${req}`;
			}).join("\n")
			: "    (no parameters)";
		return `- ${fn.name}: ${fn.description}\n${paramList}`;
	}).join("\n\n");
}

/**
 * 构建文本模式下的系统提示词。
 * 当模型不支持原生 Function Calling 时，Agent 会切换到文本模式：
 * 要求模型以特定的 JSON 代码块格式输出工具调用，再由 parseToolCallsFromText 解析执行。
 * @param basePrompt - 基础系统提示词（可选），不提供则使用默认提示词
 * @returns 包含工具说明和调用格式要求的完整系统提示词
 */
function buildTextModeSystemPrompt(basePrompt?: string): string {
	const toolDesc = buildToolDescriptionsForPrompt();
	return `${basePrompt || DEFAULT_SYSTEM_PROMPT}

## Available Tools

${toolDesc}

## How to Call Tools

To use a tool, you MUST respond with ONLY a JSON code block in this exact format:

\`\`\`json
{"tool": "tool_name", "args": {"param1": "value1"}}
\`\`\`

Rules:
- Call exactly ONE tool per response.
- Do NOT include any other text before or after the JSON block when calling a tool.
- Wait for the tool result before calling the next tool.
- When the task is complete, respond with your summary in plain text (no JSON block).`;
}

/**
 * 已解析的工具调用结构
 * - tool: 工具名称
 * - args: 工具参数，可能包含 __raw__ 字段（待进一步解析的原始文本参数）
 */
interface ParsedToolCall {
	tool: string;
	args: Record<string, any>;
}

/**
 * 动作别名映射表
 * 将用户在提示中可能使用的中英文自然语言动词映射到标准工具名称。
 * 支持中文输入（如"点击"→"tap"），增强了对中文指令的兼容性。
 */
const ACTION_ALIASES: Record<string, string> = {
	"launch": "launch_app", "open": "launch_app",
	"打开": "launch_app", "启动": "launch_app",
	"tap": "tap", "click": "tap",
	"点击": "tap", "单击": "tap",
	"double_tap": "double_tap", "doubletap": "double_tap",
	"双击": "double_tap",
	"long_press": "long_press", "longpress": "long_press", "long press": "long_press",
	"长按": "long_press",
	"swipe": "swipe", "scroll": "swipe", "fling": "swipe",
	"滑动": "swipe", "滚动": "swipe",
	"type": "type_text", "input": "type_text",
	"输入": "type_text", "键入": "type_text",
	"screenshot": "take_screenshot",
	"截图": "take_screenshot", "截屏": "take_screenshot",
	"back": "press_button", "home": "press_button",
	"返回": "press_button", "主页": "press_button",
};

/**
 * 滑动方向关键词映射表
 * 将中英文方向词统一映射为标准方向值（up/down/left/right）。
 */
const DIRECTION_KEYWORDS: Record<string, string> = {
	"up": "up", "down": "down", "left": "left", "right": "right",
	"上": "up", "下": "down", "左": "left", "右": "right",
	"向上": "up", "向下": "down", "向左": "left", "向右": "right",
};

/**
 * 从文本中提取所有顶层平衡括号的 JSON 对象字符串。
 * 与正则 [^{}]* 不同，此函数能正确处理嵌套对象（如 {"args":{"x":10}}）。
 */
function extractBalancedJsonObjects(text: string): string[] {
	const objects: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] !== "{") { i++; continue; }
		let depth = 0;
		let inString = false;
		let escaped = false;
		let j = i;
		while (j < text.length) {
			const c = text[j];
			if (escaped) { escaped = false; j++; continue; }
			if (c === "\\" && inString) { escaped = true; j++; continue; }
			if (c === "\"") { inString = !inString; j++; continue; }
			if (!inString) {
				if (c === "{") {
					depth++;
				} else if (c === "}") {
					depth--;
					if (depth === 0) { objects.push(text.slice(i, j + 1)); break; }
				}
			}
			j++;
		}
		i = j + 1;
	}
	return objects;
}

/**
 * 从 LLM 的文本输出中解析工具调用
 * 文本模式下 LLM 不使用原生 Function Calling，而是在响应中嵌入格式化的工具调用。
 * 本函数按优先级尝试三种解析策略：
 *
 * 策略1：标准 JSON 代码块（```json { "tool": ..., "args": ... } ```）
 *   - 同时支持 "Action: Parameter" 格式的代码块（兼容部分模型输出）
 *
 * 策略2：行内 JSON 对象（包含 "tool" 键的内联 JSON）
 *
 * 策略3：裸动词行（如 "点击: 确认按钮"，不包含代码块标记）
 *
 * @param text - LLM 的原始响应文本
 * @returns 解析出的工具调用列表（通常只取第一个执行）
 */
function parseToolCallsFromText(text: string): ParsedToolCall[] {
	const results: ParsedToolCall[] = [];

	// 策略1：提取代码块（``` 或 ```json）中的内容
	const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
	let match;
	while ((match = codeBlockRegex.exec(text)) !== null) {
		const content = match[1].trim();
		try {
			const parsed = JSON.parse(content);
			if (parsed.tool && typeof parsed.tool === "string") {
				results.push({ tool: parsed.tool, args: parsed.args || {} });
				continue;
			}
		} catch (e) { /* 不是 JSON，尝试下面的 Action 格式 */ }

		// 尝试代码块中的 "Action: Parameter" 或 "Action：Parameter" 格式
		const actionMatch = content.match(/^([^\s:：]+)\s*[:：]\s*(.*)$/s);
		if (actionMatch) {
			const actionKey = actionMatch[1].trim().toLowerCase();
			const mappedTool = ACTION_ALIASES[actionKey];
			if (mappedTool) {
				// __raw__ 表示参数尚未结构化，需要 resolveRawArgs 进一步处理
				results.push({ tool: mappedTool, args: { __raw__: actionMatch[2].trim() } });
			}
		}
	}

	if (results.length > 0) {return results;}

	// 策略2：扫描文本中所有平衡括号的 JSON 对象，支持嵌套（如 args:{x:10,y:20}）
	for (const candidate of extractBalancedJsonObjects(text)) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && parsed.tool && typeof parsed.tool === "string") {
				results.push({ tool: parsed.tool, args: parsed.args || {} });
			}
		} catch (e) { /* 忽略解析失败 */ }
	}

	if (results.length > 0) {return results;}

	// 策略3：匹配裸行中的 "动词: 参数" 格式（支持中英文）
	const lineRegex = /^([A-Za-z\u4e00-\u9fff]+)\s*[:：]\s*(.+)$/gm;
	while ((match = lineRegex.exec(text)) !== null) {
		const actionKey = match[1].trim().toLowerCase();
		const mappedTool = ACTION_ALIASES[actionKey];
		if (mappedTool) {
			results.push({ tool: mappedTool, args: { __raw__: match[2].trim() } });
		}
	}

	return results;
}

/**
 * 将原始文本参数（__raw__）解析为具体的工具参数对象。
 * 当模型以非结构化方式输出工具调用时（如 "点击: 确认"），
 * 本函数负责将自然语言参数转换为可直接传递给 robot 的结构化参数。
 *
 * @param robot - 设备控制机器人（用于查询屏幕元素等辅助操作）
 * @param toolName - 目标工具名称
 * @param rawParam - 原始文本参数
 * @returns 解析后的工具调用对象，解析失败时返回 null
 */
async function resolveRawArgs(
	robot: Robot,
	toolName: string,
	rawParam: string,
): Promise<{ tool: string; args: Record<string, any> } | null> {
	const trimmedParam = rawParam.trim();
	const isLikelyUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedParam);

	switch (toolName) {
		case "launch_app": {
			// "open: https://..." 这类文本动作应落到 open_url，而不是 launch_app
			if (isLikelyUrl) {
				return { tool: "open_url", args: { url: trimmedParam } };
			}

			// 优先通过应用名称在已安装列表中查找匹配的包名
			try {
				const apps = await robot.listApps();
				const app = apps.find(a =>
					a.appName === trimmedParam ||
					a.appName.includes(trimmedParam) ||
					a.packageName === trimmedParam
				);
				if (app) {return { tool: "launch_app", args: { packageName: app.packageName } };}
			} catch (e) { /* 查询失败时直接使用原始参数作为包名 */ }
			return { tool: "launch_app", args: { packageName: trimmedParam } };
		}
		case "tap": {
			// 先尝试解析坐标格式 "(x, y)" 或 "x,y"
			const coordMatch = rawParam.match(/\(?(\d+)\s*[,，]\s*(\d+)\)?/);
			if (coordMatch) {
				return { tool: "tap", args: { x: parseInt(coordMatch[1], 10), y: parseInt(coordMatch[2], 10) } };
			}
			// 坐标解析失败时，通过文本/标签在屏幕元素中查找目标元素的中心坐标
			try {
				const elements = await robot.getElementsOnScreen();
				const el = elements.find(e =>
					e.text === rawParam || e.label === rawParam || e.name === rawParam ||
					(e.text && e.text.includes(rawParam)) ||
					(e.label && e.label.includes(rawParam))
				);
				if (el) {
					// 计算元素中心坐标作为点击目标
					const x = Math.round(el.rect.x + el.rect.width / 2);
					const y = Math.round(el.rect.y + el.rect.height / 2);
					console.log(`       [resolve] "${rawParam}" -> element at (${x}, ${y})`);
					return { tool: "tap", args: { x, y } };
				}
			} catch (e) { /* 元素查找失败 */ }
			console.log(`       [resolve] Could not find element "${rawParam}" on screen`);
			return null;
		}
		case "double_tap": {
			// 仅支持坐标格式，不支持元素名称解析
			const coordMatch = rawParam.match(/\(?(\d+)\s*[,，]\s*(\d+)\)?/);
			if (coordMatch) {
				return { tool: "double_tap", args: { x: parseInt(coordMatch[1], 10), y: parseInt(coordMatch[2], 10) } };
			}
			return null;
		}
		case "swipe": {
			// 在原始参数中查找方向关键词（中英文均支持）
			for (const [keyword, dir] of Object.entries(DIRECTION_KEYWORDS)) {
				if (rawParam.includes(keyword)) {
					return { tool: "swipe", args: { direction: dir } };
				}
			}
			// 未找到方向关键词时，默认向下滑动
			return { tool: "swipe", args: { direction: "down" } };
		}
		case "type_text": {
			// 原始参数即为要输入的文本内容
			return { tool: "type_text", args: { text: rawParam } };
		}
		case "take_screenshot": {
			// 截图无需额外参数
			return { tool: "take_screenshot", args: {} };
		}
		case "press_button": {
			// 根据关键词判断按下 BACK 还是 HOME 键
			const lower = rawParam.toLowerCase();
			if (lower.includes("back") || lower.includes("返回")) {
				return { tool: "press_button", args: { button: "BACK" } };
			}
			return { tool: "press_button", args: { button: "HOME" } };
		}
		default:
			return { tool: toolName, args: {} };
	}
}

/**
 * 自动截取当前屏幕截图（辅助函数）
 * 用于在动作执行前后让 LLM 观察屏幕状态，失败时静默处理不影响主流程。
 *
 * @param robot - 设备控制机器人实例
 * @returns 截图数据对象，截图失败时返回 null
 */
async function captureScreenshot(robot: Robot): Promise<{ mimeType: string; data: string } | null> {
	try {
		const result = await executeTool(robot, "take_screenshot", {});
		if (result.type === "image") {
			return { mimeType: result.mimeType, data: result.imageBase64 };
		}
	} catch (e) {
		trace(`Auto-screenshot failed: ${e}`);
	}
	return null;
}

/**
 * Agent 主循环：驱动 LLM 与设备之间的交互直至任务完成或达到步数上限。
 *
 * 执行流程：
 * 1. 初始化 OpenAI 客户端和设备连接
 * 2. 构造初始消息（系统提示词 + 用户任务）
 * 3. 进入步骤循环：
 *    a. 调用 LLM 获取响应
 *    b. 若模型支持原生 Function Calling → 直接执行工具调用（原生模式）
 *    c. 若模型首次未使用 Function Calling → 切换到文本模式，重置对话并附上初始截图
 *    d. 文本模式下 → 解析 LLM 文本中的工具调用，执行后附上操作截图反馈给模型
 * 4. 连续多步无工具调用时判定任务完成，输出摘要
 *
 * @param config - Agent 运行配置
 */
async function runAgent(config: AgentConfig): Promise<void> {
	// 初始化 OpenAI 客户端（支持兼容 OpenAI 协议的第三方 API）
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

	let textMode = false;
	let nativeToolCallSucceeded = false;
	let consecutiveEmptySteps = 0;
	const MAX_EMPTY_STEPS = 3;

	// 用于检测重复动作，防止模型陷入无限循环（如无限 swipe left）
	const recentActions: string[] = [];
	const MAX_REPEATED_ACTION = 4;

	// 启动前先截图，让模型了解当前屏幕状态
	console.log(`  [init] Taking initial screenshot...`);
	const initScreenshot = await captureScreenshot(robot);
	const initUserContent: OpenAI.ChatCompletionContentPart[] = [
		{ type: "text" as const, text: config.task },
	];
	if (initScreenshot) {
		initUserContent.push({
			type: "image_url" as const,
			image_url: { url: `data:${initScreenshot.mimeType};base64,${initScreenshot.data}` },
		});
	}

	// 初始对话历史：系统提示词 + 用户任务描述（含初始截图）
	let messages: OpenAI.ChatCompletionMessageParam[] = [
		{ role: "system", content: config.systemPrompt || DEFAULT_SYSTEM_PROMPT },
		{ role: "user", content: initUserContent },
	];

	for (let step = 1; step <= config.maxSteps; step++) {
		console.log(`--- Step ${step}/${config.maxSteps}${textMode ? " [text mode]" : ""} ---`);

		// 构造请求参数：非文本模式下附带工具定义，启用原生 Function Calling
		const requestParams: any = {
			model: config.model,
			messages,
			temperature: 0, // 温度设为 0 以获得确定性输出，适合测试自动化场景
		};
		if (!textMode) {
			requestParams.tools = TOOLS;
		}

		const response = await client.chat.completions.create(requestParams);
		const choice = response.choices[0];
		const message = choice.message;

		if (message.content) {
			trace(`Assistant: ${message.content}`);
		}

		if (!textMode && message.tool_calls && message.tool_calls.length > 0) {
			nativeToolCallSucceeded = true;
			consecutiveEmptySteps = 0;
			messages.push(message);

			const pendingScreenshots: { mimeType: string; data: string }[] = [];

			for (const tc of message.tool_calls) {
				if (tc.type !== "function") {continue;}

				// 过滤无效工具名（防止模型返回 undefined/空名称）
				if (!tc.function.name) {
					console.log(`  [skip] Tool call with empty/undefined function name, ignoring.`);
					messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: tool name is empty or undefined. Please call a valid tool.` });
					continue;
				}

				let fnArgs: any = {};
				try {
					fnArgs = JSON.parse(tc.function.arguments || "{}");
				} catch (e) {
					messages.push({ role: "tool", tool_call_id: tc.id, content: `Error: malformed arguments: ${tc.function.arguments}` });
					continue;
				}

				// 检测重复动作，防止无限循环
				const actionKey = `${tc.function.name}(${JSON.stringify(fnArgs)})`;
				recentActions.push(actionKey);
				if (recentActions.length > MAX_REPEATED_ACTION) {recentActions.shift();}
				if (recentActions.length === MAX_REPEATED_ACTION && recentActions.every(a => a === actionKey)) {
					const loopWarning = `You have repeated the same action "${actionKey}" ${MAX_REPEATED_ACTION} times in a row without progress. Stop and try a different approach (e.g., use launch_app to open the app directly, or navigate back first).`;
					console.log(`  [loop] ${loopWarning}`);
					messages.push({ role: "tool", tool_call_id: tc.id, content: loopWarning });
					recentActions.length = 0;
					continue;
				}

				console.log(`  [tool] ${tc.function.name}(${JSON.stringify(fnArgs)})`);
				try {
					const result = await executeTool(robot, tc.function.name, fnArgs);
					console.log(`       -> ${result.text}`);
					messages.push({ role: "tool", tool_call_id: tc.id, content: result.text });

					if (result.type === "image") {
						pendingScreenshots.push({ mimeType: result.mimeType, data: result.imageBase64 });
					}
				} catch (err: any) {
					const errorMsg = `Error: ${err.message}`;
					console.log(`       -> [ERROR] ${errorMsg}`);
					messages.push({ role: "tool", tool_call_id: tc.id, content: errorMsg });
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
			continue;
		}

		if (!textMode && nativeToolCallSucceeded) {
			console.log(`\nAgent completed:`);
			console.log(message.content || "(no response)");
			return;
		}

		if (!textMode) {
			console.log(`  [info] Model did not use function calling. Switching to text-based tool calling...`);
			textMode = true;

			// 自动截图让模型了解当前屏幕状态，作为文本模式的起点上下文
			console.log(`  [auto] Taking initial screenshot...`);
			const initScreenshot = await captureScreenshot(robot);
			const initContent: OpenAI.ChatCompletionContentPart[] = [
				{ type: "text" as const, text: config.task },
			];
			if (initScreenshot) {
				initContent.push({
					type: "image_url" as const,
					image_url: { url: `data:${initScreenshot.mimeType};base64,${initScreenshot.data}` },
				});
			}

			// 重置对话历史，使用文本模式专用的系统提示词（含工具描述和调用格式说明）
			messages = [
				{ role: "system", content: buildTextModeSystemPrompt(config.systemPrompt) },
				{ role: "user", content: initContent },
			];
			continue;
		}

		// ===== 文本模式：从模型响应文本中解析工具调用 =====
		const textContent = message.content || "";
		const parsedCalls = parseToolCallsFromText(textContent);

		if (parsedCalls.length === 0) {
			// 未解析到工具调用：可能是任务已完成，或模型需要提示
			consecutiveEmptySteps++;
			messages.push(message);

			// 连续多步无工具调用，判定任务完成，输出模型的最终摘要
			if (consecutiveEmptySteps >= MAX_EMPTY_STEPS) {
				console.log(`\nAgent completed:`);
				console.log(textContent);
				return;
			}

			// 提醒模型按规定格式输出工具调用，继续推进任务
			messages.push({
				role: "user",
				content: "Please call a tool to proceed. Respond with ONLY a JSON code block: ```json\n{\"tool\": \"tool_name\", \"args\": {...}}\n```",
			});
			continue;
		}

		consecutiveEmptySteps = 0;
		messages.push(message);

		// 文本模式下只处理第一个动作，避免执行模型幻觉产生的多步连续调用
		const firstCall = parsedCalls[0];
		let resolved: { tool: string; args: Record<string, any> } | null;

		if (firstCall.args.__raw__ !== undefined) {
			// 参数是原始文本，需要通过 resolveRawArgs 转换为结构化参数
			console.log(`  [parse] ${firstCall.tool}("${firstCall.args.__raw__}")`);
			resolved = await resolveRawArgs(robot, firstCall.tool, firstCall.args.__raw__);
		} else {
			// 参数已经是结构化的，直接使用
			resolved = { tool: firstCall.tool, args: firstCall.args };
		}

		if (!resolved) {
			// 参数解析失败（如元素未找到），跳过此步并提示模型换个方式
			const msg = `Could not resolve action "${firstCall.tool}" with parameter "${firstCall.args.__raw__ || ""}"`;
			console.log(`       -> [SKIP] ${msg}`);
			messages.push({ role: "user", content: `[Error] ${msg}. Please try a different approach.` });
			continue;
		}

		// 检测重复动作，防止无限循环
		const actionKey = `${resolved.tool}(${JSON.stringify(resolved.args)})`;
		recentActions.push(actionKey);
		if (recentActions.length > MAX_REPEATED_ACTION) {recentActions.shift();}
		if (recentActions.length === MAX_REPEATED_ACTION && recentActions.every(a => a === actionKey)) {
			const loopWarning = `You have repeated the same action "${actionKey}" ${MAX_REPEATED_ACTION} times in a row without progress. Stop and try a different approach (e.g., use launch_app to open the app directly, or navigate back first).`;
			console.log(`  [loop] ${loopWarning}`);
			messages.push({ role: "user", content: loopWarning });
			recentActions.length = 0;
			continue;
		}

		// 执行解析后的工具调用
		console.log(`  [tool] ${resolved.tool}(${JSON.stringify(resolved.args)})`);
		let resultText: string;
		try {
			const result = await executeTool(robot, resolved.tool, resolved.args);
			console.log(`       -> ${result.text}`);
			resultText = `[Tool Result] ${resolved.tool}: ${result.text}`;
		} catch (err: any) {
			const errorMsg = `Error: ${err.message}`;
			console.log(`       -> [ERROR] ${errorMsg}`);
			resultText = `[Tool Error] ${resolved.tool}: ${errorMsg}`;
		}

		// 每次动作执行后自动截图，将实际屏幕状态反馈给模型以便其做出正确的下一步决策
		const postScreenshot = await captureScreenshot(robot);
		const feedbackContent: OpenAI.ChatCompletionContentPart[] = [
			{ type: "text" as const, text: resultText },
		];
		if (postScreenshot) {
			feedbackContent.push({
				type: "image_url" as const,
				image_url: { url: `data:${postScreenshot.mimeType};base64,${postScreenshot.data}` },
			});
		}
		messages.push({ role: "user", content: feedbackContent });
	}

	console.log(`\nReached maximum steps (${config.maxSteps}). Agent stopped.`);
}

/**
 * CLI 入口函数
 * 使用 commander 解析命令行参数，校验必要的环境变量，然后启动 Agent 执行任务。
 *
 * 支持的命令行选项：
 * --device <id>         目标设备标识符（必填）
 * --task <task>         测试任务描述（与 --task-file 二选一）
 * --task-file <path>    从文件读取任务描述（与 --task 二选一）
 * --max-steps <n>       最大执行步数（默认 50）
 * --system-prompt <path> 自定义系统提示词文件路径（可选）
 * --list-devices        列出所有可用设备并退出
 *
 * 必需的环境变量（在 .env 文件中配置）：
 * LLM_BASE_URL  LLM API 基础 URL
 * LLM_API_KEY   API 访问密钥
 * LLM_MODEL     使用的模型名称
 */
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

	// 处理 --list-devices 选项：列出可用设备后直接退出
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

	// 从环境变量读取 LLM 配置
	const baseUrl = process.env.LLM_BASE_URL;
	const apiKey = process.env.LLM_API_KEY;
	const model = process.env.LLM_MODEL;

	if (!baseUrl || !apiKey || !model) {
		console.error("Missing environment variables. Create a .env file in the current directory with:");
		console.error("  LLM_BASE_URL=https://api.openai.com/v1");
		console.error("  LLM_API_KEY=sk-xxx");
		console.error("  LLM_MODEL=gpt-4o");
		process.exit(1);
	}

	// 校验 --device 参数
	if (!opts.device) {
		console.error("Error: --device is required. Use --list-devices to see available devices.");
		process.exit(1);
	}

	// 从 --task 或 --task-file 中获取任务描述
	let task: string | undefined = opts.task;
	if (!task && opts.taskFile) {
		task = fs.readFileSync(opts.taskFile, "utf-8").trim();
	}
	if (!task) {
		console.error("Error: --task or --task-file is required.");
		process.exit(1);
	}

	// 如果指定了自定义系统提示词文件，则读取其内容
	let systemPrompt: string | undefined;
	if (opts.systemPrompt) {
		systemPrompt = fs.readFileSync(opts.systemPrompt, "utf-8");
	}

	const maxStepsStr: string = opts.maxSteps;
	const maxSteps = /^\d+$/.test(maxStepsStr) ? parseInt(maxStepsStr, 10) : NaN;
	if (isNaN(maxSteps) || maxSteps <= 0) {
		console.error("Error: --max-steps must be a positive integer.");
		process.exit(1);
	}

	await runAgent({
		baseUrl,
		apiKey,
		model,
		device: opts.device,
		task,
		maxSteps,
		systemPrompt,
	});
};

// 顶层错误捕获：将致命错误信息打印到 stderr 并以非零状态码退出
main().catch(err => {
	console.error(`Fatal error: ${err.message}`);
	process.exit(1);
});
