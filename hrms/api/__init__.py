import frappe
from frappe import _
from frappe.model import get_permitted_fields
from frappe.model.workflow import get_workflow_name
from frappe.query_builder import Order
from frappe.utils import add_days, cint, date_diff, flt, get_first_day, getdate, strip_html

from erpnext.setup.doctype.employee.employee import get_holiday_list_for_employee

SUPPORTED_FIELD_TYPES = [
	"Link",
	"Select",
	"Small Text",
	"Text",
	"Long Text",
	"Text Editor",
	"Table",
	"Check",
	"Data",
	"Float",
	"Int",
	"Section Break",
	"Date",
	"Time",
	"Datetime",
	"Currency",
]

MAX_SUMMARY_RANGE_DAYS = 366

# Roles allowed to look past their own record: browse another employee's dashboard,
# and read the company-wide daily snapshot.
ELEVATED_HR_ROLES = ("System Manager", "HR Manager", "HR User")

ATTENDANCE_STATUSES = ("Present", "Absent", "On Leave", "Half Day", "Work From Home")

# Half Day counts here too -- the person did turn up, just not for the full day.
AT_WORK_STATUSES = ("Present", "Work From Home", "Half Day")

EMPLOYEE_SUMMARY_FIELDS = [
	"name",
	"first_name",
	"employee_name",
	"designation",
	"department",
	"company",
	"reports_to",
	"user_id",
]


@frappe.whitelist()
def get_current_user_info() -> dict:
	current_user = frappe.session.user
	user = frappe.db.get_value(
		"User", current_user, ["name", "first_name", "full_name", "user_image"], as_dict=True
	)
	user["roles"] = frappe.get_roles(current_user)

	return user


def get_employee_info(employee: str) -> dict | None:
	return frappe.db.get_value("Employee", employee, EMPLOYEE_SUMMARY_FIELDS, as_dict=True)


@frappe.whitelist()
def get_current_employee_info() -> dict:
	current_user = frappe.session.user
	employee = frappe.db.get_value("Employee", {"user_id": current_user, "status": "Active"}, "name")
	return get_employee_info(employee) if employee else None


@frappe.whitelist()
def get_all_employees() -> list[dict]:
	return frappe.get_list(
		"Employee",
		fields=[
			"name",
			"employee_name",
			"designation",
			"department",
			"company",
			"reports_to",
			"user_id",
			"image",
			"status",
		],
		limit=999999,
	)


@frappe.whitelist()
def get_reports_to_employee_name(employee: str) -> str:
	reports_to = frappe.db.get_value(
		"Employee", {"user_id": frappe.session.user, "status": "Active"}, "reports_to"
	)
	if not reports_to or reports_to != employee:
		frappe.throw(_("Not permitted"), frappe.PermissionError)

	return frappe.db.get_value("Employee", employee, "employee_name") or ""


def get_current_employee() -> str:
	info = get_current_employee_info()
	employee = info.get("name") if info else None
	if not employee:
		frappe.throw(_("Employee not found"), frappe.PermissionError)
	return employee


# HR Settings
@frappe.whitelist()
def get_hr_settings() -> dict:
	settings = frappe.db.get_singles_dict("HR Settings", cast=True)
	return frappe._dict(
		allow_employee_checkin_from_mobile_app=settings.allow_employee_checkin_from_mobile_app,
		allow_geolocation_tracking=settings.allow_geolocation_tracking,
		prevent_self_leave_approval=settings.prevent_self_leave_approval,
	)


# Notifications
@frappe.whitelist()
def get_unread_notifications_count() -> int:
	return frappe.db.count(
		"PWA Notification",
		{"to_user": frappe.session.user, "read": 0},
	)


@frappe.whitelist()
def mark_all_notifications_as_read() -> None:
	frappe.db.set_value(
		"PWA Notification",
		{"to_user": frappe.session.user, "read": 0},
		"read",
		1,
		update_modified=False,
	)


@frappe.whitelist()
def mark_notification_as_read(name: str) -> None:
	"""Mark a single notification as read.

	Employees only get read permission on PWA Notification, so this can't be done from
	the client. Scoping the filter to the session user means someone else's notification
	is simply a no-op rather than something we need to raise on.
	"""
	frappe.db.set_value(
		"PWA Notification",
		{"name": name, "to_user": frappe.session.user},
		"read",
		1,
		update_modified=False,
	)


@frappe.whitelist()
def are_push_notifications_enabled() -> bool:
	try:
		return frappe.db.get_single_value("Push Notification Settings", "enable_push_notification_relay")
	except frappe.DoesNotExistError:
		# push notifications are not supported in the current framework version
		return False


