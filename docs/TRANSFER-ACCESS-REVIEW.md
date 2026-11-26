# Branch / Department Transfer access review

The employee review loads every active access grant from SQL, including systems
outside the former transfer form (such as AD/email). All current systems and
roles start selected. The employee can deselect systems, change selected roles,
and add active catalogue systems with roles and business requirements. They must
confirm that the selection is needed after transfer and provide a destination
access justification. New systems/roles require a configured IT workflow step.

The server saves an authoritative current-access snapshot, the original employee
selection, kept/removed/new role-level differences, confirmation and timestamp.
Names, current grants and system/role membership are not trusted from the client.
The inventory fingerprint prevents submitting a review of stale current access.

At the IT workflow step, IT must save its access review before recommending.
IT can remove requested existing access and decline new systems/roles, but cannot
grant extra access that the employee never requested. IT remarks, actor, time,
accepted selection and declined/removed access are saved separately, preserving
the employee's original request. Request details and generated print/PDF records
include this information. New access cannot bypass IT review through a later
workflow change that removes the IT step.

Older transfers already at IT can also be reviewed. The recorded request items
and the services the previous flow automatically retained are reconstructed for
IT and explicitly labelled as legacy. The system does not invent an employee
confirmation or timestamp that was never recorded.

No access grants change during employee or IT review. At final processing,
only the reviewed differences are applied: deselected access is revoked, new
access is granted, and retained grant IDs/usernames are preserved. Credentials
are requested only for new access, not existing retained IDs. Branch/department
changes occur on completion. If the employee's live grants change after review,
completion stops rather than applying a stale access plan; IT must reconcile or
restart the transfer review with the current inventory.

All saves use request-version checks and normal request authorization, acting
reviewer authority, CSRF protection and request transactions. Employee, IT and
completion actions are audited; original details are retained in revisions.

Deploy the updated backend and frontend together, rebuild frontend/dist and
restart the Node API. No SQL migration or data reset is required. Configure
the transfer workflow to include IT when new systems/roles can be requested.
