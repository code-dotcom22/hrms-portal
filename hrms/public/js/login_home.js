// Frappe logout sends /login?redirect-to=<last desk page>, and login.js then
// restores that URL instead of home_page. Strip it so every login lands on
// /desk/hr-dashboard (set in on_session_creation).
(function () {
	if (!/\/login\/?$/.test(window.location.pathname)) {
		return;
	}
	try {
		if (window.localStorage) localStorage.clear();
		if (window.sessionStorage) sessionStorage.clear();
		const url = new URL(window.location.href);
		if (!url.searchParams.has("redirect-to")) {
			return;
		}
		url.searchParams.delete("redirect-to");
		const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "") + url.hash;
		window.history.replaceState({}, "", next);
	} catch (e) {
		// ignore
	}
})();
