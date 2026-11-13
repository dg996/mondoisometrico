/**
 * Vercel Function for /p/* (rewritten here by vercel.json): the first-party proxy for Pirsch Analytics
 * (https://docs.pirsch.io), ported from worker/index.ts so the script and its requests stay on our
 * domain and the access key stays server-side.
 *
 * Env: PIRSCH_ACCESS_KEY (Pirsch → Settings → Integration → Add Client, type "Access Key"), set in the
 * Vercel project. Without it the proxy accepts requests and drops them (202).
 */

interface Env { PIRSCH_ACCESS_KEY?: string }
declare const process: { env: Record<string, string | undefined> };

// keep these free of words ad blockers filter (pirsch, analytics, tracker, hit, event, pageview)
const SCRIPT = "s.js", PAGE_VIEW = "v", EVENT = "e", SESSION = "k";

/** the public host the visitor used (the rewrite keeps it in Host / X-Forwarded-Host) */
function host(request: Request): string {
	const h = request.headers.get("X-Forwarded-Host") ?? request.headers.get("Host") ?? new URL(request.url).host;
	return h.split(",")[0].trim().split(":")[0];
}

export default {
	async fetch(request: Request): Promise<Response> {
		const env: Env = { PIRSCH_ACCESS_KEY: process.env.PIRSCH_ACCESS_KEY };
		const route = new URL(request.url).searchParams.get("route") ?? "";
		if (route === SCRIPT && request.method === "GET") return script();
		if (route === PAGE_VIEW && request.method === "GET") return pageView(request, env);
		if (route === EVENT && request.method === "POST") return event(request, env);
		if (route === SESSION && request.method === "POST") return session(request, env);
		return new Response(null, { status: 404 });
	},
};

const PIRSCH = "https://api.pirsch.io";



/** pa.js, cached at the edge for an hour. */
async function script(): Promise<Response> {
	const r = await fetch(`${PIRSCH}/pa.js`, {});
	return new Response(r.body, {
		status: r.status,
		headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" },
	});
}

/** What Pirsch needs from the visitor's request (it hashes them into a daily, cookie-free fingerprint). */
function visitor(request: Request) {
	const h = request.headers;
	return {
		ip: h.get("X-Real-IP"),
		user_agent: h.get("User-Agent"),
		accept_language: h.get("Accept-Language"),
		sec_ch_ua: h.get("Sec-CH-UA"),
		sec_ch_ua_mobile: h.get("Sec-CH-UA-Mobile"),
		sec_ch_ua_platform: h.get("Sec-CH-UA-Platform"),
		sec_ch_ua_platform_version: h.get("Sec-CH-UA-Platform-Version"),
		sec_ch_width: h.get("Sec-CH-Width"),
		sec_ch_viewport_width: h.get("Sec-CH-Viewport-Width"),
	};
}

/** Only count pages of this site: the reported URL must be on the host the request came to. */
function ownPage(request: Request, url: unknown): boolean {
	try { return typeof url === "string" && new URL(url).hostname === host(request); }
	catch { return false; }
}

async function forward(env: Env, endpoint: string, body: unknown): Promise<Response> {
	if (!env.PIRSCH_ACCESS_KEY) return new Response(null, { status: 202 });
	const r = await fetch(`${PIRSCH}/api/v1/${endpoint}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${env.PIRSCH_ACCESS_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return new Response(null, { status: r.ok ? 200 : r.status, headers: { "Cache-Control": "no-store" } });
}

/** pa.js sends page views as GET with query parameters. */
function pageView(request: Request, env: Env): Promise<Response> | Response {
	const q = new URL(request.url).searchParams;
	const url = q.get("url");
	if (!ownPage(request, url)) return new Response(null, { status: 400 });
	const tags: Record<string, string> = {};
	for (const [k, v] of q) if (k.startsWith("tag_")) tags[k.slice(4)] = v;
	return forward(env, "hit", {
		url,
		title: q.get("t"),
		referrer: q.get("ref"),
		screen_width: Number.parseInt(q.get("w") ?? "", 10) || 0,
		screen_height: Number.parseInt(q.get("h") ?? "", 10) || 0,
		...(Object.keys(tags).length ? { tags } : {}),
		...visitor(request),
	});
}

/** pa.js sends events (window.pirsch(name, …)) as a JSON beacon. */
async function event(request: Request, env: Env): Promise<Response> {
	let data: Record<string, unknown>;
	try { data = await request.json(); } catch { return new Response(null, { status: 400 }); }
	if (!ownPage(request, data.url)) return new Response(null, { status: 400 });
	delete data.identification_code;
	return forward(env, "event", { ...data, ...visitor(request) });
}

/** Session keep-alive (only sent when the snippet has data-interval-ms). */
function session(request: Request, env: Env): Promise<Response> {
	return forward(env, "session", visitor(request));
}
