frappe.pages["hr-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("My Dashboard"),
		single_column: true,
	});

	new hrms.HRDashboard(page);
};

hrms.HRDashboard = class HRDashboard {
	constructor(page) {
		this.page = page;
		this.wrapper = $('<div class="hr-dashboard"></div>').appendTo(this.page.main);

		if (!this.is_eligible_employee()) {
			// A stale `redirect-to` (e.g. from a session that expired while sitting on
			// this page), a bookmark, or a typed-in URL can land a System Manager/HR
			// Manager/HR User/non-employee account here even though hrms.hr.utils.
			// get_employee_home_page never sends them here on login. There's no
			// employee data to show them, so bounce to the normal Desk instead of
			// rendering a page that can only ever error out.
			frappe.set_route("");
			return;
		}

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

		this.wrapper.on("click", ".hr-app-card", (e) => {
			e.preventDefault();
			frappe.set_route($(e.currentTarget).attr("data-route"));
		});
		this.render_message(__("Loading..."));
		this.fetch();
	}

	is_eligible_employee() {
		// Mirrors the role check in hrms.hr.utils.get_employee_home_page.
		const roles = frappe.user_roles || [];
		const elevated_roles = ["System Manager", "HR Manager", "HR User"];
		if (elevated_roles.some((role) => roles.includes(role))) return false;
		return roles.includes("Employee");
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
				${this.get_leave_balance_html(leave_balance)}
				${this.get_table_section_html(
					__("Attendance"),
					[__("Date"), __("Status"), __("Working Hours")],
					this.get_attendance_rows_html(attendance),
				)}
				${this.get_table_section_html(
					__("Leave Applications"),
					[__("Leave Type"), __("Dates"), __("Days"), __("Status")],
					this.get_leave_application_rows_html(leave_applications),
				)}
				${this.get_app_switcher_html()}
			</div>
		`);
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
		const total_hours = attendance
			.reduce((sum, a) => sum + (a.working_hours || 0), 0)
			.toFixed(1);

		const cards = [
			{ icon: "calendar", value: present_days, label: __("Days Present"), color: "blue" },
			{ icon: "clock", value: total_hours, label: __("Working Hours"), color: "green" },
			{
				icon: "check-circle",
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

		return attendance
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

	get_table_section_html(title, headers, rows_html) {
		return `
			<h5 class="hr-dashboard-section-title">${title}</h5>
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
