frappe.pages["hr-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("My Dashboard"),
		single_column: true,
	});

	page.set_primary_action(__("Go to Frappe HR"), () => {
		frappe.set_route("hr-setup");
	});

	new hrms.HRDashboard(page);
};

hrms.HRDashboard = class HRDashboard {
	constructor(page) {
		this.page = page;
		this.wrapper = $('<div class="hr-dashboard"></div>').appendTo(this.page.main);
		this.render_loading();
		this.fetch();
	}

	render_loading() {
		this.wrapper.html(
			`<div class="text-muted text-center" style="padding: 60px 0;">${__("Loading...")}</div>`,
		);
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
				this.wrapper.html(
					`<div class="text-muted text-center" style="padding: 60px 0;">${__(
						"Could not load your dashboard.",
					)}</div>`,
				);
			},
		});
	}

	render() {
		const { employee, attendance, leave_applications, leave_balance } = this.data;

		const present_days = attendance.filter((a) => a.status === "Present").length;
		const total_hours = attendance
			.reduce((sum, a) => sum + (a.working_hours || 0), 0)
			.toFixed(1);

		const leave_balance_cards =
			Object.entries(leave_balance || {})
				.map(
					([leave_type, d]) => `
						<div class="hr-dashboard-card">
							<div class="hr-dashboard-stat-value">${d.balance_leaves ?? 0}</div>
							<div class="hr-dashboard-stat-label">${frappe.utils.escape_html(leave_type)}</div>
						</div>
					`,
				)
				.join("") || `<p class="text-muted">${__("No leave allocated")}</p>`;

		const attendance_rows =
			attendance
				.map(
					(a) => `
						<tr>
							<td>${frappe.datetime.str_to_user(a.attendance_date)}</td>
							<td>${frappe.utils.escape_html(a.status)}</td>
							<td>${a.working_hours || 0}</td>
						</tr>
					`,
				)
				.join("") || `<tr><td colspan="3">${__("No records")}</td></tr>`;

		const leave_rows =
			(leave_applications || [])
				.map(
					(l) => `
						<tr>
							<td>${frappe.utils.escape_html(l.leave_type)}</td>
							<td>${frappe.datetime.str_to_user(l.from_date)} - ${frappe.datetime.str_to_user(
								l.to_date,
							)}</td>
							<td>${l.total_leave_days}</td>
							<td>${frappe.utils.escape_html(l.status)}</td>
						</tr>
					`,
				)
				.join("") || `<tr><td colspan="4">${__("No records")}</td></tr>`;

		this.wrapper.html(`
			<div class="hr-dashboard-body">
				<h4>${__("Welcome")}, ${frappe.utils.escape_html(employee.employee_name || "")}</h4>

				<div class="hr-dashboard-row">
					<div class="hr-dashboard-card">
						<div class="hr-dashboard-stat-value">${present_days}</div>
						<div class="hr-dashboard-stat-label">${__("Days Present")}</div>
					</div>
					<div class="hr-dashboard-card">
						<div class="hr-dashboard-stat-value">${total_hours}</div>
						<div class="hr-dashboard-stat-label">${__("Working Hours")}</div>
					</div>
					<div class="hr-dashboard-card">
						<div class="hr-dashboard-stat-value">${(leave_applications || []).length}</div>
						<div class="hr-dashboard-stat-label">${__("Leave Applications")}</div>
					</div>
				</div>

				<h5>${__("Leave Balance")}</h5>
				<div class="hr-dashboard-row">${leave_balance_cards}</div>

				<h5>${__("Attendance")}</h5>
				<table class="table table-bordered">
					<thead>
						<tr>
							<th>${__("Date")}</th>
							<th>${__("Status")}</th>
							<th>${__("Working Hours")}</th>
						</tr>
					</thead>
					<tbody>${attendance_rows}</tbody>
				</table>

				<h5>${__("Leave Applications")}</h5>
				<table class="table table-bordered">
					<thead>
						<tr>
							<th>${__("Leave Type")}</th>
							<th>${__("Dates")}</th>
							<th>${__("Days")}</th>
							<th>${__("Status")}</th>
						</tr>
					</thead>
					<tbody>${leave_rows}</tbody>
				</table>
			</div>
		`);
	}
};
