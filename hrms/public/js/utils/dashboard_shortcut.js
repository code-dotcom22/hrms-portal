// Puts a persistent "My Dashboard" icon in the sidebar's standard-items rail, next to
// the notification/background-task icons, instead of leaving it buried three levels
// deep in the user settings dropdown (see hooks.py standard_navbar_items, kept as a
// fallback entry point). Reuses frappe.app.sidebar's own item renderer so it matches
// native icon styling/behavior rather than hand-building DOM.
$(document).on("app_ready", function () {
	const sidebar = frappe.app.sidebar;
	if (!sidebar || sidebar.wrapper.find(".sidebar-my-dashboard").length) return;

	sidebar.add_item(sidebar.$standard_items_sections, {
		label: __("My Dashboard"),
		icon: "layout-dashboard",
		standard: true,
		type: "Button",
		class: "sidebar-my-dashboard",
		onClick: () => frappe.set_route("hr-dashboard"),
	});
});
