// Puts a persistent "My Dashboard" icon in the sidebar's standard-items rail, next to
// the notification/background-task icons, instead of leaving it buried three levels
// deep in the user settings dropdown (see hooks.py standard_navbar_items, kept as a
// fallback entry point). Reuses frappe.app.sidebar's own item renderer so it matches
// native icon styling/behavior rather than hand-building DOM.

const HR_DASHBOARD_ROUTE = "hr-dashboard";

function is_on_hr_dashboard() {
	const first = (frappe.get_route() || [])[0] || "";
	return first === HR_DASHBOARD_ROUTE;
}

// Last line of defence only: hooks.py already pins home_page to /desk/hr-dashboard
// and strips ?redirect-to= before the login page renders, so this normally finds
// itself already on the dashboard and does nothing. It fires strictly on a
// navigation that came from /login -- an unconditional "landing route" check here
// used to hijack workspace deep links (frappe.get_route() is ["Workspaces", ...])
// on ordinary page loads.
function redirect_to_dashboard_on_landing() {
	if (frappe._hr_dashboard_redirected || is_on_hr_dashboard()) return;
	if (!/\/login/i.test(document.referrer || "")) return;

	frappe._hr_dashboard_redirected = true;
	frappe.set_route(HR_DASHBOARD_ROUTE);
}

function clear_browser_storage() {
	try {
		if (window.localStorage) localStorage.clear();
		if (window.sessionStorage) sessionStorage.clear();
	} catch (e) {
		// ignore quota / private-mode errors
	}
}

function stop_logout_from_restoring_last_page() {
	if (!frappe.app) return;

	frappe.app.redirect_to_login = function () {
		clear_browser_storage();
		window.location.href = "/login";
	};

	frappe.app.logout = function () {
		const me = this;
		me.logged_out = true;
		frappe.confirm(__("Are you sure you want to log out?"), function () {
			return frappe.call({
				method: "logout",
				callback: function (r) {
					if (r.exc) return;
					clear_browser_storage();
					me.redirect_to_login();
				},
			});
		});
	};
}

$(document).on("app_ready", function () {
	stop_logout_from_restoring_last_page();
	redirect_to_dashboard_on_landing();

	const sidebar = frappe.app.sidebar;
	if (!sidebar || sidebar.wrapper.find(".sidebar-my-dashboard").length) return;

	sidebar.add_item(sidebar.$standard_items_sections, {
		label: __("My Dashboard"),
		icon: "layout-dashboard",
		standard: true,
		type: "Button",
		class: "sidebar-my-dashboard",
		onClick: () => frappe.set_route(HR_DASHBOARD_ROUTE),
	});
});
