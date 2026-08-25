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

function redirect_to_dashboard_on_landing() {
	if (frappe._hr_dashboard_redirected || is_on_hr_dashboard()) return;

	const from_login = /\/login/i.test(document.referrer || "");
	const route = (frappe.get_route_str && frappe.get_route_str()) || "";
	const first = (frappe.get_route() || [])[0] || "";
	const landing = new Set(["", "home", "apps", "Workspaces", "workspace"]);

	if (!from_login && !landing.has(route) && !landing.has(first)) return;

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