# Login / Dashboard summary
@frappe.whitelist()
def get_employee_login_summary(
	employee: str | None = None, from_date: str | None = None, to_date: str | None = None
) -> dict:
	"""Attendance (incl. working hours) and leave snapshot for an employee.

	Meant to be called once by the client right after a session is established
	via /api/method/login, so the client isn't hunting through Attendance,
	Leave Application and Leave Allocation separately.

	Defaults to the logged-in employee. HR/admin roles may pass `employee` to view
	someone else's summary instead -- gated by the same read permission Desk itself
	enforces on the Employee doctype, so a restricted HR User only reaches whoever
	they could already open the Employee form for.

	Both dates are optional and default to the current month to date. The dashboard
	passes an explicit range when the user picks one.
	"""
	if employee:
		frappe.has_permission("Employee", "read", employee, throw=True)
		employee_info = get_employee_info(employee)
		if not employee_info:
			frappe.throw(_("Employee not found"), frappe.DoesNotExistError)
	else:
		employee_info = get_current_employee_info()
		if not employee_info:
			# No Employee record linked to this session user -- an admin-only account
			# rather than a genuine Employee login. Nothing to show yet; the client
			# renders an empty state (with an employee picker, for elevated roles)
			# instead of the PermissionError get_current_employee() would raise.
			return frappe._dict(employee=None, attendance=[], leave_applications=[], leave_balance={})

	employee = employee_info.name

	to_date = getdate(to_date) if to_date else getdate()
	from_date = getdate(from_date) if from_date else get_first_day(to_date)

	if from_date > to_date:
		frappe.throw(_("From Date cannot be after To Date"), frappe.ValidationError)

	# The attendance query below is unpaged, so a caller-supplied range needs an upper
	# bound; a year covers every range the dashboard offers.
	if date_diff(to_date, from_date) > MAX_SUMMARY_RANGE_DAYS:
		frappe.throw(
			_("Please select a range of {0} days or less").format(MAX_SUMMARY_RANGE_DAYS),
			frappe.ValidationError,
		)

	return frappe._dict(
		employee=employee_info,
		attendance=get_attendance_with_working_hours(employee, from_date, to_date),
		leave_applications=get_leave_applications(
			employee, limit=20, from_date=str(from_date), to_date=str(to_date)
		),
		leave_balance=get_leave_balance_map(employee),
	)


def get_attendance_with_working_hours(employee: str, from_date, to_date) -> list[dict]:
	return frappe.get_list(
		"Attendance",
		filters={
			"employee": employee,
			"attendance_date": ["between", [from_date, to_date]],
			"docstatus": 1,
		},
		fields=[
			"name",
			"attendance_date",
			"status",
			"working_hours",
			"in_time",
			"out_time",
			"late_entry",
			"early_exit",
			"shift",
		],
		order_by="attendance_date desc",
	)
# Daily snapshot (HR/admin landing view)
@frappe.whitelist()
def get_hr_daily_snapshot(date: str | None = None) -> dict:
	"""Company-wide attendance picture for a single day.

	Backs the at-a-glance section an HR/admin sees when they open the dashboard,
	before (or instead of) drilling into one employee. Defaults to today; the
	client passes an explicit date when the user steps back through the days.

	Every query goes through `frappe.get_list`, so a restricted HR User only ever
	counts the employees they could already see in a list view -- the role check
	below just keeps the endpoint off the menu for regular employees, whose own
	numbers already come from `get_employee_login_summary`.
	"""
	if not has_elevated_hr_role():
		frappe.throw(_("Not permitted to view company-wide HR statistics"), frappe.PermissionError)

	date = getdate(date) if date else getdate()
	if date > getdate():
		frappe.throw(_("Cannot show a snapshot for a future date"), frappe.ValidationError)

	attendance_filters = {"attendance_date": date, "docstatus": 1}

	status_counts = get_attendance_status_counts(attendance_filters)
	totals = get_attendance_day_totals(attendance_filters)
	marked = sum(status_counts.values())
	headcount = get_headcount_on(date)

	return frappe._dict(
		date=str(date),
		headcount=headcount,
		marked=marked,
		# A day can carry more Attendance records than there are employees still on
		# the books, so this floors at zero rather than going negative and reading
		# like a bug.
		not_marked=max(headcount - marked, 0),
		status_counts=status_counts,
		checked_in=get_checked_in_count(date),
		total_working_hours=flt(totals.total_working_hours, 2),
		# Averaged over people who actually logged hours, matching the per-employee
		# dashboard's "Avg Hours / Day".
		avg_working_hours=flt(
			flt(totals.total_working_hours) / totals.worked_count if totals.worked_count else 0, 2
		),
		late_entries=cint(totals.late_entries),
		early_exits=cint(totals.early_exits),
		pending_leave_approvals=get_pending_leave_approvals_count(),
		department_breakdown=get_department_attendance_breakdown(attendance_filters),
		out_today=get_employees_out_on(attendance_filters),
		recent_checkins=get_recent_checkins(date),
	)


def has_elevated_hr_role(user: str | None = None) -> bool:
	"""The same set the dashboard treats as "elevated" when deciding who may browse
	other employees' data."""
	return bool(set(frappe.get_roles(user or frappe.session.user)) & set(ELEVATED_HR_ROLES))


def get_attendance_status_counts(attendance_filters: dict) -> dict[str, int]:
	rows = frappe.get_list(
		"Attendance",
		filters=attendance_filters,
		fields=["status", {"COUNT": "name", "as": "count"}],
		group_by="status",
		limit_page_length=0,
	)

	# Seeded with every standard status so the client renders a fixed set of tiles
	# rather than a row whose shape changes from one day to the next.
	counts = {status: 0 for status in ATTENDANCE_STATUSES}
	for row in rows:
		# A custom status added to the Select still gets counted rather than dropped.
		counts[row.status] = counts.get(row.status, 0) + cint(row.count)

	return counts


def get_attendance_day_totals(attendance_filters: dict) -> dict:
	# Grouped on the one date the filters already pin, so this is a single row --
	# and, with a group_by present, get_list leaves off the default ordering that
	# a server running ONLY_FULL_GROUP_BY would reject next to an aggregate.
	rows = frappe.get_list(
		"Attendance",
		filters=attendance_filters,
		fields=[
			{"SUM": "working_hours", "as": "total_working_hours"},
			{"SUM": "late_entry", "as": "late_entries"},
			{"SUM": "early_exit", "as": "early_exits"},
		],
		group_by="attendance_date",
	)
	totals = frappe._dict(rows[0]) if rows else frappe._dict()

	# Counted separately: a zero-hour day (leave, absent) shouldn't drag the average
	# down, the same rule the per-employee dashboard applies.
	worked = frappe.get_list(
		"Attendance",
		filters={**attendance_filters, "working_hours": [">", 0]},
		fields=[{"COUNT": "name", "as": "worked_count"}],
		group_by="attendance_date",
	)
	totals.worked_count = cint(worked[0].worked_count) if worked else 0

	return totals


