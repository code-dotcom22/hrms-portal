frappe.listview_settings["Employee Checkin"] = {
	add_fields: ["offshift"],
	get_indicator: function (doc) {
		if (doc.offshift) {
			return [__("Off-Shift"), "yellow", "offshift,=,1"];
		}
	},
	onload: function (listview) {
		listview.page.add_inner_button(__("Export Attendance"), () => {
			const dialog = new frappe.ui.Dialog({
				title: __("Export Attendance"),
				fields: [
					{
						fieldtype: "HTML",
						options: `<p class="text-muted small">${__(
							"Exports check-in logs for all employees in the selected date range.",
						)}</p>`,
					},
					{
						fieldname: "from_date",
						label: __("From Date"),
						fieldtype: "Date",
						default: frappe.datetime.month_start(),
						reqd: 1,
					},
					{
						fieldname: "to_date",
						label: __("To Date"),
						fieldtype: "Date",
						default: frappe.datetime.get_today(),
						reqd: 1,
					},
				],
				primary_action_label: __("Export CSV"),
				primary_action: (values) => {
					frappe.call({
						method: "hrms.api.export_employee_checkins",
						args: values,
						freeze: true,
						freeze_message: __("Preparing export..."),
						callback: (r) => {
							if (!r.message?.rows?.length) {
								frappe.msgprint(__("No check-in records found for the selected filters."));
								return;
							}
							frappe.tools.downloadify(r.message.rows, null, r.message.filename);
							frappe.show_alert({
								message: __("Attendance exported"),
								indicator: "green",
							});
						},
					});
					dialog.hide();
				},
			});
			dialog.show();
		});

		listview.page.add_action_item(__("Fetch Shifts"), () => {
			const checkins = listview.get_checked_items().map((checkin) => checkin.name);
			frappe.call({
				method: "hrms.hr.doctype.employee_checkin.employee_checkin.bulk_fetch_shift",
				freeze: true,
				args: {
					checkins,
				},
			});
		});
	},
};
