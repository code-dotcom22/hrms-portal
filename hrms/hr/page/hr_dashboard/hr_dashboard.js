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

		// HR/admin roles get an employee picker so they can browse anyone's dashboard
		// instead of only their own -- same set hrms.hr.utils.get_employee_home_page
		// already treats as "elevated" when deciding who lands here on login.
		this.is_hr_admin = this.has_elevated_role();
		this.selected_employee = null;

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

		// Every dated section reflects this range. Month-to-date is the default, and the
		// server falls back to the same window when the args are omitted.
		[this.from_date, this.to_date] = this.get_preset_range("this_month");

		this.wrapper.on("click", ".hr-app-card", (e) => {
			e.preventDefault();
			frappe.set_route($(e.currentTarget).attr("data-route"));
		});
		this.setup_layout();
		this.setup_filters();
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
		// Fetched separately so a slow/failing count never holds up the dashboard; the
		// bell just stays unbadged. Unaffected by the date range, so it runs once.
		this.update_notification_badge();
	}

	has_elevated_role() {
		const roles = frappe.user_roles || [];
		return ["System Manager", "HR Manager", "HR User"].some((role) => roles.includes(role));
	}

	setup_layout() {
		// The hero and the filter bar outlive a range change -- only the sections below
		// them are re-rendered -- so the date controls keep their state and focus.
		this.wrapper.html(`
			<div class="hr-dashboard-body">
				<div class="hr-dashboard-hero-slot"></div>
				<div class="hr-dashboard-filter-bar"></div>
				<div class="hr-dashboard-content"></div>
			</div>
		`);

		this.$hero = this.wrapper.find(".hr-dashboard-hero-slot");
		this.$filters = this.wrapper.find(".hr-dashboard-filter-bar");
		this.$content = this.wrapper.find(".hr-dashboard-content");
	}

	fetch() {
		// A slow response for an earlier range must not overwrite a newer one.
		const token = (this.fetch_token = (this.fetch_token || 0) + 1);
		this.$content.addClass("hr-dashboard-loading");

		const args = { from_date: this.from_date, to_date: this.to_date };
		// Omitted for everyone else, and for an admin who hasn't picked anyone yet --
		// the server then falls back to the logged-in employee, same as before.
		if (this.is_hr_admin && this.selected_employee) args.employee = this.selected_employee;

		frappe.call({
			method: "hrms.api.get_employee_login_summary",
			args,
			freeze: false,
			callback: (r) => {
				if (token !== this.fetch_token) return;
				this.$content.removeClass("hr-dashboard-loading");

				if (r.message) {
					this.data = r.message;
					this.render();
				}
			},
			error: () => {
				if (token !== this.fetch_token) return;
				this.$content.removeClass("hr-dashboard-loading");
				this.render_message(__("Could not load your dashboard."));
			},
		});
	}

	render_message(text) {
		this.$content.html(`<div class="hr-dashboard-message text-muted">${text}</div>`);
	}

	// Reached when the server has no Employee to report on: an admin who hasn't
	// picked anyone yet, or (rarer) a session with no linked Employee at all.
	render_no_employee_state() {
		this.$hero.html("");

		if (!this.is_hr_admin) {
			this.render_message(__("No employee record is linked to your account. Please contact HR."));
			return;
		}

		// Points back at the picker by name ("above") rather than assuming the
		// reader will connect a floating message to a field further up the page.
		this.$content.html(`
			<div class="hr-dashboard-empty-state">
				<svg class="icon icon-lg hr-dashboard-empty-state-icon"><use href="#icon-users"></use></svg>
				<h5>${__("No employee selected")}</h5>
				<p class="text-muted">
					${__("Use the Employee field above to search for someone and view their attendance, leave and working hours.")}
				</p>
			</div>
		`);

		// A brief highlight plus a focused cursor -- rather than relying on the
		// text alone -- so it's obvious at a glance where "above" means.
		this.$filters.find(".hr-employee-picker-field").addClass("hr-employee-picker-attention");
		if (this.employee_control) {
			if (typeof this.employee_control.set_focus === "function") {
				this.employee_control.set_focus();
			} else if (this.employee_control.$input) {
				this.employee_control.$input.trigger("focus");
			}
		}
	}

	render() {
		const { employee, attendance, leave_applications, leave_balance } = this.data;

		if (!employee) {
			this.render_no_employee_state();
			return;
		}

		// Keeps the picker showing who's on screen even when nobody's explicitly
		// picked yet (an admin who also has their own Employee record opens on it).
		if (this.is_hr_admin) {
			this.selected_employee = employee.name;
			this.$filters.find(".hr-employee-picker-field").removeClass("hr-employee-picker-attention");
			if (this.employee_control && this.employee_control.get_value() !== employee.name) {
				this.employee_control.set_value(employee.name);
			}
		}

		this.$hero.html(this.get_header_html(employee));
		this.$content.html(`
			${this.get_stat_cards_html(attendance, leave_applications)}
			${this.get_charts_html(attendance)}
			${this.get_leave_balance_html(leave_balance)}
			${this.get_table_section_html(
				__("Attendance"),
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
		`);

		// Charts need their containers present in the DOM before instantiation.
		this.render_charts(attendance);
	}

	// Date range

	setup_filters() {
		this.presets = [
			{ key: "this_month", label: __("This Month") },
			{ key: "last_month", label: __("Last Month") },
			{ key: "last_3_months", label: __("Last 3 Months") },
			{ key: "this_year", label: __("This Year") },
		];

		this.$filters.html(`
			${this.is_hr_admin ? '<div class="hr-employee-picker-field"></div>' : ""}
			<div class="hr-date-presets">
				${this.presets
					.map(
						(p) => `
							<button type="button" class="hr-date-preset" data-preset="${p.key}">
								${p.label}
							</button>
						`,
					)
					.join("")}
			</div>
			<div class="hr-date-inputs">
				${this.get_date_input_html("from_date", __("From Date"))}
				${this.get_date_input_html("to_date", __("To Date"))}
			</div>
		`);

		// Native date inputs rather than Desk's Date control: their value is always
		// ISO regardless of the user's display date format, which is exactly what the
		// API wants, and the browser handles the picker and keyboard entry.
		this.$from = this.$filters.find('[data-field="from_date"]');
		this.$to = this.$filters.find('[data-field="to_date"]');
		this.$from.val(this.from_date);
		this.$to.val(this.to_date);

		if (this.is_hr_admin) this.setup_employee_picker();

		this.$filters.on("click", ".hr-date-preset", (e) => {
			this.apply_preset($(e.currentTarget).attr("data-preset"));
		});
		this.$filters.on("change", ".hr-date-input", () => this.on_date_change());
		this.sync_preset_state();
	}

	setup_employee_picker() {
		const $field = this.$filters.find(".hr-employee-picker-field");

		// A standard Link control rather than a hand-rolled dropdown: it gets
		// search-as-you-type and permission-respecting results for free, the same
		// way Desk's own Link fields do -- so a restricted HR User only ever sees
		// employees they could already open the Employee form for.
		this.employee_control = frappe.ui.form.make_control({
			df: {
				fieldname: "employee",
				fieldtype: "Link",
				options: "Employee",
				label: __("Employee"),
				placeholder: __("Search employees by name or ID"),
				get_query: () => ({ filters: { status: "Active" } }),
				onchange: () => {
					const value = this.employee_control.get_value() || null;
					if (value === this.selected_employee) return;
					this.selected_employee = value;
					this.fetch();
				},
			},
			parent: $field.get(0),
			render_input: true,
		});
		this.employee_control.refresh();

		// Stated up front, not just when the page is otherwise empty -- an admin who
		// opens on their own record wouldn't otherwise learn this field can browse
		// other employees at all.
		$(`
			<div class="hr-employee-picker-hint text-muted">
				${__("Look up any employee to view their dashboard")}
			</div>
		`).appendTo($field);
	}

	get_date_input_html(fieldname, label) {
		return `
			<label class="hr-date-field">
				<span class="hr-date-label">${label}</span>
				<input
					type="date"
					class="form-control input-with-feedback hr-date-input"
					data-field="${fieldname}"
					aria-label="${label}"
				>
			</label>
		`;
	}

	get_preset_range(key) {
		const today = frappe.datetime.get_today();
		const on_today = () => moment(today);
		const as_date = (m) => m.format("YYYY-MM-DD");

		switch (key) {
			case "last_month": {
				const last_month = on_today().subtract(1, "month");
				return [
					as_date(last_month.clone().startOf("month")),
					as_date(last_month.endOf("month")),
				];
			}
			case "last_3_months":
				// Inclusive of the current month, so "3 months" counts three month labels.
				return [as_date(on_today().subtract(2, "month").startOf("month")), today];
			case "this_year":
				return [as_date(on_today().startOf("year")), today];
			default:
				return [as_date(on_today().startOf("month")), today];
		}
	}

	apply_preset(key) {
		const [from_date, to_date] = this.get_preset_range(key);
		if (from_date === this.from_date && to_date === this.to_date) return;

		this.from_date = from_date;
		this.to_date = to_date;
		this.$from.val(from_date);
		this.$to.val(to_date);
		this.sync_preset_state();
		this.fetch();
	}

	on_date_change() {
		const from_date = this.$from.val();
		const to_date = this.$to.val();

		// A cleared or half-entered date reads as "". Re-picking the date that was
		// already set still fires change, so a no-op stops here rather than refetching.
		if (!from_date || !to_date) return;
		if (from_date === this.from_date && to_date === this.to_date) return;

		const revert = (message) => {
			frappe.show_alert({ message: message, indicator: "orange" });
			this.$from.val(this.from_date);
			this.$to.val(this.to_date);
		};

		// Native date inputs give ISO values, so a string compare is a date compare.
		if (from_date > to_date) {
			revert(__("From Date cannot be after To Date"));
			return;
		}

		// Mirrors the server's cap; the attendance query behind this is unpaged.
		if (moment(to_date).diff(moment(from_date), "days") > 366) {
			revert(__("Please select a range of one year or less"));
			return;
		}

		this.from_date = from_date;
		this.to_date = to_date;
		this.sync_preset_state();
		this.fetch();
	}

	sync_preset_state() {
		// A hand-picked range that happens to match a preset still lights it up, which
		// saves carrying a separate "Custom" chip.
		const match = this.presets.find((p) => {
			const [from_date, to_date] = this.get_preset_range(p.key);
			return from_date === this.from_date && to_date === this.to_date;
		});

		this.$filters.find(".hr-date-preset").removeClass("active");
		if (match) this.$filters.find(`[data-preset="${match.key}"]`).addClass("active");
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
		const name = frappe.utils.escape_html(employee.employee_name || "");
		// An admin browsing someone else's data gets a title that makes whose
		// dashboard this is unmistakable, rather than a first-person "Welcome".
		const is_self = employee.user_id === frappe.session.user;
		const heading = is_self ? __("Welcome, {0}", [name]) : __("{0}'s Dashboard", [name]);

		return `
			<div class="hr-dashboard-hero">
				${frappe.avatar(employee.user_id, "avatar-large hr-dashboard-hero-avatar")}
				<div>
					<h4>${heading}</h4>
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

		const cards = [
			{ icon: "calendar", value: present_days, label: __("Days Present"), color: "blue" },
			{ icon: "clock", value: total_hours, label: __("Working Hours"), color: "green" },
			{ icon: "activity", value: avg_hours, label: __("Avg Hours / Day"), color: "cyan" },
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

		// Day-of-month alone keeps the axis readable within a single month, but repeats
		// itself once the selected range spans more than one.
		const months = new Set(chronological.map((a) => a.attendance_date.slice(0, 7)));
		const format_label = (date) =>
			months.size > 1 ? moment(date).format("D MMM") : date.split("-")[2];

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
				labels: chronological.map((a) => format_label(a.attendance_date)),
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
		// Balances come from the active leave allocation period, not the selected range,
		// so the heading says so rather than looking like it failed to update.
		const heading = `
			<div class="hr-dashboard-section-header">
				<h5 class="hr-dashboard-section-title">${__("Leave Balance")}</h5>
				<span class="hr-section-note text-muted">${__("Current leave period")}</span>
			</div>
		`;

		const entries = Object.entries(leave_balance || {});
		if (!entries.length) {
			return `
				${heading}
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
			${heading}
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