def get_headcount_on(date) -> int:
	"""Employees on the books on `date` -- joined by then and not yet relieved."""
	# Grouped by status only to keep get_list from appending its default ordering
	# next to the aggregate; the handful of rows are summed back together here.
	rows = frappe.get_list(
		"Employee",
		filters=[["date_of_joining", "<=", date], ["status", "!=", "Inactive"]],
		or_filters=[["relieving_date", "is", "not set"], ["relieving_date", ">=", date]],
		fields=[{"COUNT": "name", "as": "count"}],
		group_by="status",
	)

	return sum(cint(row.count) for row in rows)


def get_checked_in_count(date) -> int:
	"""Distinct employees with at least one check-in log on `date`.

	Read separately from Attendance because the two move at different times:
	check-ins land as they happen, while Attendance is only written once the day's
	logs are processed -- so on the current day this is the figure that changes.
	"""
	# Grouped rather than counted DISTINCT: one row per employee, so the result is
	# bounded by headcount even on a day with a lot of in/out punches.
	rows = frappe.get_list(
		"Employee Checkin",
		filters=get_checkin_day_filters(date),
		fields=["employee"],
		group_by="employee",
		limit_page_length=0,
	)

	return len(rows)


def get_pending_leave_approvals_count() -> int:
	"""Leave applications still awaiting a decision -- a backlog rather than a
	figure for one day, so it deliberately ignores the selected date."""
	rows = frappe.get_list(
		"Leave Application",
		filters={"status": "Open", "docstatus": ["<", 2]},
		fields=[{"COUNT": "name", "as": "count"}],
		# The filter already pins the status, so this stays a single row -- it's here
		# to suppress the default ordering get_list would otherwise add.
		group_by="status",
	)

	return cint(rows[0].count) if rows else 0


def get_department_attendance_breakdown(attendance_filters: dict, limit: int = 8) -> list[dict]:
	"""Marked attendance per department, busiest first."""
	rows = frappe.get_list(
		"Attendance",
		filters=attendance_filters,
		fields=["department", "status", {"COUNT": "name", "as": "count"}],
		group_by="department, status",
		limit_page_length=0,
	)

	departments = {}
	for row in rows:
		# Attendance with no department still counts towards the day, under a label
		# rather than against an empty axis tick.
		key = row.department or _("Unassigned")
		entry = departments.setdefault(key, {"department": key, "total": 0, "at_work": 0, "away": 0})
		count = cint(row.count)
		entry["total"] += count
		if row.status in AT_WORK_STATUSES:
			entry["at_work"] += count
		else:
			entry["away"] += count

	return sorted(departments.values(), key=lambda d: d["total"], reverse=True)[:limit]


def get_employees_out_on(attendance_filters: dict, limit: int = 20) -> list[dict]:
	"""Who isn't at work, from the attendance marked for the day."""
	return frappe.get_list(
		"Attendance",
		filters={**attendance_filters, "status": ["in", ["On Leave", "Absent", "Half Day"]]},
		fields=["employee", "employee_name", "department", "status", "leave_type"],
		order_by="status asc, employee_name asc",
		limit=limit,
	)


def get_recent_checkins(date, limit: int = 10) -> list[dict]:
	return frappe.get_list(
		"Employee Checkin",
		filters=get_checkin_day_filters(date),
		fields=["employee", "employee_name", "log_type", "time", "shift"],
		order_by="time desc",
		limit=limit,
	)


def get_checkin_day_filters(date) -> dict:
	# `time` is a Datetime, so a plain equality on the date won't match; bound the day.
	return {"time": ["between", [f"{date} 00:00:00", f"{date} 23:59:59.999999"]]}
# Every tile on the snapshot stands for a set of people, so each one can be opened.
# Keyed by the metric the client sends; the five attendance ones differ only by status.
SNAPSHOT_STATUS_METRICS = {
	"present": "Present",
	"work_from_home": "Work From Home",
	"on_leave": "On Leave",
	"half_day": "Half Day",
	"absent": "Absent",
}

# Rows shown in a drill-down before it stops being something you read at a glance.
SNAPSHOT_BREAKDOWN_LIMIT = 100


@frappe.whitelist()
def get_hr_snapshot_breakdown(metric: str, date: str | None = None) -> dict:
	"""The employees behind one number on the daily snapshot.

	The client opens this when a tile is clicked. Rather than the caller knowing
	what shape each metric returns, every branch answers with the same envelope --
	`columns` describing what to render and `rows` carrying it -- so one renderer
	handles all of them.
	"""
	if not has_elevated_hr_role():
		frappe.throw(_("Not permitted to view company-wide HR statistics"), frappe.PermissionError)

	date = getdate(date) if date else getdate()
	if date > getdate():
		frappe.throw(_("Cannot show a snapshot for a future date"), frappe.ValidationError)

	if metric in SNAPSHOT_STATUS_METRICS:
		result = get_attendance_breakdown(date, SNAPSHOT_STATUS_METRICS[metric])
	elif metric == "checked_in":
		result = get_checked_in_breakdown(date)
	elif metric == "not_marked":
		result = get_not_marked_breakdown(date)
	elif metric in ("late_entries", "early_exits"):
		result = get_exception_breakdown(date, metric)
	elif metric == "avg_working_hours":
		result = get_working_hours_breakdown(date)
	elif metric == "pending_leave_approvals":
		result = get_pending_leave_breakdown()
	else:
		frappe.throw(_("Unknown metric {0}").format(metric), frappe.ValidationError)

	result.metric = metric
	result.date = str(date)
	# The client says so out loud rather than quietly showing a short list.
	result.truncated = len(result.rows) >= SNAPSHOT_BREAKDOWN_LIMIT

	return result


