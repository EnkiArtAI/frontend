/**
 * Open the login UI where the user stands (Kev, 2026-08-24: "just pop up
 * the login UI … without opening the homepage"). The working sign-in is the
 * wallet picker (wallet + email code) — the shell listens and pops it in
 * place; only outside the shell does this fall back to the landing route,
 * which deep-links into its auth modal.
 */
export function openLogin(): void {
  const notConsumed = window.dispatchEvent(
    new CustomEvent("enki:open-login", { cancelable: true }),
  );
  if (notConsumed) window.location.assign("/?login=1");
}
