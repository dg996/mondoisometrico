// Visitor feedback → GitHub issue (Vercel Function, Node runtime, Web-standard fetch handler).
// The map page (web/src/scripts/feedback.ts) POSTs {kind, text, contact?, url, viewport, userAgent, website}.
// GITHUB_TOKEN (Vercel env, fine-grained, this repo only, Issues: read and write) is never logged or echoed.
// Without it the function answers 503 and the page falls back to a prefilled github.com/…/issues/new link.

const REPO = "dg996/mondoisometrico";
const MAX_BODY = 16 * 1024;
const KINDS = ["bug", "idea"] as const;
type Kind = (typeof KINDS)[number];

// best-effort rate limit per IP: lives as long as the function instance, enough to stop a burst
const WINDOW_MS = 10 * 60 * 1000, MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  return false;
}

function json(status: number, data: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").trim().slice(0, max);
const oneLine = (s: string): string => s.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
// no @mentions or #refs that ping people or link issues from visitor text
const defang = (s: string): string => s.replace(/@(?=[A-Za-z0-9])/g, "@​").replace(/#(?=\d)/g, "#​");
const inlineCode = (s: string): string => "`" + s.replace(/`/g, "'") + "`";

async function handle(request: Request): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return json(413, { error: "too_large" });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) return json(413, { error: "too_large" });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: "bad_json" });
  }

  // honeypot: humans never see the field; pretend success so bots don't retry
  if (typeof body.website === "string" && body.website.trim() !== "") return json(200, { ok: true });

  const kind = body.kind as Kind;
  if (!KINDS.includes(kind)) return json(400, { error: "bad_kind" });
  const text = typeof body.text === "string" ? body.text.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length < 10 || text.length > 4000) return json(400, { error: "bad_text" });
  const contact = oneLine(str(body.contact, 200));
  let pageUrl = oneLine(str(body.url, 600));
  if (!/^https?:\/\//i.test(pageUrl)) pageUrl = "";
  const viewport = oneLine(str(body.viewport, 40));
  const userAgent = oneLine(str(body.userAgent, 400));

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
  if (limited(ip)) return json(429, { error: "rate_limited" }, { "retry-after": "600" });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return json(503, { error: "not_configured", message: "Feedback is not configured on the server (GITHUB_TOKEN missing)." });

  const firstLine = oneLine(text);
  const title = `[${kind}] ${firstLine.length > 70 ? firstLine.slice(0, 69).trimEnd() + "…" : firstLine}`;
  const quoted = defang(text).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  const details = [
    `- **Pagina:** ${pageUrl ? `<${pageUrl.replace(/>/g, "%3E")}>` : "n/d"}`,
    `- **Viewport:** ${viewport ? inlineCode(viewport) : "n/d"}`,
    `- **Browser:** ${userAgent ? inlineCode(userAgent) : "n/d"}`,
    `- **Data:** ${new Date().toISOString()}`,
    ...(contact ? [`- **Contatto (lasciato dal visitatore):** ${inlineCode(defang(contact))}`] : []),
  ].join("\n");
  const issueBody = `${quoted}\n\n<details><summary>Dettagli</summary>\n\n${details}\n\n</details>\n\n_Inviato dal pulsante di segnalazione sulla mappa._`;

  let gh: Response;
  try {
    gh = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "mondoisometrico-feedback",
      },
      body: JSON.stringify({ title, body: issueBody, labels: ["feedback", kind] }),
    });
  } catch {
    return json(502, { error: "github_unreachable" });
  }
  if (!gh.ok) {
    console.error(`feedback: GitHub answered ${gh.status}`); // status only, never the token or the response headers
    return json(502, { error: "github_error", status: gh.status });
  }
  const issue = (await gh.json()) as { number?: number; html_url?: string };
  return json(201, { ok: true, number: issue.number, url: issue.html_url });
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request);
    } catch {
      return json(500, { error: "internal" });
    }
  },
};