def attendance_columns(*extra: dict) -> list[dict]:
	return [
		{"label": _("Employee"), "fieldname": "employee_name"},
		{"label": _("Department"), "fieldname": "department", "format": "department"},
		*extra,
	]


def get_attendance_breakdown(date, status: str) -> dict:
	rows = frappe.get_list(
		"Attendance",
		filters={"attendance_date": date, "docstatus": 1, "status": status},
		fields=[
			"employee",
			"employee_name",
			"department",
			"leave_type",
			"working_hours",
			"in_time",
			"out_time",
		],
		order_by="employee_name asc",
		limit=SNAPSHOT_BREAKDOWN_LIMIT,
	)

	# On Leave has no hours worth a column, but it does have a reason.
	if status == "On Leave":
		extra = [{"label": _("Leave Type"), "fieldname": "leave_type"}]
	else:
		extra = [
			{"label": _("In"), "fieldname": "in_time", "format": "time"},
			{"label": _("Out"), "fieldname": "out_time", "format": "time"},
			{"label": _("Hours"), "fieldname": "working_hours", "format": "hours"},
		]

	return frappe._dict(columns=attendance_columns(*extra), rows=rows)


def get_checked_in_breakdown(date) -> dict:
	"""One row per employee, from their check-in logs for the day.

	Grouped on employee (and the name that comes with it, so ordering by it stays
	valid under ONLY_FULL_GROUP_BY) -- the first and last punch bracket their day.
	"""
	rows = frappe.get_list(
		"Employee Checkin",
		filters=get_checkin_day_filters(date),
		fields=[
			"employee",
			"employee_name",
			{"MIN": "time", "as": "first_time"},
			{"MAX": "time", "as": "last_time"},
			{"COUNT": "name", "as": "logs"},
		],
		group_by="employee, employee_name",
		order_by="employee_name asc",
		limit=SNAPSHOT_BREAKDOWN_LIMIT,
	)

	return frappe._dict(
		columns=[
			{"label": _("Employee"), "fieldname": "employee_name"},
			{"label": _("First In"), "fieldname": "first_time", "format": "time"},
			{"label": _("Last Log"), "fieldname": "last_time", "format": "time"},
			{"label": _("Logs"), "fieldname": "logs"},
		],
		rows=rows,
	)


def get_not_marked_breakdown(date) -> dict:
	"""Employees on the books with no attendance recorded for the day."""
	marked = frappe.get_list(
		"Attendance",
		filters={"attendance_date": date, "docstatus": 1},
		pluck="employee",
		limit_page_length=0,
	)

	filters = [["date_of_joining", "<=", date], ["status", "!=", "Inactive"]]
	if marked:
		filters.append(["name", "not in", marked])

	rows = frappe.get_list(
		"Employee",
		filters=filters,
		or_filters=[["relieving_date", "is", "not set"], ["relieving_date", ">=", date]],
		fields=["name as employee", "employee_name", "department", "designation"],
		order_by="employee_name asc",
		limit=SNAPSHOT_BREAKDOWN_LIMIT,
	)

	return frappe._dict(
		columns=attendance_columns({"label": _("Designation"), "fieldname": "designation"}),
		rows=rows,
	)


def get_exception_breakdown(date, metric: str) -> dict:
	"""Late arrivals or early departures, as flagged on the day's attendance."""
	fieldname = "late_entry" if metric == "late_entries" else "early_exit"

	rows = frappe.get_list(
		"Attendance",
		filters={"attendance_date": date, "docstatus": 1, fieldname: 1},
		fields=[
			"employee",
			"employee_name",
			"department",
			"status",
			"in_time",
			"out_time",
			"working_hours",
		],
		order_by="employee_name asc",
		limit=SNAPSHOT_BREAKDOWN_LIMIT,
	)

	return frappe._dict(
		columns=attendance_columns(
			{"label": _("In"), "fieldname": "in_time", "format": "time"},
			{"label": _("Out"), "fieldname": "out_time", "format": "time"},
			{"label": _("Hours"), "fieldname": "working_hours", "format": "hours"},
		),
		rows=rows,
	)


def get_working_hours_breakdown(date) -> dict:
	"""Everyone who logged time, longest day first -- the figures behind the average."""
	rows = frappe.get_list(
		"Attendance",
		filters={"attendance_date": date, "docstatus": 1, "working_hours": [">", 0]},
		fields=["employee", "employee_name", "department", "status", "working_hours"],
		order_by="working_hours desc",
		limit=SNAPSHOT_BREAKDOWN_LIMIT,
	)

	return frappe._dict(
		columns=attendance_columns(
			{"label": _("Status"), "fieldname": "status", "format": "status"},
			{"label": _("Hours"), "fieldname": "working_hours", "format": "hours"},
		),
		rows=rows,
	)


