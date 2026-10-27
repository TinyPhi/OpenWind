// Roles that may be an on-call contact: the roster picker (GET /admin/members) lists them and
// schedule writes accept them. "user" is an employee without admin rights, never a customer
// (docs/specs/oncall-routing.md R13a).
export const ONCALL_ROLES: readonly string[] = ["agent", "admin", "user"];
