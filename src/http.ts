import { debug, error, shouldLogData, shouldLogHttp, logValue } from "./logger";

export interface FetchMeta {
	label?: string;
	purpose?: string;
}

const methodOf = (init?: RequestInit): string => {
	return (init?.method ?? "GET").toUpperCase();
};

const bodyToString = (body: RequestInit["body"]): string => {
	if (body === undefined || body === null) {return "";}
	if (typeof body === "string") {return body;}
	if (body instanceof URLSearchParams) {return body.toString();}
	if (body instanceof Blob) {return `[Blob ${body.type} ${body.size} bytes]`;}
	if (body instanceof ArrayBuffer) {return `[ArrayBuffer ${body.byteLength} bytes]`;}
	// Node fetch allows Buffer

	const anyBody: any = body;
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(anyBody)) {return `[Buffer ${anyBody.length} bytes]`;}
	try {
		return String(body);
	} catch {
		return "[unstringifiable body]";
	}
};

export const fetchLogged = async (url: string, init?: RequestInit, meta?: FetchMeta): Promise<Response> => {
	const start = Date.now();
	const method = methodOf(init);

	if (shouldLogHttp()) {
		const fields: Record<string, unknown> = { label: meta?.label, purpose: meta?.purpose, method, url };
		if (shouldLogData() && init?.body !== undefined) {
			fields.requestBody = logValue(bodyToString(init.body));
		}
		debug("http.fetch.start", fields);
	}

	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (err: any) {
		if (shouldLogHttp()) {
			error("http.fetch.err", { label: meta?.label, purpose: meta?.purpose, method, url, error: err?.message ?? String(err) });
		}
		throw err;
	}

	if (shouldLogHttp()) {
		const durationMs = Date.now() - start;
		const fields: Record<string, unknown> = { label: meta?.label, method, url, status: response.status, durationMs };
		if (shouldLogData()) {
			try {
				const text = await response.clone().text();
				fields.responseBody = logValue(text);
			} catch (err: any) {
				fields.responseBody = `[unavailable: ${err?.message ?? String(err)}]`;
			}
		}
		debug("http.fetch.ok", fields);
	}

	return response;
};