def get_pending_leave_breakdown() -> dict:
	"""Deliberately not scoped to the selected day -- this tile is a backlog."""
	rows = frappe.get_list(
		"Leave Application",
		filters={"status": "Open", "docstatus": ["<", 2]},
		fields=[
			"employee",
			"employee_name",
			"department",
			"leave_type",
			"from_date",
			"to_date",
			"total_leave_days",
		],
		order_by="from_date asc",
		limit=SNAPSHOT_BREAKDOWN_LIMIT,
	)

	return frappe._dict(
		columns=attendance_columns(
			{"label": _("Leave Type"), "fieldname": "leave_type"},
			{"label": _("From"), "fieldname": "from_date", "format": "date"},
			{"label": _("To"), "fieldname": "to_date", "format": "date"},
			{"label": _("Days"), "fieldname": "total_leave_days"},
		),
		rows=rows,
	)


# Attendance
@frappe.whitelist()
def get_attendance_calendar_events(from_date: str, to_date: str) -> dict[str, str]:
	employee = get_current_employee()
	holidays = get_holidays_for_calendar(employee, from_date, to_date)
	attendance = get_attendance_for_calendar(employee, from_date, to_date)
	events = {}

	date = getdate(from_date)
	while date_diff(to_date, date) >= 0:
		date_str = date.strftime("%Y-%m-%d")
		if date in attendance:
			events[date_str] = attendance[date]
		elif date in holidays:
			events[date_str] = "Holiday"
		date = add_days(date, 1)

	return events


def get_attendance_for_calendar(employee: str, from_date: str, to_date: str) -> list[dict[str, str]]:
	attendance = frappe.get_all(
		"Attendance",
		{"employee": employee, "attendance_date": ["between", [from_date, to_date]], "docstatus": 1},
		["attendance_date", "status"],
	)
	return {d["attendance_date"]: d["status"] for d in attendance}


def get_holidays_for_calendar(employee: str, from_date: str, to_date: str) -> list[str]:
	if holiday_list := get_holiday_list_for_employee(employee, raise_exception=False):
		return frappe.get_all(
			"Holiday",
			filters={"parent": holiday_list, "holiday_date": ["between", [from_date, to_date]]},
			pluck="holiday_date",
		)

	return []


@frappe.whitelist()
def get_shift_requests(
	employee: str,
	approver_id: str | None = None,
	for_approval: bool = False,
	limit: int | None = None,
) -> list[dict]:
	filters = get_filters("Shift Request", employee, approver_id, for_approval)
	fields = [
		"name",
		"employee",
		"employee_name",
		"shift_type",
		"from_date",
		"to_date",
		"status",
		"approver",
		"docstatus",
		"creation",
	]

	if workflow_state_field := get_workflow_state_field("Shift Request"):
		fields.append(workflow_state_field)

	shift_requests = frappe.get_list(
		"Shift Request",
		fields=fields,
		filters=filters,
		order_by="creation desc",
		limit=limit,
	)

	if workflow_state_field:
		for application in shift_requests:
			application["workflow_state_field"] = workflow_state_field

	return shift_requests


@frappe.whitelist()
def get_attendance_requests(
	employee: str,
	for_approval: bool = False,
	limit: int | None = None,
) -> list[dict]:
	filters = get_filters("Attendance Request", employee, None, for_approval)
	fields = [
		"name",
		"reason",
		"employee",
		"employee_name",
		"from_date",
		"to_date",
		"include_holidays",
		"shift",
		"docstatus",
		"creation",
	]

	if workflow_state_field := get_workflow_state_field("Attendance Request"):
		fields.append(workflow_state_field)

	attendance_requests = frappe.get_list(
		"Attendance Request",
		fields=fields,
		filters=filters,
		order_by="creation desc",
		limit=limit,
	)

	if workflow_state_field:
		for application in attendance_requests:
			application["workflow_state_field"] = workflow_state_field

	return attendance_requests


def get_filters(
	doctype: str,
	employee: str,
	approver_id: str | None = None,
	for_approval: bool = False,
) -> dict:
	filters = frappe._dict()
	if for_approval:
		filters.docstatus = 0
		filters.employee = ("!=", employee)

		if workflow := get_workflow(doctype):
			allowed_states = get_allowed_states_for_workflow(workflow, approver_id)
			filters[workflow.workflow_state_field] = ("in", allowed_states)
		elif doctype != "Attendance Request":
			approver_field_map = {
				"Shift Request": "approver",
				"Leave Application": "leave_approver",
				"Expense Claim": "expense_approver",
			}
			filters.status = "Open" if doctype == "Leave Application" else "Draft"
			if approver_id:
				filters[approver_field_map[doctype]] = approver_id
	else:
		filters.docstatus = ("!=", 2)
		filters.employee = employee

	return filters


@frappe.whitelist()
def get_shift_request_approvers(employee: str) -> str | list[str]:
	frappe.has_permission("Employee", "read", employee, throw=True)

	shift_request_approver, department = frappe.get_cached_value(
		"Employee",
		employee,
		["shift_request_approver", "department"],
	)

	department_approvers = []
	if department:
		frappe.has_permission("Department", "read", department, throw=True)
		department_approvers = get_department_approvers(department, "shift_request_approver")
		if not shift_request_approver:
			shift_request_approver = frappe.db.get_value(
				"Department Approver",
				{"parent": department, "parentfield": "shift_request_approver", "idx": 1},
				"approver",
			)

	shift_request_approver_name = frappe.db.get_value("User", shift_request_approver, "full_name", cache=True)

	if shift_request_approver and shift_request_approver not in [
		approver.name for approver in department_approvers
	]:
		department_approvers.insert(
			0, {"name": shift_request_approver, "full_name": shift_request_approver_name}
		)

	return department_approvers


