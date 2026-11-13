/**
 * "Condividi": shares the exact view on screen. The map keeps location.hash (#@x,y,zoom) in step with
 * the view, so the current URL is the link; the phone's share sheet when there is one, else the clipboard.
 */
const button = document.getElementById("share") as HTMLButtonElement | null;

button?.addEventListener("click", async () => {
  const url = location.origin + location.pathname + location.hash; // the live view, not the ?at= it opened with
  const title = document.title;
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    flash("Link copiato");
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return; // closed the share sheet
    window.prompt("Copia il link di questa vista:", url); // clipboard blocked: let the visitor copy it
  }
});

function flash(text: string) {
  if (!button) return;
  const label = button.textContent;
  button.textContent = text;
  button.classList.add("done");
  setTimeout(() => { button.textContent = label; button.classList.remove("done"); }, 1600);
}
