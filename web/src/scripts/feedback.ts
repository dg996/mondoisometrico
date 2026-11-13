// "Segnala un problema o un'idea": a native <dialog> (MapPage.astro) that POSTs to the Vercel function
// api/feedback.ts, which opens a GitHub issue. When there is no function (astro dev: 404), no token (503)
// or GitHub fails, the visitor gets a github.com/…/issues/new link prefilled with the same title/body/labels.

const NEW_ISSUE = "https://github.com/dg996/mondoisometrico/issues/new";

const dialog = document.getElementById("feedback") as HTMLDialogElement | null;
const openBtn = document.getElementById("feedback-open");
const form = document.getElementById("feedback-form") as HTMLFormElement | null;
const statusEl = document.getElementById("feedback-status");
const sendBtn = document.getElementById("feedback-send") as HTMLButtonElement | null;

type Kind = "bug" | "idea";
interface Payload { kind: Kind; text: string; contact: string; url: string; viewport: string; userAgent: string; website: string }

function fallbackUrl(p: Payload): string {
  const first = p.text.replace(/\s+/g, " ").trim();
  const title = `[${p.kind}] ${first.length > 70 ? first.slice(0, 69).trimEnd() + "…" : first}`;
  const body = [
    p.text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"),
    "",
    `- Pagina: ${p.url}`,
    `- Viewport: ${p.viewport}`,
    `- Browser: ${p.userAgent}`,
    `- Data: ${new Date().toISOString()}`,
  ].join("\n");
  const q = new URLSearchParams({ title, body: body.slice(0, 6000), labels: `feedback,${p.kind}` });
  return `${NEW_ISSUE}?${q}`;
}

function setStatus(kind: "info" | "ok" | "error", text: string, link?: { href: string; label: string }) {
  if (!statusEl) return;
  statusEl.className = `fb-status ${kind}`;
  statusEl.textContent = text;
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = link.label;
    statusEl.append(" ", a);
  }
}

if (dialog && openBtn && form && sendBtn) {
  openBtn.addEventListener("click", () => {
    setStatus("info", "");
    dialog.showModal();
    (form.querySelector("textarea") as HTMLTextAreaElement | null)?.focus();
  });
  // the map's single-key shortcuts (map.ts listens on window) must not fire while typing in the dialog
  dialog.addEventListener("keydown", (e) => { if (e.key !== "Escape") e.stopPropagation(); });
  // click on the backdrop closes
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  for (const b of dialog.querySelectorAll<HTMLElement>("[data-close]")) b.addEventListener("click", () => dialog.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const p: Payload = {
      kind: data.get("kind") === "idea" ? "idea" : "bug",
      text: String(data.get("text") ?? "").trim(),
      contact: String(data.get("contact") ?? "").trim(),
      url: location.href,
      viewport: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
      userAgent: navigator.userAgent,
      website: String(data.get("website") ?? ""),
    };
    if (p.text.length < 10) { setStatus("error", "Scrivi almeno 10 caratteri."); return; }
    if (p.text.length > 4000) { setStatus("error", "Massimo 4000 caratteri."); return; }

    sendBtn.disabled = true;
    setStatus("info", "Invio…");
    const fallback = { href: fallbackUrl(p), label: "Apri la segnalazione su GitHub" };
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; number?: number; url?: string };
      if (res.ok && out.ok) {
        form.reset();
        setStatus("ok", out.number ? `Grazie! Segnalazione #${out.number} inviata.` : "Grazie! Segnalazione inviata.",
          out.url ? { href: out.url, label: "Vedi su GitHub" } : undefined);
      } else if (res.status === 429) {
        setStatus("error", "Troppe segnalazioni in poco tempo: riprova tra qualche minuto, oppure", fallback);
      } else if (res.status === 400) {
        setStatus("error", "Controlla il testo (10–4000 caratteri) e riprova.");
      } else {
        // 404 in astro dev (no /api), 503 without token, 502 when GitHub fails
        setStatus("error", "Invio automatico non disponibile.", fallback);
      }
    } catch {
      setStatus("error", "Connessione non riuscita.", fallback);
    } finally {
      sendBtn.disabled = false;
    }
  });
}