@frappe.whitelist()
def get_shifts() -> list[dict[str, str]]:
	employee = get_current_employee()
	ShiftAssignment = frappe.qb.DocType("Shift Assignment")
	ShiftType = frappe.qb.DocType("Shift Type")
	return (
		frappe.qb.from_(ShiftAssignment)
		.join(ShiftType)
		.on(ShiftAssignment.shift_type == ShiftType.name)
		.select(
			ShiftAssignment.name,
			ShiftAssignment.shift_type,
			ShiftAssignment.start_date,
			ShiftAssignment.end_date,
			ShiftType.start_time,
			ShiftType.end_time,
		)
		.where(
			(ShiftAssignment.employee == employee)
			& (ShiftAssignment.status == "Active")
			& (ShiftAssignment.docstatus == 1)
		)
		.orderby(ShiftAssignment.start_date, order=Order.asc)
	).run(as_dict=True)


# Leaves and Holidays
@frappe.whitelist()
def get_leave_applications(
	employee: str,
	approver_id: str | None = None,
	for_approval: bool = False,
	limit: int | None = None,
	from_date: str | None = None,
	to_date: str | None = None,
) -> list[dict]:
	filters = get_filters("Leave Application", employee, approver_id, for_approval)
	if from_date and to_date:
		# overlap: application spans any part of [from_date, to_date]
		filters["from_date"] = ("<=", to_date)
		filters["to_date"] = (">=", from_date)

	fields = [
		"name",
		"posting_date",
		"employee",
		"employee_name",
		"leave_type",
		"status",
		"from_date",
		"to_date",
		"half_day",
		"half_day_date",
		"description",
		"total_leave_days",
		"leave_balance",
		"leave_approver",
		"posting_date",
		"creation",
	]

	if workflow_state_field := get_workflow_state_field("Leave Application"):
		fields.append(workflow_state_field)

	applications = frappe.get_list(
		"Leave Application",
		fields=fields,
		filters=filters,
		order_by="posting_date desc",
		limit=limit,
	)

	if workflow_state_field:
		for application in applications:
			application["workflow_state_field"] = workflow_state_field

	return applications


@frappe.whitelist()
def get_leave_balance_map(employee: str | None = None) -> dict[str, dict[str, float]]:
	"""
	Returns a map of leave type and balance details like:
	{
	        'Casual Leave': {'allocated_leaves': 10.0, 'balance_leaves': 5.0},
	        'Earned Leave': {'allocated_leaves': 3.0, 'balance_leaves': 3.0},
	}

	Defaults to the logged-in employee; pass `employee` to look up someone else's
	balance instead (permission-gated the same way as get_employee_login_summary,
	since this is independently whitelisted and callable on its own).
	"""
	from hrms.hr.doctype.leave_application.leave_application import get_leave_details

	if employee:
		frappe.has_permission("Employee", "read", employee, throw=True)
	else:
		employee = get_current_employee()

	date = getdate()
	leave_map = {}

	leave_details = get_leave_details(employee, date)
	allocation = leave_details["leave_allocation"]

	for leave_type, details in allocation.items():
		leave_map[leave_type] = {
			"allocated_leaves": details.get("total_leaves"),
			"balance_leaves": details.get("remaining_leaves"),
		}

	return leave_map


@frappe.whitelist()
def get_holidays_for_employee(employee: str) -> list[dict]:
	holiday_list = get_holiday_list_for_employee(employee, raise_exception=False)
	if not holiday_list:
		return []

	frappe.has_permission("Holiday List", "read", holiday_list, throw=True)

	Holiday = frappe.qb.DocType("Holiday")
	holidays = (
		frappe.qb.from_(Holiday)
		.select(Holiday.name, Holiday.holiday_date, Holiday.description)
		.where((Holiday.parent == holiday_list) & (Holiday.weekly_off == 0))
		.orderby(Holiday.holiday_date, order=Order.asc)
	).run(as_dict=True)

	for holiday in holidays:
		holiday["description"] = strip_html(holiday["description"] or "").strip()

	return holidays


@frappe.whitelist()
def get_leave_approval_details(employee: str) -> dict:
	frappe.has_permission("Employee", "read", employee, throw=True)
	leave_approver, department = frappe.get_cached_value(
		"Employee",
		employee,
		["leave_approver", "department"],
	)

	if not leave_approver and department:
		frappe.has_permission("Department", "read", department, throw=True)
		leave_approver = frappe.db.get_value(
			"Department Approver",
			{"parent": department, "parentfield": "leave_approvers", "idx": 1},
			"approver",
		)

	leave_approver_name = frappe.db.get_value("User", leave_approver, "full_name", cache=True)
	department_approvers = get_department_approvers(department, "leave_approvers")

	if leave_approver and leave_approver not in [approver.name for approver in department_approvers]:
		department_approvers.append({"name": leave_approver, "full_name": leave_approver_name})

	return dict(
		leave_approver=leave_approver,
		leave_approver_name=leave_approver_name,
		department_approvers=department_approvers,
		is_mandatory=frappe.db.get_single_value(
			"HR Settings", "leave_approver_mandatory_in_leave_application"
		),
	)


def get_department_approvers(department: str, parentfield: str) -> list[str]:
	if not department:
		return []

	department_details = frappe.db.get_value("Department", department, ["lft", "rgt"], as_dict=True)
	departments = frappe.get_all(
		"Department",
		filters={
			"lft": ("<=", department_details.lft),
			"rgt": (">=", department_details.rgt),
			"disabled": 0,
		},
		pluck="name",
	)

	Approver = frappe.qb.DocType("Department Approver")
	User = frappe.qb.DocType("User")
	department_approvers = (
		frappe.qb.from_(User)
		.join(Approver)
		.on(Approver.approver == User.name)
		.select(User.name.as_("name"), User.full_name.as_("full_name"))
		.where((Approver.parent.isin(departments)) & (Approver.parentfield == parentfield))
	).run(as_dict=True)

	return department_approvers


