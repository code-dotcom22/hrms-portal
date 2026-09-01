frappe.listview_settings["Attendance"] = {
	add_fields: ["status", "attendance_date"],

	get_indicator: function (doc) {
		if (["Present", "Work From Home"].includes(doc.status)) {
			return [__(doc.status), "green", "status,=," + doc.status];
		} else if (["Absent", "On Leave"].includes(doc.status)) {
			return [__(doc.status), "red", "status,=," + doc.status];
		} else if (doc.status == "Half Day") {
			return [__(doc.status), "orange", "status,=," + doc.status];
		}
	},
	onload: function (list_view) {
		if (frappe.user.has_role(["System Manager", "HR Manager", "HR User"])) {
			list_view.page.add_inner_button(__("Export Attendance"), function () {
				const dialog = new frappe.ui.Dialog({
					title: __("Export Attendance"),
					fields: [
						{
							fieldtype: "HTML",
							options: `<p class="text-muted small">${__(
								"Exports attendance for all companies and all employees in the selected date range.",
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
					primary_action: function (values) {
						frappe.call({
							method: "hrms.api.export_attendance_summary",
							args: values,
							freeze: true,
							freeze_message: __("Preparing export..."),
							callback: function (r) {
								if (!r.message?.rows?.length) {
									frappe.msgprint(
										__("No attendance records found for the selected filters."),
									);
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
		}

		let me = this;
		if (frappe.perm.has_perm("Attendance", 0, "create")) {
			list_view.page.add_inner_button(__("Mark Attendance"), function () {
				let first_day_of_month = moment().startOf("month");

				if (moment().toDate().getDate() === 1) {
					first_day_of_month = first_day_of_month.subtract(1, "month");
				}

				let dialog = new frappe.ui.Dialog({
					title: __("Mark Attendance"),
					fields: [
						{
							fieldname: "employee",
							label: __("For Employee"),
							fieldtype: "Link",
							options: "Employee",
							get_query: () => {
								return {
									query: "erpnext.controllers.queries.employee_query",
								};
							},
							reqd: 1,
							onchange: () => me.reset_dialog(dialog),
						},
						{
							fieldtype: "Section Break",
							fieldname: "time_period_section",
							hidden: 1,
						},
						{
							label: __("Start"),
							fieldtype: "Date",
							fieldname: "from_date",
							reqd: 1,
							default: first_day_of_month.toDate(),
							onchange: () => me.get_unmarked_days(dialog),
						},
						{
							label: __("Status"),
							fieldtype: "Select",
							fieldname: "status",
							options: ["Present", "Absent", "Half Day", "Work From Home"],
							reqd: 1,
						},
						{
							fieldtype: "Column Break",
							fieldname: "time_period_column",
						},
						{
							label: __("End"),
							fieldtype: "Date",
							fieldname: "to_date",
							reqd: 1,
							default: moment().toDate(),
							onchange: () => me.get_unmarked_days(dialog),
						},
						{
							label: __("Shift"),
							fieldtype: "Link",
							fieldname: "shift",
							options: "Shift Type",
						},

						{
							fieldtype: "Section Break",
							fieldname: "days_section",
							hidden: 1,
						},
						{
							label: __("Exclude Holidays"),
							fieldtype: "Check",
							fieldname: "exclude_holidays",
							onchange: () => me.get_unmarked_days(dialog),
						},
						{
							label: __("Unmarked Attendance for days"),
							fieldname: "unmarked_days",
							fieldtype: "MultiCheck",
							options: [],
							columns: 2,
							select_all: true,
						},
					],
					primary_action(data) {
						if (cur_dialog.no_unmarked_days_left) {
							frappe.msgprint(
								__(
									"Attendance from {0} to {1} has already been marked for the Employee {2}",
									[data.from_date, data.to_date, data.employee],
								),
							);
						} else {
							frappe.confirm(
								__("Mark attendance as {0} for {1} on selected dates?", [
									data.status,
									data.employee,
								]),
								() => {
									frappe.call({
										method: "hrms.hr.doctype.attendance.attendance.mark_bulk_attendance",
										args: {
											data: data,
										},
									});
								},
							);
						}
						dialog.hide();
						list_view.refresh();
					},
					primary_action_label: __("Mark Attendance"),
				});
				dialog.show();
			});
		}
	},

	reset_dialog: function (dialog) {
		let fields = dialog.fields_dict;

		dialog.set_df_property("time_period_section", "hidden", fields.employee.value ? 0 : 1);
		dialog.set_df_property("days_section", "hidden", 1);
		dialog.set_df_property("unmarked_days", "options", []);
		dialog.no_unmarked_days_left = false;
		fields.exclude_holidays.value = false;

		fields.to_date.datepicker.update({
			maxDate: moment().toDate(),
		});

		this.get_unmarked_days(dialog);
	},

	get_unmarked_days: function (dialog) {
		let fields = dialog.fields_dict;
		if (fields.employee.value && fields.from_date.value && fields.to_date.value) {
			dialog.set_df_property("days_section", "hidden", 0);
			dialog.set_df_property("status", "hidden", 0);
			dialog.set_df_property("exclude_holidays", "hidden", 0);
			dialog.no_unmarked_days_left = false;

			frappe
				.call({
					method: "hrms.hr.doctype.attendance.attendance.get_unmarked_days",
					async: false,
					args: {
						employee: fields.employee.value,
						from_date: fields.from_date.value,
						to_date: fields.to_date.value,
						exclude_holidays: fields.exclude_holidays.value,
					},
				})
				.then((r) => {
					var options = [];

					for (var d in r.message) {
						var momentObj = moment(r.message[d], "YYYY-MM-DD");
						var date = momentObj.format("DD-MM-YYYY");
						options.push({
							label: date,
							value: r.message[d],
							checked: 1,
						});
					}

					dialog.set_df_property(
						"unmarked_days",
						"options",
						options.length > 0 ? options : [],
					);
					dialog.no_unmarked_days_left = options.length === 0;
				});
		}
	},
};
