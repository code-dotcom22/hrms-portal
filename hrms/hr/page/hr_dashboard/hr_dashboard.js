frappe.pages["hr-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("My Dashboard"),
		single_column: true,
		// This is a landing hub, not a page "inside" Frappe HR -- the workspace nav
		// would contradict the Switch App cards below. Same option frappe's own
		// apps/desktop screen uses; it's re-evaluated on every page change, so the
		// sidebar comes back as soon as you navigate into an app.
		hide_sidebar: true,
	});

	// hide_sidebar takes the whole body sidebar with it, including the user menu that
	// normally holds these, so put them back on the page's own menu. Settings is a
	// lazy-loaded dialog rather than a route, so it's opened the same way the sidebar's
	// own user menu opens it.
	page.add_menu_item(__("Settings"), () => {
		frappe
			.require("user_settings_dialog.bundle.js")
			.then(() => frappe.ui.show_user_settings("profile"))
			.catch(() => {
				frappe.msgprint(__("Could not open Settings. Please refresh the page."));
			});
	});
	page.add_menu_item(__("Logout"), () => frappe.app.logout());

	new hrms.HRDashboard(page);
};

hrms.HRDashboard = class HRDashboard {
	constructor(page) {
		this.page = page;
		this.wrapper = $('<div class="hr-dashboard"></div>').appendTo(this.page.main);

		// Same indicator names Desk already uses for `indicator-pill`, so a
		// status reads the same way here as it does everywhere else in the app.
		this.ring_colors = ["blue", "green", "orange", "purple", "cyan", "pink"];
		this.attendance_status_colors = {
			Present: "green",
			Absent: "red",
			"On Leave": "blue",
			"Half Day": "orange",
			"Work From Home": "cyan",
		};
		this.leave_status_colors = {
			Approved: "green",
			Rejected: "red",
			Open: "orange",
			Cancelled: "gray",
		};

		// frappe.Chart paints SVG fills directly, so it needs literal colors rather than
		// the CSS variables the rest of the page uses. Same palette, resolved up front.
		this.chart_hex = {
			blue: "#0289f7",
			green: "#46b37e",
			orange: "#e86c13",
			purple: "#9c45e3",
			cyan: "#3bbde5",
			pink: "#e34aa6",
			red: "#e03636",
			gray: "#999999",
		};

		this.wrapper.on("click", ".hr-app-card", (e) => {
			e.preventDefault();
			frappe.set_route($(e.currentTarget).attr("data-route"));
		});
		this.setup_notification_bell();

		// Namespaced and rebound so repeat visits to the page don't stack handlers.
		$(document)
			.off("click.hr_dashboard")
			.on("click.hr_dashboard", (e) => {
				if (!$(e.target).closest(".hr-notification-wrap").length) {
					this.$notification.find(".hr-notification-panel").addClass("hidden");
				}
			});
		this.render_message(__("Loading..."));
		this.fetch();
	}

	fetch() {
		frappe.call({
			method: "hrms.api.get_employee_login_summary",
			freeze: false,
			callback: (r) => {
				if (r.message) {
					this.data = r.message;
					this.render();
				}
			},
			error: () => {
				this.render_message(__("Could not load your dashboard."));
			},
		});
	}

	render_message(text) {
		this.wrapper.html(`<div class="hr-dashboard-message text-muted">${text}</div>`);
	}

	render() {
		const { employee, attendance, leave_applications, leave_balance } = this.data;

		this.wrapper.html(`
			<div class="hr-dashboard-body">
				${this.get_header_html(employee)}
				${this.get_stat_cards_html(attendance, leave_applications)}
				${this.get_charts_html(attendance)}
				${this.get_leave_balance_html(leave_balance)}
				${this.get_table_section_html(
					__("Recent Attendance"),
					[__("Date"), __("Status"), __("Working Hours")],
					this.get_attendance_rows_html(attendance),
					`<a class="hr-section-action" href="/desk/attendance">${__("View All")}</a>`,
				)}
				${this.get_table_section_html(
					__("Leave Applications"),
					[__("Leave Type"), __("Dates"), __("Days"), __("Status")],
					this.get_leave_application_rows_html(leave_applications),
					`<a class="hr-section-action" href="/desk/leave-application">${__("View All")}</a>`,
				)}
				${this.get_app_switcher_html()}
			</div>
		`);

		// Charts need their containers present in the DOM before instantiation.
		this.render_charts(attendance);
		// Fetched separately so a slow/failing count never holds up the dashboard; the
		// bell just stays unbadged.
		this.update_notification_badge();
	}

	setup_notification_bell() {
		// Lives in the page header next to the "..." menu rather than in the page body,
		// so it sits where a notification bell is normally expected. custom_actions is
		// the framework's slot for this and ships hidden until something is added.
		this.$notification = $(`
			<div class="hr-notification-wrap">
				<button class="hr-notification-btn" title="${__("Notifications")}">
					<svg class="icon icon-md"><use href="#icon-bell"></use></svg>
					<span class="hr-notification-badge hidden"></span>
				</button>
				<div class="hr-notification-panel hidden"></div>
			</div>
		`).appendTo(this.page.custom_actions);

		this.page.custom_actions.removeClass("hide");

		this.$notification.on("click", ".hr-notification-btn", (e) => {
			e.stopPropagation();
			this.toggle_notification_panel();
		});
		this.$notification.on("click", ".hr-notification-mark-all", (e) => {
			e.stopPropagation();
			this.mark_all_notifications_read();
		});
		this.$notification.on("click", ".hr-notification-item", (e) => {
			this.open_notification($(e.currentTarget));
		});
	}

	update_notification_badge() {
		frappe.call({
			method: "hrms.api.get_unread_notifications_count",
			freeze: false,
			callback: (r) => {
				const count = r.message || 0;
				const $badge = this.$notification.find(".hr-notification-badge");

				if (!count) {
					$badge.addClass("hidden");
					return;
				}
				$badge.text(count > 99 ? "99+" : count).removeClass("hidden");
			},
		});
	}

	toggle_notification_panel() {
		const $panel = this.$notification.find(".hr-notification-panel");

		if (!$panel.hasClass("hidden")) {
			$panel.addClass("hidden");
			return;
		}

		$panel.removeClass("hidden");
		this.load_notifications();
	}

	load_notifications() {
		const $panel = this.$notification.find(".hr-notification-panel");
		$panel.html(`<div class="hr-notification-empty text-muted">${__("Loading...")}</div>`);

		frappe.db
			.get_list("PWA Notification", {
				filters: { to_user: frappe.session.user },
				fields: [
					"name",
					"message",
					"read",
					"creation",
					"reference_document_type",
					"reference_document_name",
				],
				order_by: "creation desc",
				limit: 10,
			})
			.then((items) => this.render_notification_panel(items || []))
			.catch(() => {
				$panel.html(
					`<div class="hr-notification-empty text-muted">${__(
						"Could not load notifications.",
					)}</div>`,
				);
			});
	}

	render_notification_panel(items) {
		const $panel = this.$notification.find(".hr-notification-panel");

		if (!items.length) {
			$panel.html(
				`<div class="hr-notification-empty text-muted">${__(
					"You have no notifications",
				)}</div>`,
			);
			return;
		}

		const rows = items
			.map(
				(n) => `
					<div
						class="hr-notification-item ${n.read ? "" : "unread"}"
						data-name="${frappe.utils.escape_html(n.name)}"
						data-doctype="${frappe.utils.escape_html(n.reference_document_type || "")}"
						data-docname="${frappe.utils.escape_html(n.reference_document_name || "")}"
					>
						<!-- Server-built message carrying <b> tags, same as the PWA renders. -->
						<div class="hr-notification-message">${n.message || ""}</div>
						<div class="hr-notification-time text-muted">${comment_when(n.creation)}</div>
					</div>
				`,
			)
			.join("");

		$panel.html(`
			<div class="hr-notification-panel-header">
				<span>${__("Notifications")}</span>
				<button class="btn btn-xs btn-default hr-notification-mark-all">
					${__("Mark all as read")}
				</button>
			</div>
			<div class="hr-notification-list">${rows}</div>
		`);
	}

	mark_all_notifications_read() {
		frappe.call({
			method: "hrms.api.mark_all_notifications_as_read",
			freeze: false,
			callback: () => {
				this.$notification.find(".hr-notification-badge").addClass("hidden");
				this.$notification.find(".hr-notification-item").removeClass("unread");
			},
		});
	}

	open_notification($item) {
		const doctype = $item.attr("data-doctype");
		const docname = $item.attr("data-docname");

		if ($item.hasClass("unread")) {
			frappe.call({
				method: "hrms.api.mark_notification_as_read",
				args: { name: $item.attr("data-name") },
				freeze: false,
				callback: () => this.update_notification_badge(),
			});
			$item.removeClass("unread");
		}

		if (doctype && docname) {
			frappe.set_route("Form", doctype, docname);
		}
	}

	get_header_html(employee) {
		const today = frappe.datetime.str_to_user(frappe.datetime.get_today());
		return `
			<div class="hr-dashboard-hero">
				${frappe.avatar(employee.user_id, "avatar-large hr-dashboard-hero-avatar")}
				<div>
					<h4>${__("Welcome, {0}", [frappe.utils.escape_html(employee.employee_name || "")])}</h4>
					<div class="hr-dashboard-hero-subtitle">
						${frappe.utils.escape_html(employee.designation || "")}
						${employee.designation ? " · " : ""}${today}
					</div>
				</div>
				</div>
		`;
	}

	get_stat_cards_html(attendance, leave_applications) {
		const present_days = attendance.filter((a) => a.status === "Present").length;
		const hours_sum = attendance.reduce((sum, a) => sum + (a.working_hours || 0), 0);
		const total_hours = hours_sum.toFixed(1);

		// Only days that were actually worked count towards the average, so weekends and
		// leave days don't drag it down.
		const worked_days = attendance.filter((a) => a.working_hours > 0).length;
		const avg_hours = worked_days ? (hours_sum / worked_days).toFixed(1) : 0;
		const late_days = attendance.filter((a) => a.late_entry).length;

		const cards = [
			{ icon: "calendar", value: present_days, label: __("Days Present"), color: "blue" },
			{ icon: "clock", value: total_hours, label: __("Working Hours"), color: "green" },
			{ icon: "activity", value: avg_hours, label: __("Avg Hours / Day"), color: "cyan" },
			{ icon: "alarm-clock", value: late_days, label: __("Late Arrivals"), color: "orange" },
			{
				// Lucide renamed check-circle -> circle-check; the old name renders blank.
				icon: "circle-check",
				value: (leave_applications || []).length,
				label: __("Leave Applications"),
				color: "purple",
			},
		];

		return `
			<div class="hr-dashboard-stats">
				${cards
					.map(
						(c) => `
							<div class="hr-stat-card">
								<div class="hr-stat-icon-badge ${c.color}">
									<svg class="icon icon-md hr-stat-icon"><use href="#icon-${c.icon}"></use></svg>
								</div>
								<div>
									<div class="hr-stat-value">${c.value}</div>
									<div class="hr-stat-label">${c.label}</div>
								</div>
							</div>
						`,
					)
					.join("")}
			</div>
		`;
	}

	get_charts_html(attendance) {
		if (!attendance.length) return "";

		return `
			<div class="hr-dashboard-charts">
				<div class="hr-chart-card">
					<div class="hr-chart-title">${__("Working Hours Trend")}</div>
					<div class="hr-chart" data-chart="hours"></div>
				</div>
				<div class="hr-chart-card">
					<div class="hr-chart-title">${__("Attendance Breakdown")}</div>
					<div class="hr-chart" data-chart="status"></div>
				</div>
			</div>
		`;
	}

	render_charts(attendance) {
		// frappe.Chart ships with Desk (desk.bundle.js), but guard anyway so a missing
		// global degrades to a chart-less dashboard rather than breaking the page.
		if (!attendance.length || !frappe.Chart) return;

		this.render_hours_chart(attendance);
		this.render_status_chart(attendance);
	}

	render_hours_chart(attendance) {
		const container = this.wrapper.find('[data-chart="hours"]')[0];
		if (!container) return;

		// API returns newest-first; a trend line has to read oldest -> newest.
		const chronological = [...attendance].reverse();

		new frappe.Chart(container, {
			type: "bar",
			height: 220,
			colors: [this.chart_hex.blue],
			animate: false,
			axisOptions: { xAxisMode: "tick", yAxisMode: "span" },
			barOptions: { spaceRatio: 0.4 },
			tooltipOptions: {
				formatTooltipY: (value) => `${value} ${__("hrs")}`,
			},
			data: {
				// Day-of-month keeps the axis readable across a full month.
				labels: chronological.map((a) => a.attendance_date.split("-")[2]),
				datasets: [
					{
						name: __("Working Hours"),
						values: chronological.map((a) => a.working_hours || 0),
					},
				],
			},
		});
	}

	render_status_chart(attendance) {
		const container = this.wrapper.find('[data-chart="status"]')[0];
		if (!container) return;

		const counts = {};
		attendance.forEach((a) => {
			counts[a.status] = (counts[a.status] || 0) + 1;
		});

		const statuses = Object.keys(counts);
		if (!statuses.length) return;

		new frappe.Chart(container, {
			type: "donut",
			height: 220,
			animate: false,
			// Reuse the same status -> colour mapping as the table pills.
			colors: statuses.map(
				(s) => this.chart_hex[this.attendance_status_colors[s]] || this.chart_hex.gray,
			),
			data: {
				labels: statuses.map((s) => __(s)),
				datasets: [{ values: statuses.map((s) => counts[s]) }],
			},
		});
	}

	get_leave_balance_html(leave_balance) {
		const entries = Object.entries(leave_balance || {});
		if (!entries.length) {
			return `
				<h5 class="hr-dashboard-section-title">${__("Leave Balance")}</h5>
				<p class="text-muted">${__("No leave allocated")}</p>
			`;
		}

		const cards = entries
			.map(([leave_type, d], i) => {
				const allocated = d.allocated_leaves || 0;
				const balance = d.balance_leaves || 0;
				const percent = allocated > 0 ? Math.min(100, Math.round((balance / allocated) * 100)) : 0;
				const color = this.ring_colors[i % this.ring_colors.length];

				return `
					<div class="hr-leave-balance-card ${color}">
						<svg class="hr-ring" viewBox="0 0 42 42">
							<circle class="hr-ring-bg" cx="21" cy="21" r="15.91549431" />
							<circle
								class="hr-ring-value ${color}"
								cx="21" cy="21" r="15.91549431"
								stroke-dasharray="${percent} ${100 - percent}"
							/>
						</svg>
						<div class="hr-ring-label">
							<div class="hr-ring-value-text">${balance}</div>
							<div class="text-muted">${frappe.utils.escape_html(leave_type)}</div>
						</div>
					</div>
				`;
			})
			.join("");

		return `
			<h5 class="hr-dashboard-section-title">${__("Leave Balance")}</h5>
			<div class="hr-dashboard-leave-balance">${cards}</div>
		`;
	}

	get_attendance_rows_html(attendance) {
		if (!attendance.length) {
			return `<tr><td colspan="3" class="text-muted">${__("No records")}</td></tr>`;
		}

		// The trend chart now covers the whole period, so the table only needs the tail
		// end of it (API returns newest-first). "View All" covers the rest.
		return attendance
			.slice(0, 7)
			.map((a) => {
				const color = this.attendance_status_colors[a.status] || "gray";
				return `
					<tr>
						<td>${frappe.datetime.str_to_user(a.attendance_date)}</td>
						<td><span class="indicator-pill no-indicator-dot ${color}">${frappe.utils.escape_html(
							a.status,
						)}</span></td>
						<td>${a.working_hours || 0}</td>
					</tr>
				`;
			})
			.join("");
	}

	get_leave_application_rows_html(leave_applications) {
		if (!(leave_applications || []).length) {
			return `<tr><td colspan="4" class="text-muted">${__("No records")}</td></tr>`;
		}

		return leave_applications
			.map((l) => {
				const color = this.leave_status_colors[l.status] || "gray";
				return `
					<tr>
						<td>${frappe.utils.escape_html(l.leave_type)}</td>
						<td>${frappe.datetime.str_to_user(l.from_date)} - ${frappe.datetime.str_to_user(
							l.to_date,
						)}</td>
						<td>${l.total_leave_days}</td>
						<td><span class="indicator-pill no-indicator-dot ${color}">${frappe.utils.escape_html(
							l.status,
						)}</span></td>
					</tr>
				`;
			})
			.join("");
	}

	get_table_section_html(title, headers, rows_html, action_html = "") {
		return `
			<div class="hr-dashboard-section-header">
				<h5 class="hr-dashboard-section-title">${title}</h5>
				${action_html}
			</div>
			<div class="hr-dashboard-table-wrapper">
				<table class="table table-bordered">
					<thead>
						<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>
					</thead>
					<tbody>${rows_html}</tbody>
				</table>
			</div>
		`;
	}

	get_app_switcher_html() {
		const apps = [
			{
				title: __("Frappe HR"),
				initials: "HR",
				color: "var(--blue-500, #0289f7)",
				route: "hr-setup",
			},
		];

		if (frappe.boot.versions && frappe.boot.versions.erpnext) {
			apps.push({
				title: __("ERPNext"),
				initials: "ERP",
				color: "var(--green-500, #46b37e)",
				route: "erpnext",
			});
		}

		return `
			<h5 class="hr-dashboard-section-title">${__("Switch App")}</h5>
			<div class="hr-dashboard-apps">
				${apps
					.map(
						(app) => `
							<a class="hr-app-card" href="/app/${app.route}" data-route="${app.route}">
								<div class="hr-app-card-badge" style="background: ${app.color}">${app.initials}</div>
								<div class="hr-app-card-label">${app.title}</div>
								<svg class="icon icon-sm hr-app-card-arrow"><use href="#icon-chevron-right"></use></svg>
							</a>
						`,
					)
					.join("")}
			</div>
		`;
	}
};