@frappe.whitelist()
def get_leave_types(employee: str, date: str) -> list:
	from hrms.hr.doctype.leave_application.leave_application import get_leave_details

	date = date or getdate()

	# Get leave details validate leave access internally
	leave_details = get_leave_details(employee, date)
	leave_types = list(leave_details["leave_allocation"].keys()) + leave_details["lwps"]

	return leave_types


# Expense Claims
@frappe.whitelist()
def get_expense_claims(
	employee: str,
	approver_id: str | None = None,
	for_approval: bool = False,
	limit: int | None = None,
) -> list[dict]:
	filters = get_filters("Expense Claim", employee, approver_id, for_approval)
	fields = [
		"`tabExpense Claim`.name",
		"`tabExpense Claim`.posting_date",
		"`tabExpense Claim`.employee",
		"`tabExpense Claim`.employee_name",
		"`tabExpense Claim`.currency",
		"`tabExpense Claim`.approval_status",
		"`tabExpense Claim`.status",
		"`tabExpense Claim`.expense_approver",
		"`tabExpense Claim`.total_claimed_amount",
		"`tabExpense Claim`.posting_date",
		"`tabExpense Claim`.company",
		"`tabExpense Claim`.creation",
		"`tabExpense Claim Detail`.expense_type",
		{"COUNT": "`tabExpense Claim Detail`.expense_type", "as": "total_expenses"},
	]

	if workflow_state_field := get_workflow_state_field("Expense Claim"):
		fields.append(workflow_state_field)

	claims = frappe.get_list(
		"Expense Claim",
		fields=fields,
		filters=filters,
		order_by="`tabExpense Claim`.posting_date desc",
		group_by="`tabExpense Claim`.name",
		limit=limit,
	)

	if workflow_state_field:
		for claim in claims:
			claim["workflow_state_field"] = workflow_state_field

	return claims


@frappe.whitelist()
def get_expense_claim_summary() -> dict:
	employee = get_current_employee()

	from frappe.query_builder.functions import Sum

	Claim = frappe.qb.DocType("Expense Claim")

	pending_claims_case = (
		frappe.qb.terms.Case().when(Claim.approval_status == "Draft", Claim.total_claimed_amount).else_(0)
	)
	sum_pending_claims = Sum(pending_claims_case).as_("total_pending_amount")

	approved_claims_case = (
		frappe.qb.terms.Case()
		.when(Claim.approval_status == "Approved", Claim.total_sanctioned_amount)
		.else_(0)
	)
	sum_approved_claims = Sum(approved_claims_case).as_("total_approved_amount")

	approved_total_claimed_case = (
		frappe.qb.terms.Case().when(Claim.approval_status == "Approved", Claim.total_claimed_amount).else_(0)
	)
	sum_approved_total_claimed = Sum(approved_total_claimed_case).as_("total_claimed_in_approved")

	rejected_claims_case = (
		frappe.qb.terms.Case().when(Claim.approval_status == "Rejected", Claim.total_claimed_amount).else_(0)
	)
	sum_rejected_claims = Sum(rejected_claims_case).as_("total_rejected_amount")

	summary = (
		frappe.qb.from_(Claim)
		.select(
			sum_pending_claims,
			sum_approved_claims,
			sum_rejected_claims,
			sum_approved_total_claimed,
			Claim.company,
		)
		.where((Claim.docstatus != 2) & (Claim.employee == employee))
	).run(as_dict=True)[0]

	currency = frappe.db.get_value("Company", summary.company, "default_currency")
	summary["currency"] = currency

	return summary


@frappe.whitelist()
def get_expense_type_description(expense_type: str) -> str:
	return frappe.db.get_value("Expense Claim Type", expense_type, "description")


@frappe.whitelist()
def get_expense_claim_types() -> list[dict]:
	ClaimType = frappe.qb.DocType("Expense Claim Type")

	return (frappe.qb.from_(ClaimType).select(ClaimType.name, ClaimType.description)).run(as_dict=True)


@frappe.whitelist()
def get_expense_approval_details(employee: str) -> dict:
	frappe.has_permission("Employee", "read", employee, throw=True)
	expense_approver, department = frappe.get_cached_value(
		"Employee",
		employee,
		["expense_approver", "department"],
	)

	if not expense_approver and department:
		frappe.has_permission("Department", "read", department, throw=True)
		expense_approver = frappe.db.get_value(
			"Department Approver",
			{"parent": department, "parentfield": "expense_approvers", "idx": 1},
			"approver",
		)

	expense_approver_name = frappe.db.get_value("User", expense_approver, "full_name", cache=True)
	department_approvers = get_department_approvers(department, "expense_approvers")

	if expense_approver and expense_approver not in [approver.name for approver in department_approvers]:
		department_approvers.append({"name": expense_approver, "full_name": expense_approver_name})

	return dict(
		expense_approver=expense_approver,
		expense_approver_name=expense_approver_name,
		department_approvers=department_approvers,
		is_mandatory=frappe.db.get_single_value("HR Settings", "expense_approver_mandatory_in_expense_claim"),
	)


# Employee Advance
@frappe.whitelist()
def get_employee_advance_balance() -> list[dict]:
	employee = get_current_employee()
	Advance = frappe.qb.DocType("Employee Advance")

	advances = (
		frappe.qb.from_(Advance)
		.select(
			Advance.name,
			Advance.employee,
			Advance.status,
			Advance.purpose,
			Advance.paid_amount,
			(Advance.paid_amount - (Advance.claimed_amount + Advance.return_amount)).as_("balance_amount"),
			Advance.posting_date,
			Advance.currency,
		)
		.where(
			(Advance.docstatus == 1)
			& (Advance.paid_amount)
			& (Advance.employee == employee)
			# don't need claimed & returned advances, only partly or completely paid ones
			& (Advance.status.isin(["Paid", "Partially Paid", "Unpaid"]))
		)
		.orderby(Advance.posting_date, order=Order.desc)
	).run(as_dict=True)

	return advances


# Company
@frappe.whitelist()
def get_company_currencies() -> dict:
	Company = frappe.qb.DocType("Company")
	Currency = frappe.qb.DocType("Currency")

	query = (
		frappe.qb.from_(Company)
		.join(Currency)
		.on(Company.default_currency == Currency.name)
		.select(
			Company.name,
			Company.default_currency,
			Currency.name.as_("currency"),
			Currency.symbol.as_("symbol"),
		)
	)

	companies = query.run(as_dict=True)
	return {company.name: (company.default_currency, company.symbol) for company in companies}


@frappe.whitelist()
def get_currency_symbols() -> dict:
	Currency = frappe.qb.DocType("Currency")

	currencies = (frappe.qb.from_(Currency).select(Currency.name, Currency.symbol)).run(as_dict=True)

	return {currency.name: currency.symbol or currency.name for currency in currencies}


@frappe.whitelist()
def get_company_cost_center_and_expense_account(company: str) -> dict:
	frappe.has_permission("Company", "read", company, throw=True)
	return frappe.db.get_value(
		"Company", company, ["cost_center", "default_expense_claim_payable_account"], as_dict=True
	)


# Form View APIs
@frappe.whitelist()
def get_doctype_fields(doctype: str) -> list[dict]:
	fields = frappe.get_meta(doctype).fields
	return [
		field
		for field in fields
		if field.fieldtype in SUPPORTED_FIELD_TYPES and field.fieldname != "amended_from"
	]


@frappe.whitelist()
def get_doctype_states(doctype: str) -> dict:
	states = frappe.get_meta(doctype).states
	return {state.title: state.color.lower() for state in states}


# File
@frappe.whitelist()
def get_attachments(dt: str, dn: str):
	return frappe.get_list(
		"File",
		fields=["name", "file_name", "file_url", "is_private"],
		filters={"attached_to_name": str(dn), "attached_to_doctype": dt},
	)


@frappe.whitelist()
def upload_base64_file(
	content: str, filename: str, dt: str | None = None, dn: str | None = None, fieldname: str | None = None
):
	import base64
	import io
	from mimetypes import guess_type

	from PIL import Image, ImageOps

	from frappe.handler import ALLOWED_MIMETYPES

	decoded_content = base64.b64decode(content)
	content_type = guess_type(filename)[0]
	if content_type not in ALLOWED_MIMETYPES:
		frappe.throw(_("You can only upload JPG, PNG, PDF, TXT or Microsoft documents."))

	if content_type.startswith("image/jpeg"):
		# transpose the image according to the orientation tag, and remove the orientation data
		with Image.open(io.BytesIO(decoded_content)) as image:
			transpose_img = ImageOps.exif_transpose(image)
			# convert the image back to bytes
			file_content = io.BytesIO()
			transpose_img.save(file_content, format="JPEG")
			file_content = file_content.getvalue()
	else:
		file_content = decoded_content

	frappe.has_permission(dt, "write", dn, throw=True)

	return frappe.get_doc(
		{
			"doctype": "File",
			"attached_to_doctype": dt,
			"attached_to_name": dn,
			"attached_to_field": fieldname,
			"folder": "Home",
			"file_name": filename,
			"content": file_content,
			"is_private": 1,
		}
	).insert()


@frappe.whitelist()
def delete_attachment(filename: str):
	attached_to_doctype, attached_to_name = frappe.db.get_value(
		"File", filename, ["attached_to_doctype", "attached_to_name"]
	)
	if attached_to_doctype and attached_to_name:
		frappe.has_permission(attached_to_doctype, "write", attached_to_name, throw=True)
	frappe.delete_doc("File", filename)


@frappe.whitelist()
def _download_pdf(doctype: str, docname: str) -> str:
	import base64

	from frappe.utils.print_format import download_pdf

	default_print_format = frappe.get_meta(doctype).default_print_format or "Standard"

	try:
		download_pdf(doctype, docname, format=default_print_format)
	except Exception as e:
		frappe.throw(_("Failed to download PDF: {0}").format(str(e)))

	base64content = base64.b64encode(frappe.local.response.filecontent)
	content_type = frappe.local.response.type

	return f"data:{content_type};base64," + base64content.decode("utf-8")


# Workflow
@frappe.whitelist()
def get_workflow(doctype: str) -> dict:
	workflow = get_workflow_name(doctype)
	if not workflow:
		return frappe._dict()
	return frappe.get_doc("Workflow", workflow)


def get_workflow_state_field(doctype: str) -> str | None:
	workflow_name = get_workflow_name(doctype)
	if not workflow_name:
		return None

	override_status, workflow_state_field = frappe.db.get_value(
		"Workflow",
		workflow_name,
		["override_status", "workflow_state_field"],
	)
	# NOTE: checkbox labelled 'Don't Override Status' is named override_status hence the inverted logic
	if not override_status:
		return workflow_state_field
	return None


def get_allowed_states_for_workflow(workflow: dict, user_id: str) -> list[str]:
	user_roles = frappe.get_roles(user_id)
	return [transition.state for transition in workflow.transitions if transition.allowed in user_roles]


# Permissions
@frappe.whitelist()
def get_permitted_fields_for_write(doctype: str) -> list[str]:
	return get_permitted_fields(doctype, permission_type="write")
